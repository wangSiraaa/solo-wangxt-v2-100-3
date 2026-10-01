// 量纲分析引擎：解析 → 变量收集 → 节点校验 → 求值/量纲检查 → 结果换算
// 每条公式独立调用本模块，任何异常都收敛为结构化 Issue，不影响其他公式。

import {
  create, all,
  type MathNode, type MathJsInstance, type Unit,
  OperatorNode, ParenthesisNode, SymbolNode, ConstantNode,
} from "mathjs";
import { latexToSource, LatexConvertError } from "./latex";
import type { AnalysisResult, Issue, VariableDef } from "./types";
import { buildUnitContext, type UnitContext, type UnitRef } from "./courseUnits";

const math: MathJsInstance = create(all);
/** 无课程单位库时的默认上下文（仅内置单位） */
const DEFAULT_CTX: UnitContext = buildUnitContext({ schemaVersion: 1, units: [] });

/** mathjs v13 中各种节点的判别联合（基接口 MathNode 不带 isXxx 属性）。
 *  字段设为必填：实际节点经 asAny 窄化，访问前先看 isXxx 判别位。 */
type AnyNode = MathNode & {
  type: string;
  isSymbolNode: boolean;
  isOperatorNode: boolean;
  isConstantNode: boolean;
  isParenthesisNode: boolean;
  isFunctionNode: boolean;
  isAssignmentNode: boolean;
  isConditionalNode: boolean;
  isAccessorNode: boolean;
  isIndexNode: boolean;
  isObjectNode: boolean;
  isArrayNode: boolean;
  isBlockNode: boolean;
  isFunctionAssignmentNode: boolean;
  isRelationalNode: boolean;
  isRangeNode: boolean;
  name: string;
  op: string;
  fn: string | { name: string };
  args: AnyNode[];
  content: AnyNode;
  value: number | string | boolean | null;
  implicit: boolean;
};

const asAny = (n: MathNode): AnyNode => n as AnyNode;
void asAny;

/** 首版明确支持的二元运算 */
const SUPPORTED_BINARY = new Set(["+", "-", "*", "/", "^"]);
/** 首版明确支持的一元运算 */
const SUPPORTED_UNARY = new Set(["+", "-"]);
/** 可直接求值的内置常量（不当作用户变量收集） */
const BUILTIN_CONSTANTS = new Set(["pi", "e", "PI", "E"]);

/** 数值（无单位）或 mathjs 单位量 */
type Quantity = number | Unit;
/** 求值哨兵：子树因错误/未验证而无法给出可靠值 */
const SKIPPED: unique symbol = Symbol("skipped");
type EvalVal = Quantity | typeof SKIPPED;

// 节点路径标记（同时用于原树与替换树）
const ORIG_PATH: unique symbol = Symbol("origPath");
type PathNode = AnyNode & { [ORIG_PATH]?: number[] };

function isUnit(v: EvalVal): v is Unit {
  return v !== SKIPPED && math.isUnit(v);
}
void isUnit;

/** 单位是否是带偏移温标（摄氏度、华氏度等），其四则运算在物理上有歧义 */
function hasOffset(v: Quantity): boolean {
  if (typeof v === "number") return false;
  return v.units.some((factor) => factor.unit.offset !== 0);
}

/** 是否为零（数或以任何单位表示的零，如 0 m/s） */
function isZero(v: Quantity): boolean {
  return typeof v === "number" ? v === 0 : v.value === 0;
}

/** 量纲是否兼容：数与数、同量纲单位。角度（rad/deg/grad）同属角度量纲。 */
function dimensionsCompatible(a: Quantity, b: Quantity): boolean {
  if (typeof a === "number" && typeof b === "number") return true;
  if (typeof a === "number" || typeof b === "number") {
    // 纯数（无量纲）与任何带单位量都不兼容；角度也是带量纲的
    return false;
  }
  return a.equalBase(b);
}

const dimText = (v: Quantity, ctx: UnitContext): string =>
  typeof v === "number" ? "无量纲（纯数）" : `量纲 [${ctx.display(v.formatUnits())}]`;

/** 按数字下标路径递归遍历（ParenthesisNode 视为透明包装） */
function walk(
  node: AnyNode,
  path: number[],
  fn: (n: AnyNode, p: number[], parent: AnyNode | null) => void,
  parent: AnyNode | null = null,
): void {
  fn(node, path, parent);
  const kids = node.isParenthesisNode ? [node.content]
    : "args" in node && Array.isArray((node as { args?: unknown }).args) ? (node as { args: AnyNode[] }).args
    : [];
  kids.forEach((c, i) => walk(c, [...path, i], fn, node));
}

/** 找到指定数字路径对应的节点 */
function nodeAtPath(root: AnyNode, path: number[]): AnyNode {
  let cur: AnyNode = root;
  for (const i of path) {
    cur = cur.isParenthesisNode ? cur.content : (cur as { args: AnyNode[] }).args[i];
  }
  return cur;
}

interface Collectors {
  issues: Issue[];
  add(kind: Issue["kind"], path: number[], node: AnyNode, message: string): void;
}

function makeCollectors(): Collectors {
  const issues: Issue[] = [];
  const seen = new Set<string>();
  return {
    issues,
    add(kind, path, node, message) {
      const key = `${kind}|${path.join(".")}|${message}`;
      if (seen.has(key)) return;
      seen.add(key);
      issues.push({ kind, path, snippet: node.toTex(), message });
    },
  };
}

/** 收集用户变量（内置常量除外） */
function collectVariables(node: AnyNode): string[] {
  const out: Set<string> = new Set();
  walk(node, [], (n) => {
    if (n.isSymbolNode && !BUILTIN_CONSTANTS.has(n.name)) out.add(n.name);
  });
  return [...out];
}

/** 节点是否处于首版明确支持范围内；不支持的返回说明文字（含路径） */
function findUnsupported(node: AnyNode): { path: number[]; message: string }[] {
  const found: { path: number[]; message: string }[] = [];
  walk(node, [], (n) => {
    if (n.isOperatorNode) {
      if (n.args.length === 1) {
        if (!SUPPORTED_UNARY.has(n.op)) {
          found.push({ path: (n as PathNode)[ORIG_PATH]!, message: `一元运算“${n.op}”超出首版支持范围（仅支持一元正负号），结果未验证` });
        }
      } else if (!SUPPORTED_BINARY.has(n.op)) {
        const name = ({ "%": "取模 %", mod: "取模", factorial: "阶乘", "|": "按位或", "&": "按位与" } as Record<string, string>)[n.op] ?? `运算“${n.op}”`;
        found.push({ path: (n as PathNode)[ORIG_PATH]!, message: `${name}超出首版支持范围（仅支持 +、-、×、÷ 和幂），结果未验证` });
      }
    } else if (n.isFunctionNode) {
      const fnName = typeof n.fn === "string" ? n.fn : n.fn.name;
      found.push({ path: (n as PathNode)[ORIG_PATH]!, message: `函数 ${fnName}(…) 超出首版支持范围（仅支持四则运算和幂），结果未验证` });
    } else if (n.isAssignmentNode) {
      found.push({ path: (n as PathNode)[ORIG_PATH]!, message: "不支持在公式中使用赋值号 =，请只写右侧表达式" });
    } else if (n.isConditionalNode) {
      found.push({ path: (n as PathNode)[ORIG_PATH]!, message: "条件表达式（? :）超出首版支持范围，结果未验证" });
    } else if (n.isAccessorNode || n.isIndexNode || n.isObjectNode || n.isArrayNode || n.isBlockNode || n.isFunctionAssignmentNode || n.isRelationalNode || n.isRangeNode) {
      found.push({ path: (n as PathNode)[ORIG_PATH]!, message: "该结构（矩阵/数组/对象/关系/区间等）超出首版支持范围，结果未验证" });
    }
  });
  return found;
}

/** 解析用户输入的变量值（数值文本 + 单位文本 + 可选版本绑定），失败时记录错误 */
function resolveVariable(
  name: string,
  def: VariableDef | undefined,
  node: AnyNode,
  path: number[],
  col: Collectors,
  ctx: UnitContext,
): EvalVal {
  if (!def || def.value.trim() === "") {
    col.add("error", path, node, `变量 ${name} 未赋值：请填写数值（系统不会自动取零）`);
    return SKIPPED;
  }
  const num = Number(def.value);
  if (!Number.isFinite(num)) {
    col.add("error", path, node, `变量 ${name} 的数值“${def.value}”不是有限数字`);
    return SKIPPED;
  }
  const unitText = def.unit.trim();
  if (!unitText && !def.unitRef) return num;
  try {
    return ctx.parseQuantity(num, unitText, def.unitRef);
  } catch {
    const which = def.unitRef
      ? `课程单位“${def.unitRef.name ?? unitText}”（版本 ${def.unitRef.version}）`
      : `单位“${unitText}”`;
    col.add("error", path, node, `变量 ${name} 的${which}无法识别（可能已被删除或写法不支持）`);
    return SKIPPED;
  }
}

/** 自底向上求值，所有量纲错误定位到具体运算节点 */
function evalNode(
  node: AnyNode,
  path: number[],
  scope: Map<string, Quantity>,
  failedNames: Set<string>,
  col: Collectors,
  ctx: UnitContext,
): EvalVal {
  if (node.isParenthesisNode) {
    return evalNode(node.content, path, scope, failedNames, col, ctx);
  }

  if (node.isConstantNode) {
    const v = node.value;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) {
        col.add("error", path, node, `字面量 ${node.toString()} 不是有限数值`);
        return SKIPPED;
      }
      return v;
    }
    col.add("warning", path, node, "该常量超出首版支持范围，结果未验证");
    return SKIPPED;
  }

  if (node.isSymbolNode) {
    if (scope.has(node.name)) return scope.get(node.name)!;
    if (node.name === "pi") return Math.PI;
    if (node.name === "e") return Math.E;
    // 未定义/单位非法等已在预解析阶段报告，此处不再重复
    if (failedNames.has(node.name)) return SKIPPED;
    return SKIPPED;
  }

  if (node.isOperatorNode) {
    const childPath = (i: number) => [...path, i];

    if (node.args.length === 1) {
      const operand = evalNode(node.args[0], childPath(0), scope, failedNames, col, ctx);
      if (operand === SKIPPED) return SKIPPED;
      if (node.op === "-") {
        if (hasOffset(operand)) {
          col.add("warning", path, node,
            "对带偏移温标（摄氏度/华氏度）取负号没有明确物理意义；如需负温差请先换算为 K，结果未验证");
          return SKIPPED;
        }
        return typeof operand === "number" ? -operand : math.multiply(operand, -1) as Unit;
      }
      return operand; // 一元 +
    }

    const l = evalNode(node.args[0], childPath(0), scope, failedNames, col, ctx);
    const r = evalNode(node.args[1], childPath(1), scope, failedNames, col, ctx);

    if (node.op === "+" || node.op === "-") {
      if (l === SKIPPED || r === SKIPPED) return SKIPPED;
      if (!dimensionsCompatible(l, r)) {
        col.add("error", path, node,
          `量纲不兼容，不能${node.op === "+" ? "相加" : "相减"}：左侧为${dimText(l, ctx)}，右侧为${dimText(r, ctx)}。可先做单位换算使其一致。`);
        return SKIPPED;
      }
      if (hasOffset(l) || hasOffset(r)) {
        col.add("warning", path, node,
          "运算数含有摄氏度/华氏度等带偏移温标：温度直接加减按“刻度读数”处理有歧义（温差应使用 K，温度相加无物理意义），结果未验证。需要单位换算请填写结果目标单位。");
        return SKIPPED;
      }
      const fn = node.op === "+" ? math.add : math.subtract;
      return safeArith(() => fn(l as number, r as number) as Quantity, path, node, col);
    }

    if (node.op === "*" || node.op === "/") {
      if (l === SKIPPED || r === SKIPPED) return SKIPPED;
      // 除零必须明确报错，绝不静默产生 Infinity
      if (node.op === "/" && isZero(r)) {
        col.add("error", path, node, "除数为零：除零无定义");
        return SKIPPED;
      }
      if (hasOffset(l) || hasOffset(r)) {
        col.add("warning", path, node,
          "乘除运算涉及摄氏度/华氏度等带偏移温标：偏移量会使结果产生歧义（如 25 °C × 2 不等于 50 K）。请先换算为 K 再参与乘除，结果未验证");
        return SKIPPED;
      }
      const fn = node.op === "*" ? math.multiply : math.divide;
      return safeArith(() => fn(l as number, r as number) as Quantity, path, node, col);
    }

    if (node.op === "^") {
      if (l === SKIPPED || r === SKIPPED) return SKIPPED;
      if (isUnit(r)) {
        col.add("warning", path, node, "指数带单位，首版只支持数值指数，结果未验证");
        return SKIPPED;
      }
      const exp = r as number;
      if (isZero(l) && exp <= 0) {
        col.add("error", path, node, `零的${exp === 0 ? "零次幂" : `${formatNumber(exp)} 次负幂`}无定义`);
        return SKIPPED;
      }
      if (hasOffset(l)) {
        col.add("warning", path, node, "对带偏移温标取幂没有物理意义，请先换算为 K，结果未验证");
        return SKIPPED;
      }
      return safeArith(() => math.pow(l as number, exp) as Quantity, path, node, col);
    }

    // findUnsupported 已先记录警告；走到这里的未知运算不再求值
    return SKIPPED;
  }

  // 其他节点类型（函数调用等）：findUnsupported 已记录
  return SKIPPED;
}

function safeArith(fn: () => Quantity, path: number[], node: AnyNode, col: Collectors): EvalVal {
  let result: Quantity;
  try {
    result = fn();
  } catch (e) {
    col.add("error", path, node, `运算失败：${(e as Error).message}`);
    return SKIPPED;
  }
  if (typeof result === "number" && !Number.isFinite(result)) {
    col.add("error", path, node, "运算结果不是有限数值（可能由除零引起）");    return SKIPPED;
  }
  return result;
}

export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  return math.format(n, { notation: "fixed", precision: 10 }).replace(/\.?0+$/, "");
}

/** 结果拆成数值 + 单位文本（课程单位内部名还原为显示名） */
function splitQuantity(q: Quantity, ctx: UnitContext): { value: number; unit: string } {
  if (typeof q === "number") return { value: q, unit: "" };
  const text = ctx.display(q.toString());
  const m = /^([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*(.*)$/.exec(text);
  if (!m) return { value: q.value, unit: ctx.display(q.formatUnits()) };
  return { value: Number(m[1]), unit: m[2].replace(/\s+/g, " ").trim() };
}

// ---------- 变量替换后的 AST（结构与原树一一对应，路径同步） ----------

/** 单个单位因子（可能带幂）的展示节点；课程单位内部名在这里还原为显示名 */
function unitFactorNode(name: string, power: number, path: number[]): AnyNode {
  const sym = asAny(new SymbolNode(name) as unknown as MathNode);
  (sym as PathNode)[ORIG_PATH] = path;
  if (power === 1) return sym;
  const node = asAny(new OperatorNode("^", "pow", [sym, new ConstantNode(power)]) as unknown as MathNode);
  (node as PathNode)[ORIG_PATH] = path;
  return node;
}

/** 由 mathjs Unit 的因子数组构造展示 AST：正幂在分子、负幂在分母，保持 “m / s” 习惯写法 */
function unitFactorsNode(q: Unit, path: number[], ctx: UnitContext): AnyNode {
  const numFactors = q.units.filter((f) => f.power > 0);
  const denFactors = q.units.filter((f) => f.power < 0);

  const build = (factors: Unit["units"]): AnyNode | null => {
    let node: AnyNode | null = null;
    for (const f of factors) {
      const unitDef = f.unit as unknown as { name: string; text?: string };
      const displayName = ctx.display(unitDef.text ?? unitDef.name);
      const factor = unitFactorNode(displayName, Math.abs(f.power), path);
      node = node === null
        ? factor
        : asAny(new OperatorNode("*", "multiply", [node, factor]) as unknown as MathNode);
      (node as PathNode)[ORIG_PATH] = path;
    }
    return node;
  };

  const num = build(numFactors);
  const den = build(denFactors);
  if (num && den) {
    const node = asAny(new OperatorNode("/", "divide", [num, den]) as unknown as MathNode);
    (node as PathNode)[ORIG_PATH] = path;
    return node;
  }
  const only = num ?? den;
  if (only) return only;
  // 无量纲单位（如 %）：因子为空时退回字符串解析
  const fallback = asAny(math.parse(ctx.display(q.formatUnits()) || "1"));
  (fallback as PathNode)[ORIG_PATH] = path;
  return fallback;
}

function literalNode(v: Quantity, path: number[], ctx: UnitContext): AnyNode {
  if (typeof v === "number") {
    const n = asAny(math.parse(`(${formatNumber(v)})`));
    (n as PathNode)[ORIG_PATH] = path;
    return n;
  }
  const num = asAny(new ConstantNode(v.value) as unknown as MathNode);
  (num as PathNode)[ORIG_PATH] = path;
  if (v.units.length === 0) return num;
  const node = asAny(new OperatorNode("*", "multiply", [num, unitFactorsNode(v, path, ctx)]) as unknown as MathNode);
  (node as PathNode)[ORIG_PATH] = path;
  return node;
}

function substitute(
  node: AnyNode,
  scope: Map<string, Quantity>,
  path: number[],
  ctx: UnitContext,
): AnyNode {
  let out: AnyNode;

  if (node.isParenthesisNode) {
    out = asAny(new ParenthesisNode(substitute(node.content, scope, path, ctx)) as unknown as MathNode);
  } else if (node.isSymbolNode) {
    const v = scope.get(node.name) ?? (node.name === "pi" ? Math.PI : node.name === "e" ? Math.E : undefined);
    out = v !== undefined ? literalNode(v, path, ctx) : node;
  } else if (node.isConstantNode) {
    out = node;
  } else if (node.isOperatorNode) {
    const kids = node.args.map((c, i) => substitute(c, scope, [...path, i], ctx));
    out = asAny(new OperatorNode(node.op as never, node.fn as never, kids, node.implicit) as unknown as MathNode);
  } else if (node.isFunctionNode) {
    // 超出范围：参数仍替换以便看到代入值，但函数本身不计算
    const kids = node.args.map((c, i) => substitute(c, scope, [...path, i], ctx));
    out = asAny(new (node.constructor as { new(fn: unknown, args: AnyNode[]): AnyNode })(node.fn, kids) as unknown as MathNode);
  } else {
    out = node;
  }
  (out as PathNode)[ORIG_PATH] = path;
  return out;
}

/** 生成带颜色高亮的 TeX：error 红、warning 橙；同节点红色优先 */
function highlightTex(root: AnyNode, issues: Issue[]): string {
  const paths = new Map<string, Issue["kind"]>();
  for (const iss of issues) {
    const key = iss.path.join(".");
    const prev = paths.get(key);
    if (!prev || (iss.kind === "error" && prev === "warning")) paths.set(key, iss.kind);
  }
  const color = (kind: Issue["kind"]) => (kind === "error" ? "#d11f2d" : "#b26a00");

  // 给每个节点挂上它对应的原树路径（替换树）或自身路径（原树）
  walk(root, [], (n, p) => {
    if ((n as PathNode)[ORIG_PATH] === undefined) (n as PathNode)[ORIG_PATH] = p;
  });

  // 渲染哨兵：渲染高亮节点内部内容时跳过自定义 handler，避免自递归
  let rendering = false;
  const handler = (node: AnyNode, options: unknown): string | undefined => {
    if (rendering) return undefined;
    const p = (node as PathNode)[ORIG_PATH];
    if (p !== undefined) {
      const kind = paths.get(p.join("."));
      if (kind) {
        rendering = true;
        let inner: string;
        try {
          inner = node.toTex(options as never);
        } finally {
          rendering = false;
        }
        return `\\color{${color(kind)}}{${inner}}`;
      }
    }
    return undefined;
  };

  return root.toTex({ handler: handler as never });
}

// ---------- 入口 ----------

export interface AnalyzeOptions {
  /** 课程单位库解析上下文；缺省使用空库（仅内置单位） */
  units?: UnitContext;
  /** 结果目标单位的版本绑定 */
  targetRef?: UnitRef;
}

export function analyzeFormula(
  latex: string,
  varDefs: Record<string, VariableDef>,
  targetUnitText: string,
  options?: AnalyzeOptions,
): AnalysisResult {
  const ctx = options?.units ?? DEFAULT_CTX;
  const targetRef = options?.targetRef;
  if (!latex.trim()) {
    return { status: "empty", variables: [], issues: [] };
  }

  // 1) LaTeX → 中缀表达式
  let source: string;
  const convertNotices: string[] = [];
  try {
    const conv = latexToSource(latex);
    source = conv.source;
    convertNotices.push(...new Set(conv.notices));
  } catch (e) {
    if (e instanceof LatexConvertError) {
      return {
        status: "error",
        variables: [],
        issues: [{ kind: "error", path: [], snippet: latex, message: `公式输入无法转换：${e.message}` }],
      };
    }
    throw e;
  }

  // 2) 数学语法解析
  let tree: AnyNode;
  try {
    tree = asAny(math.parse(source));
  } catch (e) {
    const err = e as Error & { char?: number };
    return {
      status: "error",
      variables: [],
      source,
      issues: [{
        kind: "error",
        path: [],
        snippet: source,
        message: `数学表达式语法错误：${err.message}${typeof err.char === "number" ? `（位置 ${err.char}）` : ""}`,
      }],
    };
  }

  // 给每个节点标记自身路径
  walk(tree, [], (n, p) => { (n as PathNode)[ORIG_PATH] = p; });

  const col = makeCollectors();

  // 3) 支持范围检查（不支持 → 未验证）
  for (const u of findUnsupported(tree)) {
    col.add("warning", u.path, nodeAtPath(tree, u.path), u.message);
  }
  for (const notice of convertNotices) {
    col.issues.push({ kind: "warning", path: [], snippet: tree.toTex(), message: notice });
  }

  const variables = collectVariables(tree);

  // 4) 变量解析（同一变量多处引用：只在首次出现处报未定义）
  const scope = new Map<string, Quantity>();
  const failedNames = new Set<string>();
  walk(tree, [], (n, p) => {
    if (n.isSymbolNode && !BUILTIN_CONSTANTS.has(n.name) && !scope.has(n.name) && !failedNames.has(n.name)) {
      // 兼容 T1 与 T_1 两种变量命名
      const def = varDefs[n.name] ?? varDefs[n.name.replace(/_(\d+)$/, "$1")];
      const v = resolveVariable(n.name, def, n, p, col, ctx);
      if (v === SKIPPED) failedNames.add(n.name);
      else scope.set(n.name, v);
    }
  });

  // 5) 求值 + 量纲检查
  const raw = evalNode(tree, [], scope, failedNames, col, ctx);

  // 6) 替换树（展示计算式 + 高亮），结构与原树一一对应
  const subTree = substitute(tree, scope, [], ctx);
  const substituted = subTree.toString({ parenthesize: "all", implicit: "show" });

  // 7) 结果与目标单位换算
  let value: number | undefined;
  let resultUnit: string | undefined;
  let targetValue: number | undefined;
  let targetUnit: string | undefined;

  if (raw !== SKIPPED) {
    // mathjs 在格式化时默认把单位组合 simplify 成 SI 基本单位（cfs·s → m³）。
    // 结果若含课程单位因子，则关闭自动化简，保留“20 cfs s”的直观组合（SI 值不变，换算照常）；
    // 纯内置单位仍走默认化简（m/s·s → m）。
    if (typeof raw !== "number" && raw.units.some((f) => {
      const ud = f.unit as unknown as { name: string };
      return ctx.isInternalUnit(ud.name);
    })) {
      (raw as Unit & { skipAutomaticSimplification?: boolean }).skipAutomaticSimplification = true;
    }
    // 无量纲课程单位（如 percent = 0.01）：dimensions 全零时折算为纯数参与结果展示
    const isDimensionless = typeof raw === "number"
      || raw.dimensions.every((d) => d === 0);
    const effectiveRaw: Quantity = typeof raw === "number" ? raw
      : isDimensionless ? raw.value
      : raw;
    const s = splitQuantity(effectiveRaw, ctx);
    value = s.value;
    resultUnit = s.unit;
    const t = targetUnitText.trim();
    if (t || targetRef) {
      try {
        // 先经课程单位上下文解析目标单位（无法识别时抛错，落入下方未验证提示）
        const targetUnitObj = ctx.parseUnit(t, targetRef);
        let converted: Unit;
        if (typeof effectiveRaw === "number") {
          // 纯数结果只允许换算到角度量纲（弧度 ↔ 度）
          converted = math.unit(effectiveRaw, "rad").to(targetUnitObj as unknown as string) as Unit;
        } else {
          converted = effectiveRaw.to(targetUnitObj as unknown as string) as Unit;
        }
        const cs = splitQuantity(converted, ctx);
        targetValue = cs.value;
        targetUnit = cs.unit;
      } catch {
        col.add("warning", [], tree,
          `结果（${typeof effectiveRaw === "number" ? "无量纲纯数" : resultUnit}）无法换算到目标单位“${targetRef?.name ?? t}”：量纲不兼容或该单位无法识别，换算结果未验证`);
      }
    }
  }

  // 换算新增的 warning 需要反映到状态上
  const errors = col.issues.filter((i) => i.kind === "error");
  const warnings = col.issues.filter((i) => i.kind === "warning");
  const status: AnalysisResult["status"] =
    errors.length > 0 ? "error" : warnings.length > 0 ? "unverified" : "ok";

  let summary: string;
  if (status === "ok") {
    summary = targetValue !== undefined
      ? `= ${formatNumber(targetValue)} ${targetUnit ?? ""}`.trim()
      : `= ${formatNumber(value!)} ${resultUnit ?? ""}`.trim();
  } else if (status === "error") {
    summary = `存在 ${errors.length} 处错误${warnings.length ? `、${warnings.length} 处未验证项` : ""}`;
  } else {
    summary = `结果未验证（${warnings.length} 处超出支持范围或需人工确认）`;
  }

  return {
    status,
    variables,
    issues: col.issues,
    source,
    substituted,
    originalTex: highlightTex(tree, col.issues),
    substitutedTex: highlightTex(subTree, col.issues),
    value,
    resultUnit,
    targetValue,
    targetUnit,
    summary,
  };
}

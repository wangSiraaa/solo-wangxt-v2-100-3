// 课程单位库：可复用的自定义单位，带稳定标识与不可变版本。
//
// 关键不变量：
//  - 每个单位有稳定 uid（跨版本不变）；每次修订生成新的 UnitVersion（version+1），
//    旧版本永不被覆盖，公式通过 UnitRef {uid, version} 绑定它实际计算时所用的定义；
//  - 定义只能是“比例因子 × 复合量纲”（线性、零偏移），不允许 degC/degF 等带偏移
//    仿射温标出现在定义链中（温差/温标换算应使用 K）；
//  - 定义链禁止自引用、间接循环、引用未知单位；
//  - 任何校验失败都在写入前抛出，存储层按原子批次落库，不留残缺单位。

import {
  create, all,
  type MathJsInstance, type Unit as MathUnit,
} from "mathjs";

// ---------- 数据模型 ----------

/** 公式对单位定义版本的绑定（变量单位与结果目标单位都用它锁定定义） */
export interface UnitRef {
  /** 课程单位稳定标识 */
  uid: string;
  /** 绑定的具体版本（不可变定义） */
  version: number;
  /** 绑定写入时该版本的显示名，仅用于缺定义时展示，不参与解析 */
  name?: string;
  /** 显式迁移记录：从哪个定义版本迁移而来（可追溯） */
  migratedFrom?: { uid: string; version: number; name?: string; at: number };
}

/** 变量：数值文本 + 单位文本（自由输入，可含内置或自定义单位）+ 可选的版本绑定 */
export interface VariableDef {
  value: string;
  unit: string;
  /** 当 unit 解析为某个课程单位版本时，锁定其定义；缺省表示内置单位/纯数 */
  unitRef?: UnitRef;
}

/** 单位的一个不可变定义版本 */
export interface UnitVersion {
  version: number;
  /** 显示名（如 cfs），库内同一时刻不同 uid 不可重名 */
  name: string;
  /** 比例因子（正数）；实际单位 = factor × dimension */
  factor: number;
  /** 复合量纲表达式，如 "m^3/s"；空串表示无量纲（纯比例，如 %） */
  dimension: string;
  /** 中文说明/提示 */
  hint?: string;
  createdAt: number;
  /** 本版本定义直接引用到的其他课程单位 uid */
  deps: string[];
}

/** 课程单位（一个 uid 对应一条版本链） */
export interface CourseUnit {
  uid: string;
  /** 版本链，按 version 升序；永不删除/改写既有元素 */
  versions: UnitVersion[];
  /** 弃用标记（不影响旧公式解析，仅在 UI 提示） */
  deprecated?: boolean;
}

/** 课程单位库整体快照（IndexedDB / JSON 中持久化的形态） */
export interface UnitLibrary {
  /** 库结构版本，用于 IndexedDB/JSON 模式迁移 */
  schemaVersion: number;
  units: CourseUnit[];
}

export const UNIT_LIB_SCHEMA_VERSION = 1;
export const emptyLibrary = (): UnitLibrary => ({ schemaVersion: UNIT_LIB_SCHEMA_VERSION, units: [] });

/**
 * 规整来自 IndexedDB/JSON 的库数据：缺字段补齐、过滤残缺条目，保证引擎只面对完整结构。
 * 注意：本函数只做结构清洗；定义链（循环/未知单位）在 buildUnitContext 中再校验。
 */
export function normalizeImportLib(raw: unknown): UnitLibrary {
  if (!raw || typeof raw !== "object") return emptyLibrary();
  const obj = raw as Partial<UnitLibrary>;
  const units = Array.isArray(obj.units)
    ? obj.units
        .filter((u) => u && typeof u.uid === "string" && Array.isArray(u.versions))
        .map((u) => ({
          uid: u.uid,
          deprecated: u.deprecated,
          versions: u.versions
            .filter((v) => v && typeof v.version === "number")
            .map((v) => ({
              version: v.version,
              name: String(v.name ?? ""),
              factor: Number(v.factor),
              dimension: String(v.dimension ?? ""),
              hint: v.hint ? String(v.hint) : undefined,
              createdAt: typeof v.createdAt === "number" ? v.createdAt : Date.now(),
              deps: Array.isArray(v.deps) ? v.deps.filter((d) => typeof d === "string") : [],
            }))
            .sort((a, b) => a.version - b.version),
        }))
        .filter((u) => u.versions.length > 0)
    : [];
  return { schemaVersion: UNIT_LIB_SCHEMA_VERSION, units: units as CourseUnit[] };
}

// ---------- 校验错误 ----------

export class UnitDefError extends Error {
  constructor(
    message: string,
    /** 失败原因码，便于 UI 分类展示 */
    readonly code:
      | "invalid-name" | "invalid-factor" | "invalid-dimension"
      | "self-reference" | "cycle" | "unknown-unit" | "affine-scale"
      | "duplicate-name" | "not-found" | "conflict",
  ) {
    super(message);
    this.name = "UnitDefError";
  }
}

// ---------- 纯数据操作 ----------

/** 自定义单位名：简单标识符（字母开头，字母数字下划线）。
 *  不允许 / ^ * - 空格 等复合量纲运算符，避免名称本身破坏表达式解析。 */
const NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

/** 纯净 mathjs 实例（不含任何课程单位），用于判断名称是否撞上内置单位 */
const pristineMath: MathJsInstance = create(all);

/** 名称是否已被 mathjs 内置单位/前缀占用（自定义单位不得覆盖它们） */
function isReservedName(name: string): boolean {
  try {
    pristineMath.unit(name);
    return true;
  } catch {
    return false;
  }
}

/** 名称在单位表达式中的词法边界（单位名含下划线） */
const nameBoundary = (escaped: string) =>
  new RegExp(`(^|[^A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`);

export function latestVersion(u: CourseUnit): UnitVersion {
  return u.versions[u.versions.length - 1];
}

export function findVersion(lib: UnitLibrary, uid: string, version?: number): UnitVersion | undefined {
  const u = lib.units.find((x) => x.uid === uid);
  if (!u) return undefined;
  return version === undefined ? latestVersion(u) : u.versions.find((v) => v.version === version);
}

export function findByName(lib: UnitLibrary, name: string): CourseUnit | undefined {
  return lib.units.find((u) => latestVersion(u).name === name);
}

/** 库内全部 (uid, 版本)，供依赖图/拓扑使用 */
interface VersionNode { uid: string; v: UnitVersion }
function allVersions(lib: UnitLibrary): Map<string, VersionNode> {
  const map = new Map<string, VersionNode>();
  for (const u of lib.units) for (const v of u.versions) map.set(`${u.uid}@${v.version}`, { uid: u.uid, v });
  return map;
}

/** 从量纲表达式中抽出引用的课程单位显示名（按最长名优先，避免前缀误伤） */
function referencedNames(lib: UnitLibrary, expr: string): { name: string; uid: string }[] {
  const names = lib.units.map((u) => latestVersion(u).name)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const out: { name: string; uid: string }[] = [];
  let rest = expr;
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (nameBoundary(escaped).test(rest)) {
      out.push({ name, uid: findByName(lib, name)!.uid });
      rest = rest.split(name).join(" ");
    }
  }
  return out;
}

export interface DraftDef {
  name: string;
  factor: number;
  dimension: string;
  hint?: string;
}

export interface ValidatedDef extends DraftDef { deps: string[] }

/**
 * 校验一份“待保存的新版本定义”。
 * @param draft    名称/比例/量纲/说明
 * @param lib      现有库（不含待保存版本）
 * @param selfUid  修订时传入自身 uid（允许保留自己的名字，但定义不得引用自己）
 */
export function validateDef(draft: DraftDef, lib: UnitLibrary, selfUid?: string): ValidatedDef {
  const name = draft.name.trim();
  if (!NAME_RE.test(name)) {
    throw new UnitDefError(
      `单位名“${draft.name}”不合法：须以字母开头，只含字母、数字、下划线（如 cfs、ft3_s）` +
      `；复合量纲请写在量纲栏，不要放进名称`,
      "invalid-name",
    );
  }
  if (isReservedName(name)) {
    throw new UnitDefError(
      `单位名“${name}”与内置单位重名：自定义单位不得覆盖标准单位（请换名，如 ${name}_course）`,
      "duplicate-name",
    );
  }
  const owner = findByName(lib, name);
  if (owner && owner.uid !== selfUid) {
    throw new UnitDefError(
      `单位名“${name}”已被其他单位使用：请换名，或对原单位做修订生成新版本`,
      "duplicate-name",
    );
  }
  const factor = Number(draft.factor);
  if (!Number.isFinite(factor) || factor <= 0) {
    throw new UnitDefError(`比例因子必须是正数（收到“${draft.factor}”）`, "invalid-factor");
  }
  const dimension = draft.dimension.trim();

  const deps = referencedNames(lib, dimension).map((r) => r.uid);
  if (selfUid && deps.includes(selfUid)) {
    throw new UnitDefError(`单位“${name}”的定义链不能引用自身（自引用）`, "self-reference");
  }

  // 间接循环：假设新定义落地后沿依赖图 DFS（依赖按各单位最新版本解析）
  if (selfUid) {
    const cyclePath = detectCycle(lib, selfUid, deps);
    if (cyclePath) {
      throw new UnitDefError(
        `定义链存在循环依赖：${cyclePath.join(" → ")} → ${name}；不允许 A 依赖 B、B 又依赖 A`,
        "cycle",
      );
    }
  }

  // 用临时 mathjs 实例检查“未知单位 / 仿射温标 / 量纲不可约”。
  // probe 只按内部名注册，所以先把表达式里的课程单位显示名改写为对应内部名（最新版）。
  const probe = createProbe(lib);
  const rewritten = dimension === ""
    ? `${factor}`
    : `${factor} (${rewriteDisplayToLatestInternal(lib, dimension)})`;
  let parsed: MathUnit;
  try {
    parsed = probe.unit(rewritten);
  } catch (e) {
    throw new UnitDefError(
      `量纲表达式“${dimension}”无法识别：${(e as Error).message.split("\n")[0]}`,
      "unknown-unit",
    );
  }
  if (parsed.units.some((f) => f.unit.offset !== 0)) {
    throw new UnitDefError(
      `量纲表达式中含摄氏度/华氏度等带偏移的仿射温标：课程单位只允许比例（线性）定义；` +
      `温度量纲请改用 K（温差与温标换算在结果换算中处理）`,
      "affine-scale",
    );
  }

  return { name, factor, dimension, hint: draft.hint?.trim() || undefined, deps: [...new Set(deps)] };
}

/**
 * 检查“给 selfUid 新增一个依赖 deps 的版本”后是否成环。
 * 依赖按各单位最新版本解析（新版本只能引用依赖的当前最新定义）。
 * 返回环上的显示名路径；无环返回 null。
 */
function detectCycle(lib: UnitLibrary, selfUid: string, deps: string[]): string[] | null {
  const nameOf = (uid: string) => {
    const u = lib.units.find((x) => x.uid === uid);
    return u ? latestVersion(u).name : uid;
  };
  const dfs = (uid: string, stack: string[]): string[] | null => {
    if (uid === selfUid) return stack;
    if (stack.includes(uid)) return null; // 防御：既有数据不应有环
    const u = lib.units.find((x) => x.uid === uid);
    if (!u) return null;
    for (const d of latestVersion(u).deps) {
      const hit = dfs(d, [...stack, nameOf(uid)]);
      if (hit) return hit;
    }
    return null;
  };
  for (const d of deps) {
    const hit = dfs(d, [nameOf(selfUid)]);
    if (hit) return hit;
  }
  return null;
}

/** 新建单位（校验通过后才返回新库；失败时原库不动） */
export function createUnit(
  lib: UnitLibrary, draft: DraftDef, now = Date.now(), uid = newUnitUid(),
): UnitLibrary {
  const v = validateDef(draft, lib);
  const unit: CourseUnit = { uid, versions: [{ version: 1, createdAt: now, ...v }] };
  return { ...lib, units: [...lib.units, unit] };
}

/** 修订已有单位：生成新版本，旧版本原样保留 */
export function reviseUnit(lib: UnitLibrary, uid: string, draft: DraftDef, now = Date.now()): UnitLibrary {
  const u = lib.units.find((x) => x.uid === uid);
  if (!u) throw new UnitDefError(`单位 ${uid} 不存在，无法修订`, "not-found");
  const v = validateDef(draft, lib, uid);
  const next: UnitVersion = { version: latestVersion(u).version + 1, createdAt: now, ...v };
  return {
    ...lib,
    units: lib.units.map((x) => (x.uid === uid ? { ...x, versions: [...x.versions, next] } : x)),
  };
}

export function newUnitUid(): string {
  return `u_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// ---------- 版本化解析上下文 ----------

/** mathjs 内部单位名只允许字母数字：把 uid/version 编成安全 token */
function internalName(uid: string, version: number): string {
  const hex = uid.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  return `cu${hex}v${version}`;
}

interface Registered {
  ref: UnitRef;
  internal: string;
  name: string;
}

export interface UnitContext {
  /** 解析“数值 + 单位文本 + 可选版本绑定”，失败抛 Error */
  parseQuantity(num: number, unitText: string, ref?: UnitRef): MathUnit;
  /** 仅解析单位文本（结果目标单位用） */
  parseUnit(unitText: string, ref?: UnitRef): MathUnit;
  /** 按绑定取单位对象（缺定义返回 undefined） */
  unitForRef(ref: UnitRef): MathUnit | undefined;
  /** 判断 mathjs 因子单位名是否为课程单位内部名 */
  isInternalUnit(name: string): boolean;
  /** 把 mathjs 输出中的内部名替换回显示名 */
  display(text: string): string;
  /** 该上下文对应的库快照 */
  readonly library: UnitLibrary;
  /** 全部已注册单位（内部名长度降序，供 UI/测试使用） */
  listRegistered(): Registered[];
}

/** 依赖版本解析：某版本创建时“可见”的依赖最新版（createdAt 不晚于它） */
function depVersionAt(lib: UnitLibrary, depUid: string, at: number): { uid: string; v: UnitVersion } {
  const depUnit = lib.units.find((x) => x.uid === depUid);
  if (!depUnit) throw new UnitDefError(`定义引用了未知单位 ${depUid}`, "unknown-unit");
  const candidate =
    depUnit.versions.filter((dv) => dv.createdAt <= at).pop() ?? depUnit.versions[0];
  return { uid: depUid, v: candidate };
}

/**
 * 把库快照编译进一个全新的 mathjs 实例（拓扑序注册，内部名唯一）。
 * 同名单位的新旧版本因此可以共存：旧公式经内部名永远解析旧定义。
 */
function compileLibrary(lib: UnitLibrary): {
  math: MathJsInstance;
  registered: Map<string, Registered>;
  byRef: Map<string, MathUnit>;
} {
  const math: MathJsInstance = create(all);
  const registered = new Map<string, Registered>();
  const byRef = new Map<string, MathUnit>();

  const nodes = allVersions(lib);
  const order: { uid: string; v: UnitVersion; internal: string }[] = [];
  const state = new Map<string, 0 | 1 | 2>();
  const visit = (key: string, stack: string[]): void => {
    const s = state.get(key);
    if (s === 2) return;
    if (s === 1) throw new UnitDefError(`定义链循环：${stack.concat(key).join(" → ")}`, "cycle");
    state.set(key, 1);
    const node = nodes.get(key)!;
    for (const depUid of node.v.deps) {
      const dep = depVersionAt(lib, depUid, node.v.createdAt);
      visit(`${dep.uid}@${dep.v.version}`, [...stack, key]);
    }
    state.set(key, 2);
    order.push({ uid: node.uid, v: node.v, internal: internalName(node.uid, node.v.version) });
  };
  for (const key of nodes.keys()) visit(key, []);

  for (const { uid, v, internal } of order) {
    const def = v.dimension === ""
      ? `${v.factor}`
      : `${v.factor} (${rewriteToInternal(lib, v.dimension, v.createdAt, (depUid) => {
          const dep = depVersionAt(lib, depUid, v.createdAt);
          return internalName(dep.uid, dep.v.version);
        })})`;
    math.createUnit({ [internal]: { definition: def } });
    registered.set(internal, { ref: { uid, version: v.version, name: v.name }, internal, name: v.name });
    byRef.set(`${uid}@${v.version}`, math.unit(internal));
  }

  return { math, registered, byRef };
}

export function buildUnitContext(lib: UnitLibrary): UnitContext {
  const { math, registered, byRef } = compileLibrary(lib);

  /**
   * 用户文本中的课程单位显示名 → 内部名。
   * 关键：存在版本绑定时，若文本就是该版本显示名（或为空），直接解析到绑定版本——
   * 否则自由文本会落到“最新版本”，把旧公式悄悄重解释；复合表达式才走文本改写。
   */
  const rewriteUserText = (text: string, ref?: UnitRef): string => {
    const trimmed = text.trim();
    if (ref) {
      const boundInternal = internalName(ref.uid, ref.version);
      if (registered.has(boundInternal)) {
        // 文本为空或仍是该版本显示名 → 严格解析到绑定版本
        if (!trimmed || trimmed === ref.name) return boundInternal;
        // 文本改成了其他内容（复合表达式或内置单位）：按自由文本解析
        return out0(text);
      }
      // 绑定版本在库中缺失：绝不回退到同名最新版本，直接失败
      throw new Error(
        `课程单位“${ref.name ?? ref.uid}”的绑定版本 v${ref.version} 在单位库中不存在`,
      );
    }
    return out0(text);
  };

  /** 自由文本：显示名 → 最新版本内部名 */
  function out0(text: string): string {
    let out = text;
    const latestByName = new Map<string, string>();
    for (const u of lib.units) {
      const lv = latestVersion(u);
      latestByName.set(lv.name, internalName(u.uid, lv.version));
    }
    for (const [name, internal] of [...latestByName.entries()].sort((a, b) => b[0].length - a[0].length)) {
      const re = new RegExp(`(^|[^A-Za-z0-9_])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_])`, "g");
      out = out.replace(re, (_m: string, pre: string) => `${pre}${internal}`);
    }
    return out;
  }

  const sortedInfos = [...registered.values()].sort((a, b) => b.internal.length - a.internal.length);
  const display = (text: string): string => {
    let out = text;
    for (const info of sortedInfos) out = out.split(info.internal).join(info.name);
    return out;
  };

  const internals = new Set(registered.keys());

  return {
    library: lib,
    listRegistered: () => sortedInfos,
    isInternalUnit: (name) => internals.has(name),
    parseQuantity(num, unitText, ref) {
      const t = unitText.trim();
      if (!t && !ref) throw new Error("单位为空");
      const expr = t
        ? `${num} (${rewriteUserText(t, ref)})`
        : `${num} (${internalName(ref!.uid, ref!.version)})`;
      return math.unit(expr);
    },
    parseUnit(unitText, ref) {
      const t = unitText.trim();
      if (!t && ref) return math.unit(internalName(ref.uid, ref.version));
      return math.unit(rewriteUserText(t, ref));
    },
    unitForRef(ref) {
      return byRef.get(`${ref.uid}@${ref.version}`);
    },
    display,
  };
}

/** 注册阶段：把量纲表达式中的依赖显示名替换成对应内部名（最长名优先） */
function rewriteToInternal(
  lib: UnitLibrary,
  expr: string,
  at: number,
  internalOf: (uid: string) => string,
): string {
  let out = expr;
  const refs = referencedNames(lib, expr).sort((a, b) => b.name.length - a.name.length);
  void at;
  for (const r of refs) out = out.split(r.name).join(internalOf(r.uid));
  return out;
}

/** 校验阶段：表达式中的课程单位显示名 → 其最新版本内部名（probe 每个 uid 只注册最新版） */
function rewriteDisplayToLatestInternal(lib: UnitLibrary, expr: string): string {
  return rewriteToInternal(lib, expr, Number.POSITIVE_INFINITY, (uid) => {
    const u = lib.units.find((x) => x.uid === uid)!;
    return internalName(uid, latestVersion(u).version);
  });
}

/** 校验阶段使用的 mathjs 实例：每个 uid 只注册其最新版本 */
function createProbe(lib: UnitLibrary): MathJsInstance {
  const probe: UnitLibrary = emptyLibrary();
  for (const u of lib.units) probe.units.push({ uid: u.uid, versions: [latestVersion(u)] });
  return compileLibrary(probe).math;
}

// ---------- 量纲签名（冲突判定） ----------

/** 求绑定版本的 9 维基本量纲签名；两个同名单位签名不同 = 量纲冲突 */
export function dimensionSignature(ctx: UnitContext, ref: UnitRef): number[] | undefined {
  const u = ctx.unitForRef(ref);
  return u ? [...u.dimensions] : undefined;
}

// ---------- 使用情况与迁移 ----------

export interface UnitUsage {
  formulaId: string;
  formulaNote: string;
  where: "variable" | "target";
  varName?: string;
  ref: UnitRef;
}

export interface FormulaLike {
  id: string;
  note: string;
  variables: Record<string, VariableDef>;
  targetUnit: string;
  targetUnitRef?: UnitRef;
}

export function usagesOf(formulas: FormulaLike[], uid: string, outdatedOnly = false, lib?: UnitLibrary): UnitUsage[] {
  const out: UnitUsage[] = [];
  const latest = lib ? lib.units.find((u) => u.uid === uid)?.versions.length : undefined;
  const hit = (r?: UnitRef) => {
    if (!r || r.uid !== uid) return false;
    if (outdatedOnly && latest !== undefined && r.version >= latest) return false;
    return true;
  };
  for (const f of formulas) {
    for (const [name, v] of Object.entries(f.variables)) {
      if (hit(v.unitRef)) out.push({ formulaId: f.id, formulaNote: f.note, where: "variable", varName: name, ref: v.unitRef! });
    }
    if (hit(f.targetUnitRef)) out.push({ formulaId: f.id, formulaNote: f.note, where: "target", ref: f.targetUnitRef! });
  }
  return out;
}

/**
 * 显式迁移：把公式中所有 fromUid 的绑定改为 toUid 的指定版本（默认最新）。
 * 迁移点带 migratedFrom 记录，可追溯；未被迁移的公式一律保留原绑定。
 */
export function migrateFormulas<T extends FormulaLike>(
  formulas: T[],
  fromUid: string,
  toUid: string,
  lib: UnitLibrary,
  toVersion?: number,
  now = Date.now(),
): T[] {
  const target = lib.units.find((u) => u.uid === toUid);
  if (!target) throw new UnitDefError(`迁移目标单位 ${toUid} 不存在`, "not-found");
  const tv = toVersion ?? latestVersion(target).version;
  const tVer = target.versions.find((x) => x.version === tv);
  if (!tVer) throw new UnitDefError(`迁移目标版本 ${toUid}@${tv} 不存在`, "not-found");

  const move = (r: UnitRef | undefined, text: string): { unit: string; ref?: UnitRef } => {
    if (!r || r.uid !== fromUid) return { unit: text, ref: r };
    return {
      unit: tVer.name,
      ref: {
        uid: toUid, version: tv, name: tVer.name,
        migratedFrom: { uid: r.uid, version: r.version, name: r.name, at: now },
      },
    };
  };

  return formulas.map((f) => {
    if (!usagesOf([f], fromUid).length) return f;
    const variables = Object.fromEntries(
      Object.entries(f.variables).map(([name, v]) => {
        const m = move(v.unitRef, v.unit);
        return [name, { ...v, unit: m.unit, unitRef: m.ref }];
      }),
    );
    const tm = move(f.targetUnitRef, f.targetUnit);
    return { ...f, variables, targetUnit: tm.unit, targetUnitRef: tm.ref };
  });
}

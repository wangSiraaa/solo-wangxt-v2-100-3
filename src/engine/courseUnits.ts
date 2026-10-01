// 课程单位库（Course Unit Library）
// ------------------------------------------------------------------
// 教师可用「已支持单位 + 比例因子 + 复合量纲」声明自定义工程单位
// （如 cfs = ft^3/s）。定义带稳定标识与版本：
//   - 每个单位有稳定 id（创建后不变）；修订定义只会追加新版本，旧版本永久保留；
//   - 公式中每个单位字段都钉住具体版本（UnitRef），同名新定义不会重解释历史公式；
//   - 定义链不允许：自引用、间接循环、未知单位、带偏移仿射温标（degC/degF…）组合；
//   - 保存前在独立 mathjs 实例上完整验证，失败不留下任何残缺单位。

import { create, all, type MathJsInstance, type Unit } from "mathjs";
import type { UnitRef } from "./types";

// ---------- 数据结构 ----------

export interface CourseUnitVersion {
  /** 版本号，从 1 递增；同一版本内容不可变 */
  version: number;
  /** 比例因子（> 0）：1 个本单位 = factor × baseUnit */
  factor: number;
  /** 用户原始复合量纲定义，mathjs 单位表达式，如 "ft^3/s" */
  definition: string;
  /** 展开到内置单位后的量纲签名（9 维数组） */
  dimension: number[];
  /** 展开到内置单位的纯单位表达式（不含数字、不含课程单位名），如 "ft^3 / s" */
  baseUnit: string;
  /** 该版本定义依赖的其他课程单位（id → 钉住的版本） */
  deps: Record<string, number>;
  note: string;
  createdAt: number;
}

export interface CourseUnit {
  /** 稳定标识：创建后永不变；同名修订只追加版本 */
  id: string;
  /** 当前显示名（解析单位文本时匹配的裸名）；隔离重命名只改新副本的 name */
  name: string;
  /** 中文说明，如“立方英尺每秒” */
  label: string;
  versions: CourseUnitVersion[];
  /** 来源 */
  origin: "local" | "import";
  /** origin=import 时的隔离命名空间 id；local 为 undefined */
  scope?: string;
  /** 导入时的来源包名（可追溯） */
  packageName?: string;
  deprecated?: boolean;
  createdAt: number;
}

/** 单位库整体快照（不可变数据，所有变更都返回新库） */
export type CourseLibrary = {
  units: CourseUnit[];
  /** 隔离命名空间元信息：scope → 包名 */
  scopes: Record<string, string>;
};

export interface DraftInput {
  /** 新建时为空（自动分配 id）；修订时为被修订单位 id */
  id?: string;
  name: string;
  label: string;
  factor: string;
  definition: string;
  note?: string;
}

export class UnitDefinitionError extends Error {}

// ---------- 常量与工具 ----------

/** 用户可见单位名规则：字母/数字（mathjs 单位名不允许下划线等符号），数字不开头 */
export const UNIT_NAME_RE = /^[A-Za-z][A-Za-z0-9]*$/;

const scratch: MathJsInstance = create(all);
/** mathjs 内置单位名（含 m、ft、degC…），课程单位不得与之重名 */
const BUILTIN_NAMES: Set<string> = new Set(Object.keys((scratch.Unit as unknown as { UNITS: Record<string, unknown> }).UNITS));

export function isBuiltinName(name: string): boolean {
  return BUILTIN_NAMES.has(name);
}

/** 9 维量纲签名 */
export function dimensionKey(dim: number[]): string {
  return dim.join(",");
}

/** 从单位表达式中提取裸标识符（可能的单位名），过滤数字/幂符号 */
const IDENT_RE = /[A-Za-z][A-Za-z0-9]*/g;
export function identifiers(expr: string): string[] {
  return expr.match(IDENT_RE) ?? [];
}

function findUnit(lib: CourseLibrary, id: string): CourseUnit | undefined {
  return lib.units.find((u) => u.id === id);
}
function latestVersion(u: CourseUnit): CourseUnitVersion {
  return u.versions[u.versions.length - 1];
}

/**
 * 把单位表达式中引用的课程单位名展开为内置单位。
 * 比例因子遵循「嵌套相乘」：若 B = fB·baseB，A = fA·B，则 A = fA·fB·baseB。
 * 检测并拒绝自引用 / 间接循环 / 未知单位。
 */
function expandDefinition(
  expr: string,
  resolveVersion: (name: string) => { unit: CourseUnit; ver: CourseUnitVersion } | undefined,
  selfName: string,
): { factor: number; baseUnit: string; deps: Record<string, number> } {
  let factor = 1;
  const deps: Record<string, number> = {};
  let unitExpr = expr;

  // 逐层把课程单位名替换成「依赖版本的基础单位」，并按链累乘因子
  const guard = new Set<string>();
  for (let depth = 0; depth < 1000; depth++) {
    const names = identifiers(unitExpr);
    const custom = names.find((n) => !BUILTIN_NAMES.has(n));
    if (!custom) break;
    if (custom === selfName) {
      throw new UnitDefinitionError(`单位“${selfName}”的定义不能自引用`);
    }
    if (guard.has(custom)) {
      throw new UnitDefinitionError(
        `单位定义链存在循环（${[...guard, custom].join(" → ")}）：不允许间接循环引用`,
      );
    }
    const hit = resolveVersion(custom);
    if (!hit) {
      throw new UnitDefinitionError(`定义中引用了未知单位“${custom}”（不是内置单位，也不在课程单位库中）`);
    }
    guard.add(custom);
    deps[hit.unit.id] = hit.ver.version;
    factor *= hit.ver.factor;
    unitExpr = unitExpr.replace(new RegExp(`\\b${custom}\\b`, "g"), `(${hit.ver.baseUnit})`);
  }

  // 此时表达式只含内置单位名、数字幂次与运算符；括号可能在幂次中产生 "()"，清理之
  const baseUnit = unitExpr.replace(/\(\s*\)/g, "").replace(/\s+/g, " ").trim();
  return { factor, baseUnit: normalizeUnitExpr(baseUnit), deps };
}

/** 归一化单位表达式中的空白，便于比较/展示；不改变数学含义 */
function normalizeUnitExpr(s: string): string {
  return s.replace(/\s*\^\s*/g, "^").replace(/\s*\/\s*/g, " / ").replace(/\s+/g, " ").trim();
}

/** 仿射温标检查：解析表达式并检查是否含带偏移单位（degC/degF 等） */
function assertNoOffset(expr: string): void {
  let u: Unit;
  try {
    u = scratch.unit(expr);
  } catch (e) {
    throw new UnitDefinitionError(`复合量纲表达式“${expr}”无法解析：${(e as Error).message}`);
  }
  const off = u.units.filter((f) => f.unit.offset !== 0).map((f) => f.unit.name);
  if (off.length) {
    throw new UnitDefinitionError(
      `不允许的仿射温标组合：定义中出现带偏移温标 ${off.join("、")}（摄氏度/华氏度只能用于单位换算，不能参与乘除/幂构成新单位；请改用 K、degR）`,
    );
  }
}

/** 校验完整定义并产出待存版本（不修改库） */
function validateDraft(
  lib: CourseLibrary,
  draft: DraftInput,
  scope: string | undefined,
): { id: string; name: string; version: CourseUnitVersion } {
  const name = draft.name.trim();
  if (!UNIT_NAME_RE.test(name)) {
    throw new UnitDefinitionError("单位名只能由英文字母开头的字母/数字组成（如 cfs、kPa2），不支持中文或下划线符号");
  }
  if (BUILTIN_NAMES.has(name)) {
    throw new UnitDefinitionError(`“${name}”是内置标准单位名，课程单位不能与之重名`);
  }
  const factor = Number(draft.factor);
  if (!Number.isFinite(factor) || factor <= 0) {
    throw new UnitDefinitionError(`比例因子必须是正数（当前为“${draft.factor}”）`);
  }
  const rawDef = draft.definition.trim();
  if (!rawDef) throw new UnitDefinitionError("请填写复合量纲定义（如 ft^3/s 或 m^3/s）");

  // 新建重名检查：只在「同一命名空间」内禁止重名
  // （本地与本地、同一隔离包内；不同命名空间允许同名，这正是「隔离」的语义）
  const sameName = lib.units.find(
    (u) => u.name === name && u.id !== draft.id && u.scope === scope,
  );
  if (sameName) {
    throw new UnitDefinitionError(`已存在同名课程单位“${name}”（id=${u8(sameName.id)}）：修订该单位会生成新版本，请使用「修订」而不是新建`);
  }
  const target = draft.id ? findUnit(lib, draft.id) : undefined;
  if (draft.id && !target) throw new UnitDefinitionError("待修订单位不存在");

  // 1) 单条定义展开：依赖按「同名当前最新版本」钉住；自引用/未知单位在其中拒绝
  const expanded = expandDefinition(
    rawDef,
    (n) => {
      const dep = lib.units.find((u) => u.name === n);
      if (!dep) return undefined;
      return { unit: dep, ver: latestVersion(dep) };
    },
    name,
  );

  // 2) 在「候选库」上做完整定义链检查：
  //    新/修订单位可能与既有单位构成间接循环（A 旧→m；B→A；A 新→B ⇒ A→B→A）。
  //    构造候选最新版本的「id → 自定义依赖 id 列表」图，DFS 检查从候选出发能否回到自身。
  {
    const candidateId = target?.id ?? "__new__";
    const nameOfId = (id: string): string => (id === candidateId ? name : findUnit(lib, id)?.name ?? id);
    // 候选版本的依赖（以 id 表示）
    const candidateDeps = (): string[] =>
      identifiers(rawDef)
        .filter((n) => !BUILTIN_NAMES.has(n))
        .map((n) => (n === name ? candidateId : lib.units.find((u) => u.name === n)?.id))
        .filter((x): x is string => x !== undefined);

    const depsOf = (id: string): string[] => {
      if (id === candidateId) return candidateDeps();
      const u = findUnit(lib, id);
      if (!u) return [];
      const v = latestVersion(u);
      return Object.keys(v.deps);
    };
    const cyclePath: string[] = [];
    const dfs = (id: string, trail: string[]): boolean => {
      for (const d of depsOf(id)) {
        if (d === candidateId) { cyclePath.push(...trail, id, candidateId); return true; }
        if (trail.includes(d)) { cyclePath.push(...trail, id, d); return true; }
        if (dfs(d, [...trail, id])) return true;
      }
      return false;
    };
    if (dfs(candidateId, [])) {
      throw new UnitDefinitionError(
        `单位定义链存在循环（${cyclePath.map(nameOfId).join(" → ")}）：不允许间接循环引用`,
      );
    }
  }

  // 1 NAME = (factor × 依赖链累乘因子) × 基础单位
  const totalFactor = factor * expanded.factor;

  assertNoOffset(expanded.baseUnit);

  // mathjs 注册表达式：因子在前、纯单位在后（如 "2 ft"）
  const baseExpression = `${formatFactor(totalFactor)} ${expanded.baseUnit}`.trim();

  // 在隔离 mathjs 实例上试注册，确保不会留下残缺单位（主实例此时完全未改动）
  const probe = create(all);
  const probeName = `probe${Math.abs(hashCode(name + baseExpression)).toString(36)}`;
  try {
    probe.createUnit(probeName, { definition: baseExpression });
  } catch (e) {
    throw new UnitDefinitionError(`单位无法在量纲引擎中注册：${(e as Error).message}`);
  }
  let dim: number[];
  try {
    dim = Array.from(probe.unit(`1 ${probeName}`).dimensions) as number[];
  } catch (e) {
    throw new UnitDefinitionError(`量纲无法确定：${(e as Error).message}`);
  }

  // 禁止无量纲定义
  if (dim.every((d) => d === 0)) {
    throw new UnitDefinitionError("该定义是无量纲纯数，不能作为单位保存");
  }

  const version: CourseUnitVersion = {
    version: target ? latestVersion(target).version + 1 : 1,
    factor: totalFactor,
    definition: rawDef,
    dimension: dim,
    // 只存「总因子 + 内置单位」：旧版本永不因依赖单位后续修订而改变
    baseUnit: expanded.baseUnit,
    deps: expanded.deps,
    note: draft.note?.trim() ?? "",
    createdAt: Date.now(),
  };
  return { id: target?.id ?? newUnitId(), name, version };
}

function formatFactor(n: number): string {
  return String(Number(n.toPrecision(15)));
}
function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0; }
  return h;
}
export function newUnitId(): string {
  return `cu_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
function u8(id: string): string { return id.slice(0, 10); }

// ---------- 库变更（纯函数：返回新库，失败抛错且不产生残缺） ----------

export function emptyLibrary(): CourseLibrary {
  return { units: [], scopes: {} };
}

/** 新建或修订课程单位。校验全部通过才返回新库；否则原库保持不变。 */
export function saveUnit(lib: CourseLibrary, draft: DraftInput, origin: CourseUnit["origin"] = "local", scope?: string, packageName?: string): CourseLibrary {
  const { id, name, version } = validateDraft(lib, draft, scope);
  const existing = findUnit(lib, id);
  if (existing) {
    // 修订：不可变追加新版本；定义未变则拒绝（防止无意义版本）
    const last = latestVersion(existing);
    if (last.factor === version.factor && last.baseUnit === version.baseUnit && (draft.note?.trim() ?? "") === last.note) {
      throw new UnitDefinitionError("比例因子或复合量纲与当前版本相同，没有需要修订的内容");
    }
    return {
      ...lib,
      units: lib.units.map((u) =>
        u.id === id ? { ...u, name, label: draft.label.trim() || u.label, versions: [...u.versions, version] } : u,
      ),
    };
  }
  const unit: CourseUnit = {
    id,
    name,
    label: draft.label.trim() || name,
    versions: [version],
    origin,
    scope,
    packageName,
    createdAt: Date.now(),
  };
  return { ...lib, units: [...lib.units, unit] };
}

export function getUnit(lib: CourseLibrary, ref: Pick<UnitRef, "id" | "version">): CourseUnitVersion | undefined {
  const u = findUnit(lib, ref.id);
  return u?.versions.find((v) => v.version === ref.version);
}
export function getUnitMeta(lib: CourseLibrary, id: string): CourseUnit | undefined {
  return findUnit(lib, id);
}

/** 裸名（+命名空间）解析：找到当前最新版本。隔离单位优先匹配 scope 内名字。 */
export function resolveByName(lib: CourseLibrary, name: string, scope?: string): { unit: CourseUnit; ver: CourseUnitVersion } | undefined {
  const inScope = scope ? lib.units.filter((u) => u.scope === scope) : [];
  const local = lib.units.filter((u) => !u.scope);
  const pool = [...inScope, ...local];
  const u = pool.find((x) => x.name === name);
  if (!u) return undefined;
  return { unit: u, ver: latestVersion(u) };
}

// ---------- 公式 ↔ 版本使用情况 ----------

/** 极简公式结构（避免与 storage 层循环依赖） */
export interface FormulaLike {
  id: string;
  note?: string;
  variables: Record<string, { unit?: string; unitRefs?: UnitRef[] }>;
  targetUnit?: string;
  targetUnitRefs?: UnitRef[];
}

export interface UnitUsage {
  formulaId: string;
  formulaNote: string;
  /** 使用位置（人类可读，如「变量 Q（cfs）v1」「结果目标单位…」） */
  locations: string[];
  version: number;
  name: string;
}

/** 列出所有引用某单位（可限定版本）的公式，用于修订/迁移/删除时展示「受影响公式」 */
export function formulasUsing(lib: CourseLibrary, formulas: FormulaLike[], unitId: string, version?: number): UnitUsage[] {
  void lib;
  const out: UnitUsage[] = [];
  for (const f of formulas) {
    const locations: UnitUsage["locations"] = [];
    let usedVersion: number | undefined;
    let usedName = "";
    for (const [vname, v] of Object.entries(f.variables)) {
      const hit = v.unitRefs?.find((r) => r.id === unitId && (version === undefined || r.version === version));
      if (hit) {
        locations.push(`变量 ${vname}（${v.unit ?? hit.name}）v${hit.version}`);
        usedVersion ??= hit.version;
        usedName ||= hit.name;
      }
    }
    const tHit = f.targetUnitRefs?.find((r) => r.id === unitId && (version === undefined || r.version === version));
    if (tHit) {
      locations.push(`结果目标单位（${f.targetUnit || tHit.name}）v${tHit.version}`);
      usedVersion ??= tHit.version;
      usedName ||= tHit.name;
    }
    if (locations.length) out.push({ formulaId: f.id, formulaNote: f.note ?? "", locations, version: usedVersion ?? 1, name: usedName });
  }
  return out;
}

// ---------- 导入冲突与决策 ----------

export type ConflictDecision =
  | { action: "isolate"; scope: string }
  | { action: "rename"; newName: string }
  | { action: "migrate"; scope: string };

export interface ImportConflict {
  /** 导入包中的单位（待入库） */
  incoming: { name: string; label: string; dimension: number[]; factor: number; definition: string };
  /** 库中同名单位 */
  existing: CourseUnit;
  /** 量纲/定义是否真的不一致（同名且同量纲同比例则视为等价，无需决策） */
  sameDefinition: boolean;
}

/** 比较导入包与现有库，产出需要用户决策的冲突清单 */
export function planImport(lib: CourseLibrary, incoming: ImportableUnit[], packageName: string): { conflicts: ImportConflict[]; clean: ImportableUnit[] } {
  const conflicts: ImportConflict[] = [];
  const clean: ImportableUnit[] = [];
  for (const inc of incoming) {
    const ex = lib.units.find((u) => !u.scope && u.name === inc.name);
    if (!ex) { clean.push(inc); continue; }
    const exv = latestVersion(ex);
    const sameDefinition =
      dimensionKey(exv.dimension) === dimensionKey(inc.dimension) &&
      Math.abs(exv.factor - inc.factor) / Math.max(1e-12, Math.abs(exv.factor)) < 1e-9;
    conflicts.push({
      incoming: { name: inc.name, label: inc.label, dimension: inc.dimension, factor: inc.factor, definition: inc.definition },
      existing: ex,
      sameDefinition,
    });
    void packageName;
  }
  return { conflicts, clean };
}

export interface ImportableUnit {
  name: string;
  label: string;
  /** 总比例因子（已包含依赖链累乘）：1 name = factor × baseUnit */
  factor: number;
  /** 用户原始定义写法，仅用于展示 */
  definition: string;
  /** 展开到内置单位的纯单位表达式；导入时直接据此注册，不再二次展开依赖 */
  baseUnit?: string;
  note?: string;
  dimension: number[];
}

/**
 * 从导入包数据直接构造一个课程单位（不做定义链展开——导入的 factor/baseUnit
 * 已经是展开到内置单位的最终形式）。在隔离 mathjs 实例上完整校验，失败即抛错。
 */
function buildImportedVersion(inc: ImportableUnit): CourseUnitVersion {
  const name = inc.name.trim();
  if (!UNIT_NAME_RE.test(name)) throw new UnitDefinitionError(`导入单位名“${inc.name}”不合法`);
  if (BUILTIN_NAMES.has(name)) throw new UnitDefinitionError(`导入单位名“${name}”与内置单位重名`);
  if (!Number.isFinite(inc.factor) || inc.factor <= 0) {
    throw new UnitDefinitionError(`导入单位“${name}”的比例因子必须为正数`);
  }
  // 优先用包内带的 baseUnit；缺失（旧版包）时退回 definition（旧包因子已是总因子）
  const baseUnit = normalizeUnitExpr((inc.baseUnit ?? inc.definition).trim());
  if (!baseUnit) throw new UnitDefinitionError(`导入单位“${name}”缺少量纲定义`);

  // 仿射温标检查
  assertNoOffset(baseUnit);

  // 隔离实例试注册（失败不留残缺）
  const probe = create(all);
  const probeName = `imp${Math.abs(hashCode(name + inc.factor + baseUnit)).toString(36)}`;
  let dim: number[];
  try {
    probe.createUnit(probeName, { definition: `${formatFactor(inc.factor)} ${baseUnit}` });
    dim = Array.from(probe.unit(`1 ${probeName}`).dimensions) as number[];
  } catch (e) {
    throw new UnitDefinitionError(`导入单位“${name}”无法注册：${(e as Error).message}`);
  }
  if (dim.every((d) => d === 0)) throw new UnitDefinitionError(`导入单位“${name}”是无量纲纯数`);

  return {
    version: 1,
    factor: inc.factor,
    definition: inc.definition,
    dimension: inc.dimension?.length === dim.length ? inc.dimension : dim,
    baseUnit,
    deps: {}, // 导入单位自包含（已展开），不依赖本库其他单位
    note: inc.note ?? "",
    createdAt: Date.now(),
  };
}

/**
 * 按用户决策导入单位包。
 * - 无冲突的新单位：直接作为本地单位入库；
 * - isolate：整包进隔离命名空间，裸名不变（解析时本地优先），不影响本地同名；
 * - rename：以新裸名作为本地单位新建；
 * - migrate：进隔离命名空间保留原定义，返回 migrated 映射供公式显式改绑。
 * 任一单位校验失败则整批中止（不留下半个包）。
 */
export function importPackage(
  lib: CourseLibrary,
  units: ImportableUnit[],
  decisions: Record<string, ConflictDecision>,
  packageName: string,
): { lib: CourseLibrary; scope: string; migrated: Record<string, string> } {
  const scope = `pkg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

  // 先在隔离副本上构造全部待入库单位（任一失败即抛错，原库不动）
  const prepared = units.map((inc) => {
    const existingLocal = lib.units.find((u) => !u.scope && u.name === inc.name);
    let decision: ConflictDecision | undefined;
    if (existingLocal) {
      decision = decisions[inc.name];
      if (!decision) throw new UnitDefinitionError(`同名单位“${inc.name}”尚未选择处理方式（隔离/重命名/迁移）`);
    }
    const ver = buildImportedVersion(inc);
    return { inc, existingLocal, decision, ver };
  });

  let work: CourseLibrary = { ...lib, scopes: { ...lib.scopes, [scope]: packageName } };
  const migrated: Record<string, string> = {};

  for (const { inc, existingLocal, decision, ver } of prepared) {
    const addUnit = (name: string, unitScope: string | undefined, origin: CourseUnit["origin"]): CourseUnit => {
      // 同命名空间重名检查
      if (work.units.some((u) => u.name === name && u.scope === unitScope)) {
        throw new UnitDefinitionError(`导入后“${name}”与同一命名空间内现有单位重名`);
      }
      const unit: CourseUnit = {
        id: newUnitId(),
        name,
        label: inc.label || name,
        versions: [ver],
        origin,
        scope: unitScope,
        packageName,
        createdAt: Date.now(),
      };
      work = { ...work, units: [...work.units, unit] };
      return unit;
    };

    if (!existingLocal) {
      addUnit(inc.name, undefined, "local");
      continue;
    }
    if (decision!.action === "rename") {
      const dec = decision as Extract<ConflictDecision, { action: "rename" }>;
      const newName = dec.newName.trim();
      if (!UNIT_NAME_RE.test(newName) || BUILTIN_NAMES.has(newName)) {
        throw new UnitDefinitionError(`重命名“${inc.name} → ${dec.newName}”不合法`);
      }
      addUnit(newName, undefined, "import");
      continue;
    }
    // isolate / migrate：进隔离命名空间
    const importedMeta = addUnit(inc.name, scope, "import");
    if (decision!.action === "migrate") {
      migrated[existingLocal.id] = importedMeta.id;
    }
  }
  return { lib: work, scope, migrated };
}

/** 把公式字段的绑定从旧单位显式迁移到目标单位/版本；返回迁移后的公式集合与数量。
 *  只改用户勾选的位置（locations：`var:<变量名>` / `target`）。 */
export function migrateFormulaBindings<T extends FormulaLike>(
  formulas: T[],
  fromId: string,
  to: UnitRef,
  locations?: Set<string>,
): { formulas: T[]; count: number } {
  let count = 0;
  const next = formulas.map((f) => {
    let changed = false;
    const variables = Object.fromEntries(Object.entries(f.variables).map(([vn, v]) => {
      const list = v.unitRefs ?? [];
      if (!list.some((r) => r.id === fromId) || (locations && !locations.has(`var:${vn}`))) {
        return [vn, v];
      }
      changed = true;
      const replaced = dedupeRefs(list.map((r) => (r.id === fromId ? to : r)));
      const oldRef = list.find((r) => r.id === fromId)!;
      return [vn, {
        ...v,
        unit: oldRef.name === to.name ? (v.unit ?? "") : (v.unit ?? "").replace(new RegExp(`\\b${oldRef.name}\\b`, "g"), to.name),
        unitRefs: replaced,
      }];
    })) as T["variables"];

    let targetUnit = f.targetUnit;
    let targetUnitRefs = f.targetUnitRefs;
    const tList = f.targetUnitRefs ?? [];
    if (tList.some((r) => r.id === fromId) && (!locations || locations.has("target"))) {
      changed = true;
      const oldRef = tList.find((r) => r.id === fromId)!;
      targetUnitRefs = dedupeRefs(tList.map((r) => (r.id === fromId ? to : r)));
      targetUnit = oldRef.name === to.name
        ? (f.targetUnit ?? "")
        : (f.targetUnit ?? "").replace(new RegExp(`\\b${oldRef.name}\\b`, "g"), to.name);
    }
    if (changed) {
      count++;
      return { ...f, variables, targetUnit, targetUnitRefs };
    }
    return f;
  });
  return { formulas: next, count };
}

function dedupeRefs(refs: UnitRef[]): UnitRef[] {
  const seen = new Set<string>();
  return refs.filter((r) => {
    if (seen.has(r.name)) return false;
    seen.add(r.name);
    return true;
  });
}

// ---------- 库内一致性检查（存储加载/导入后用） ----------

/** 验证整个库每个版本都可注册、量纲齐全；返回问题描述（空数组 = 健康） */
export function verifyLibrary(lib: CourseLibrary): string[] {
  const errors: string[] = [];
  for (const u of lib.units) {
    for (const v of u.versions) {
      try {
        assertNoOffset(v.baseUnit);
        const probe = create(all);
        probe.createUnit(`p${Math.abs(hashCode(u.id + v.version)).toString(36)}`, { definition: `${formatFactor(v.factor)} ${v.baseUnit}` });
      } catch (e) {
        errors.push(`单位 ${u.name} v${v.version} 定义失效：${(e as Error).message}`);
      }
    }
  }
  return errors;
}

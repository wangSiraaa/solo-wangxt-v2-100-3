// 笔记导出 / 导入：JSON 文件，保留可编辑的 LaTeX 表达式（重新导入后仍可用 MathLive 编辑）。
// v2 起同时携带「课程单位库」与每个公式实际绑定的单位定义版本（UnitRef），
// 这样导出文件可以追溯历史结果；导入单位包遇到同名异义单位时由用户选择
// 隔离 / 重命名 / 显式迁移。
import { latexToSource, LatexConvertError } from "../engine/latex";
import type { Formula, UnitRef, VariableDef } from "../engine/types";
import {
  type CourseLibrary, type CourseUnit, type ImportableUnit,
  emptyLibrary, importPackage, planImport,
  type ImportConflict, type ConflictDecision,
} from "../engine/courseUnits";
import { newId } from "./db";

export interface ExportFile {
  app: "dimension-notebook";
  /** 1 = 仅公式；2 = 公式 + 课程单位库 + 版本绑定 */
  version: 1 | 2;
  exportedAt: string;
  formulas: ExportFormula[];
  /** v2：导出时库中的课程单位（至少包含公式引用到的版本，默认整库导出） */
  units?: ExportCourseUnit[];
  /** 导出文件是否为「单位包」（只含单位、可在别处导入） */
  unitPackage?: { name: string };
}

export interface ExportFormula {
  id: string;
  /** MathLive LaTeX：可编辑表达式本体 */
  latex: string;
  note: string;
  /** 由 LaTeX 转换出的中缀表达式，便于跨工具查看/备份 */
  source?: string;
  variables: Record<string, VariableDef>;
  targetUnit: string;
  targetUnitRefs?: UnitRef[];
  preferredScope?: string;
  createdAt: number;
}

export interface ExportCourseUnit {
  name: string;
  label: string;
  factor: number;
  definition: string;
  /** 展开到内置单位的纯量纲表达式 */
  baseUnit?: string;
  note?: string;
  dimension: number[];
}

/** 课程单位 → 导出行（可整库或子集） */
function unitToExportables(lib: CourseLibrary): ExportCourseUnit[] {
  const out: ExportCourseUnit[] = [];
  for (const u of lib.units) {
    for (const v of u.versions) {
      out.push({
        name: u.name, label: u.label, factor: v.factor,
        definition: v.definition, baseUnit: v.baseUnit,
        note: v.note, dimension: v.dimension,
      });
    }
  }
  return out;
}

/** 导出整本笔记（公式 + 完整课程单位库），保留可追溯的版本绑定 */
export function buildExport(formulas: Formula[], lib?: CourseLibrary): ExportFile {
  return {
    app: "dimension-notebook",
    version: lib && lib.units.length ? 2 : 1,
    exportedAt: new Date().toISOString(),
    formulas: formulas.map(exportFormula),
    units: lib ? unitToExportables(lib) : undefined,
  };
}

/** 只导出一个「课程单位包」（供其他课程/同事导入） */
export function buildUnitPackage(lib: CourseLibrary, units: CourseUnit[], packageName: string): ExportFile {
  const subset: CourseLibrary = { ...lib, units };
  return {
    app: "dimension-notebook",
    version: 2,
    exportedAt: new Date().toISOString(),
    formulas: [],
    units: unitToExportables(subset),
    unitPackage: { name: packageName },
  };
}

function exportFormula(f: Formula): ExportFormula {
  let source: string | undefined;
  try {
    source = latexToSource(f.latex).source;
  } catch (e) {
    if (e instanceof LatexConvertError) source = undefined;
  }
  return {
    id: f.id, latex: f.latex, note: f.note, source,
    variables: f.variables,
    targetUnit: f.targetUnit,
    targetUnitRefs: f.targetUnitRefs,
    preferredScope: f.preferredScope,
    createdAt: f.createdAt,
  };
}

export function downloadJSON(data: ExportFile, filename?: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename ?? `量纲笔记_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export interface ImportResult {
  formulas: Formula[];
  errors: string[];
}

/** 解析并校验导入的笔记文件；id 冲突自动重新生成，不覆盖现有笔记。
 *  v2 文件中公式自带的单位版本绑定原样保留（指向导入的单位库副本）。 */
export function parseImport(text: string, existingIds: Set<string>): ImportResult {
  const errors: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { formulas: [], errors: ["文件不是合法的 JSON"] };
  }
  const obj = raw as Partial<ExportFile>;
  if (!obj || obj.app !== "dimension-notebook" || !Array.isArray(obj.formulas)) {
    return { formulas: [], errors: ["不是本工具导出的笔记文件（缺少 app/formulas 字段）"] };
  }

  const formulas: Formula[] = [];
  obj.formulas.forEach((f, i) => {
    const label = `第 ${i + 1} 条`;
    if (!f || typeof f !== "object") { errors.push(`${label}：不是有效对象，已跳过`); return; }
    if (typeof f.latex !== "string") { errors.push(`${label}：缺少 latex 表达式，已跳过`); return; }

    let id = typeof f.id === "string" ? f.id : newId();
    if (existingIds.has(id)) id = newId();
    const vars: Record<string, VariableDef> = {};
    if (f.variables && typeof f.variables === "object") {
      for (const [k, v] of Object.entries(f.variables as Record<string, unknown>)) {
        const vv = v as Partial<VariableDef>;
        if (vv && typeof vv === "object") {
          vars[k] = {
            value: String(vv.value ?? ""),
            unit: String(vv.unit ?? ""),
            unitRefs: Array.isArray(vv.unitRefs) ? vv.unitRefs as UnitRef[] : undefined,
          };
        }
      }
    }
    formulas.push({
      id,
      latex: f.latex,
      note: typeof f.note === "string" ? f.note : "",
      variables: vars,
      targetUnit: typeof f.targetUnit === "string" ? f.targetUnit : "",
      targetUnitRefs: Array.isArray(f.targetUnitRefs) ? f.targetUnitRefs as UnitRef[] : undefined,
      preferredScope: typeof (f as { preferredScope?: unknown }).preferredScope === "string"
        ? ((f as { preferredScope: string }).preferredScope)
        : undefined,
      createdAt: typeof f.createdAt === "number" ? f.createdAt : Date.now(),
    });
  });

  return { formulas, errors };
}

// ---------- 课程单位包导入 ----------

export interface UnitPackageImport {
  packageName: string;
  units: ImportableUnit[];
  conflicts: ImportConflict[];
  /** 无冲突、可直接入库的单位 */
  clean: ImportableUnit[];
  isUnitPackage: boolean;
}

/** 解析单位包（或含单位的笔记文件），给出冲突清单；不修改任何数据 */
export function parseUnitPackage(text: string, lib: CourseLibrary): UnitPackageImport | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { error: "文件不是合法的 JSON" };
  }
  const obj = raw as Partial<ExportFile>;
  if (!obj || obj.app !== "dimension-notebook" || !Array.isArray(obj.units)) {
    return { error: "该文件不包含课程单位库（需要 v2 导出文件或单位包）" };
  }
  const units: ImportableUnit[] = [];
  const errors: string[] = [];
  obj.units.forEach((u, i) => {
    if (!u || typeof u !== "object") { errors.push(`第 ${i + 1} 个单位无效`); return; }
    if (typeof u.name !== "string" || typeof u.definition !== "string" || typeof u.factor !== "number") {
      errors.push(`第 ${i + 1} 个单位缺少 name/factor/definition`);
      return;
    }
    units.push({
      name: u.name, label: String(u.label ?? u.name),
      factor: u.factor, definition: u.definition, baseUnit: u.baseUnit,
      note: typeof u.note === "string" ? u.note : "",
      dimension: Array.isArray(u.dimension) ? u.dimension : [],
    });
  });
  if (errors.length) return { error: errors.join("；") };

  const { conflicts, clean } = planImport(lib, units, obj.unitPackage?.name ?? "导入包");
  return {
    packageName: obj.unitPackage?.name ?? `导入包 ${new Date().toISOString().slice(0, 10)}`,
    units, conflicts, clean,
    isUnitPackage: !!obj.unitPackage,
  };
}

/** 按用户对每个冲突的决策执行单位包导入；任一新单位无效则整批中止（不留半个包） */
export function applyUnitPackage(
  lib: CourseLibrary,
  pkg: UnitPackageImport,
  decisions: Record<string, ConflictDecision>,
): { lib: CourseLibrary; scope: string; migrated: Record<string, string> } {
  return importPackage(lib, pkg.units, decisions, pkg.packageName);
}

export { emptyLibrary };

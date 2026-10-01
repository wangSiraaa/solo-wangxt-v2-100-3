// 笔记导出 / 导入：JSON 文件，保留可编辑的 LaTeX 表达式（重新导入后仍可用 MathLive 编辑）
// 课程单位包：导出全部不可变版本与公式的版本绑定；导入同名冲突时由用户选择
// 隔离（isolate）/ 重命名（rename）/ 显式迁移（migrate），未迁移公式永远解析原版本。
import { latexToSource, LatexConvertError } from "../engine/latex";
import type { Formula } from "../engine/types";
import type {
  CourseUnit, UnitLibrary, UnitRef, VariableDef,
} from "../engine/courseUnits";
import {
  buildUnitContext, dimensionSignature, emptyLibrary, latestVersion,
  migrateFormulas, newUnitUid, normalizeImportLib, UnitDefError,
} from "../engine/courseUnits";
import { newId } from "./db";

export interface ExportFile {
  app: "dimension-notebook";
  version: 2;
  exportedAt: string;
  /** 课程单位库快照（全部版本，旧公式的旧定义可回溯） */
  unitLibrary?: UnitLibrary;
  formulas: ExportFormula[];
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
  targetUnitRef?: UnitRef;
  createdAt: number;
}

export function buildExport(formulas: Formula[], unitLibrary?: UnitLibrary): ExportFile {
  return {
    app: "dimension-notebook",
    version: 2,
    exportedAt: new Date().toISOString(),
    unitLibrary: unitLibrary ? normalizeImportLib(unitLibrary) : undefined,
    formulas: formulas.map((f) => {
      let source: string | undefined;
      try {
        source = latexToSource(f.latex).source;
      } catch (e) {
        if (e instanceof LatexConvertError) source = undefined;
      }
      return {
        id: f.id, latex: f.latex, note: f.note, source,
        variables: f.variables, targetUnit: f.targetUnit,
        targetUnitRef: f.targetUnitRef, createdAt: f.createdAt,
      };
    }),
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

// ---------- 公式导入（v1/v2 兼容） ----------

export interface ImportResult {
  formulas: Formula[];
  errors: string[];
  /** 文件中携带的课程单位库（v2）；调用方决定如何合并 */
  unitLibrary?: UnitLibrary;
}

/** 解析并校验导入文件；id 冲突自动重新生成，不覆盖现有笔记 */
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

  const unitLibrary = obj.unitLibrary ? normalizeImportLib(obj.unitLibrary) : undefined;

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
            unitRef: sanitizeRef(vv.unitRef),
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
      targetUnitRef: sanitizeRef(f.targetUnitRef),
      createdAt: typeof f.createdAt === "number" ? f.createdAt : Date.now(),
    });
  });

  return { formulas, errors, unitLibrary };
}

function sanitizeRef(r: unknown): UnitRef | undefined {
  if (!r || typeof r !== "object") return undefined;
  const ref = r as Partial<UnitRef>;
  if (typeof ref.uid !== "string" || typeof ref.version !== "number") return undefined;
  const out: UnitRef = { uid: ref.uid, version: ref.version };
  if (typeof ref.name === "string") out.name = ref.name;
  const mf = ref.migratedFrom as { uid?: unknown; version?: unknown; name?: unknown; at?: unknown } | undefined;
  if (mf && typeof mf.uid === "string" && typeof mf.version === "number") {
    out.migratedFrom = {
      uid: mf.uid, version: mf.version,
      name: typeof mf.name === "string" ? mf.name : undefined,
      at: typeof mf.at === "number" ? mf.at : Date.now(),
    };
  }
  return out;
}

// ---------- 单位包导入：冲突检测与解决 ----------

/**
 * 单位包文件（也兼容完整笔记文件：从中取 unitLibrary + formulas）。
 */
export interface UnitPackage {
  app: "dimension-notebook";
  unitLibrary: UnitLibrary;
  formulas?: Array<{
    id?: string;
    latex?: unknown;
    note?: unknown;
    variables?: Record<string, unknown>;
    targetUnit?: unknown;
    targetUnitRef?: unknown;
  }>;
}

export type ConflictResolution =
  | { action: "isolate" }
  | { action: "rename"; newName: string }
  | { action: "migrate"; toUid: string; toVersion?: number };

export interface UnitConflict {
  /** 包内单位（带来的定义） */
  incoming: CourseUnit;
  /** 本地同名单位 */
  local: CourseUnit;
  /** 量纲是否相同（相同也允许迁移/隔离；不同量纲默认建议隔离） */
  sameDimension: boolean;
  /** 本地库里可选的迁移目标（量纲相同的同名单位即 local 本身，这里固定指向它） */
  /** 包内引用了该单位的公式（供展示受影响公式） */
  incomingFormulas: { note: string; variable?: string; where: "variable" | "target"; version: number }[];
  resolution?: ConflictResolution;
}

export interface PackagePreview {
  library: UnitLibrary;
  conflicts: UnitConflict[];
  /** 无冲突、可直接并入的单位 uid */
  clean: CourseUnit[];
  formulas: Formula[];
  errors: string[];
}

/** 解析单位包/笔记文件，生成冲突预览；不做任何落库 */
export function previewUnitPackage(
  text: string,
  localLib: UnitLibrary,
  existingIds: Set<string>,
): PackagePreview {
  const errors: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { library: emptyLibrary(), conflicts: [], clean: [], formulas: [], errors: ["文件不是合法的 JSON"] };
  }
  const obj = raw as Partial<UnitPackage>;
  if (!obj || obj.app !== "dimension-notebook" || !obj.unitLibrary) {
    return { library: emptyLibrary(), conflicts: [], clean: [], formulas: [], errors: ["不是有效的单位包（缺少 app/unitLibrary 字段）"] };
  }
  const library = normalizeImportLib(obj.unitLibrary);

  // 公式（包内可能携带，用于展示哪些公式绑定了冲突单位；也参与导入）
  const formulas: Formula[] = [];
  if (Array.isArray(obj.formulas)) {
    obj.formulas.forEach((f, i) => {
      if (!f || typeof f.latex !== "string") { errors.push(`第 ${i + 1} 条公式缺少 latex，已跳过`); return; }
      let id = typeof f.id === "string" ? f.id : newId();
      if (existingIds.has(id)) id = newId();
      const variables: Record<string, VariableDef> = {};
      if (f.variables && typeof f.variables === "object") {
        for (const [k, v] of Object.entries(f.variables as Record<string, unknown>)) {
          const vv = v as Partial<VariableDef> | null;
          if (vv) variables[k] = { value: String(vv.value ?? ""), unit: String(vv.unit ?? ""), unitRef: sanitizeRef(vv.unitRef) };
        }
      }
      formulas.push({
        id,
        latex: f.latex,
        note: typeof f.note === "string" ? f.note : "",
        variables,
        targetUnit: typeof f.targetUnit === "string" ? f.targetUnit : "",
        targetUnitRef: sanitizeRef(f.targetUnitRef),
        createdAt: Date.now() + i,
      });
    });
  }

  // 量纲签名分别在各自库的上下文中计算（直接合并可能因同 uid 重复注册而失败）
  const localCtx = buildUnitContext(localLib);
  const incomingCtx = buildUnitContext(library);
  const conflicts: UnitConflict[] = [];
  const clean: CourseUnit[] = [];

  for (const incoming of library.units) {
    const inName = latestVersion(incoming).name;
    const local = localLib.units.find((u) => latestVersion(u).name === inName);
    if (!local) { clean.push(incoming); continue; }
    const inSig = dimensionSignature(incomingCtx, { uid: incoming.uid, version: latestVersion(incoming).version });
    const localSig = dimensionSignature(localCtx, { uid: local.uid, version: latestVersion(local).version });
    const sameDimension = !!inSig && !!localSig && inSig.length === localSig.length
      && inSig.every((d, idx) => d === localSig[idx]);

    const incomingFormulas: UnitConflict["incomingFormulas"] = [];
    for (const f of formulas) {
      for (const [name, v] of Object.entries(f.variables)) {
        if (v.unitRef?.uid === incoming.uid) {
          incomingFormulas.push({ note: f.note || f.id, variable: name, where: "variable", version: v.unitRef.version });
        }
      }
      if (f.targetUnitRef?.uid === incoming.uid) {
        incomingFormulas.push({ note: f.note || f.id, where: "target", version: f.targetUnitRef.version });
      }
    }
    conflicts.push({ incoming, local, sameDimension, incomingFormulas });
  }

  return { library, conflicts, clean, formulas, errors };
}

export interface AppliedPackage {
  library: UnitLibrary;
  formulas: Formula[];
  /** 已发生的迁移记录，导出文件中可追溯（已体现在 ref.migratedFrom 里） */
  decisions: { incomingUid: string; name: string; action: string; detail?: string }[];
}

/**
 * 按用户对每个冲突给出的决定，合并单位包与公式。
 *  - isolate：包内单位原样导入（uid 不变），本地同名单位并存，绑定按 uid 各走各的；
 *     若 uid 也恰好相同（同一单位的不同库导出），则换新 uid 并改写包内公式引用；
 *  - rename：给包内单位改显示名后导入；
 *  - migrate：不导入该单位，包内公式绑定改写到本地同名单位的指定版本（显式迁移，留痕）。
 */
export function applyUnitPackage(
  preview: PackagePreview,
  localLib: UnitLibrary,
): AppliedPackage {
  const decisions: AppliedPackage["decisions"] = [];
  let lib: UnitLibrary = { ...localLib, units: [...localLib.units] };
  let formulas = [...preview.formulas];

  // 先并入无冲突单位
  for (const u of preview.clean) {
    if (lib.units.some((x) => x.uid === u.uid)) {
      // uid 撞但名字不撞：重发 uid 并改写引用
      const newUid = newUnitUid();
      formulas = rebaseRefs(formulas, u.uid, newUid);
      lib.units.push({ ...u, uid: newUid });
      decisions.push({ incomingUid: u.uid, name: latestVersion(u).name, action: "isolate", detail: "uid 冲突，自动隔离为新条目" });
    } else {
      lib.units.push(u);
    }
  }

  for (const c of preview.conflicts) {
    const res = c.resolution;
    if (!res) {
      throw new UnitDefError(`单位“${latestVersion(c.incoming).name}”的同名冲突尚未选择处理方式`, "conflict");
    }
    const name = latestVersion(c.incoming).name;

    if (res.action === "migrate") {
      // 不导入包内单位；公式绑定显式迁移到本地单位
      const target = lib.units.find((u) => u.uid === res.toUid);
      const tv = res.toVersion ?? (target ? latestVersion(target).version : 0);
      formulas = migrateFormulas(formulas, c.incoming.uid, res.toUid, lib, res.toVersion);
      decisions.push({
        incomingUid: c.incoming.uid, name, action: "migrate",
        detail: `迁移到本地单位“${target ? latestVersion(target).name : res.toUid}”v${tv}`,
      });
      continue;
    }

    if (res.action === "rename") {
      const newName = res.newName.trim();
      if (!newName || lib.units.some((u) => latestVersion(u).name === newName)) {
        throw new UnitDefError(`重命名“${name}”失败：新名“${newName}”为空或仍与现有单位重名`, "conflict");
      }
      let incoming: CourseUnit = {
        ...c.incoming,
        versions: c.incoming.versions.map((v) => ({ ...v, name: v.name === name ? newName : v.name })),
      };
      if (lib.units.some((u) => u.uid === incoming.uid)) {
        const newUid = newUnitUid();
        formulas = rebaseRefs(formulas, incoming.uid, newUid);
        incoming = { ...incoming, uid: newUid };
      }
      lib.units.push(incoming);
      decisions.push({ incomingUid: c.incoming.uid, name, action: "rename", detail: `重命名为“${newName}”` });
      continue;
    }

    // isolate：保留原名、独立并存。uid 相同则必须换 uid 并改写引用
    let incoming = c.incoming;
    if (lib.units.some((u) => u.uid === incoming.uid)) {
      const newUid = newUnitUid();
      formulas = rebaseRefs(formulas, incoming.uid, newUid);
      incoming = { ...incoming, uid: newUid };
      decisions.push({ incomingUid: c.incoming.uid, name, action: "isolate", detail: "同名且 uid 相同：已隔离为独立条目并重写包内公式引用" });
    } else {
      decisions.push({ incomingUid: c.incoming.uid, name, action: "isolate" });
    }
    lib.units.push(incoming);
  }

  return { library: lib, formulas, decisions };
}

/** 把公式中对 oldUid 的所有绑定改为 newUid（版本号保留，用于隔离/重命名导入） */
function rebaseRefs(formulas: Formula[], oldUid: string, newUid: string): Formula[] {
  return formulas.map((f) => {
    const variables: Formula["variables"] = Object.fromEntries(
      Object.entries(f.variables).map(([k, v]: [string, VariableDef]) => [k, v.unitRef?.uid === oldUid
        ? { ...v, unitRef: { ...v.unitRef!, uid: newUid } }
        : v]),
    );
    const targetUnitRef = f.targetUnitRef?.uid === oldUid
      ? { ...f.targetUnitRef, uid: newUid }
      : f.targetUnitRef;
    return { ...f, variables, targetUnitRef };
  });
}

// ---------- 库内容自检（导入后/启动时） ----------

/** 轻量自检：返回无法解析（依赖丢失/循环）的单位描述；供 UI 警告展示 */
export function libraryProblems(lib: UnitLibrary): string[] {
  const problems: string[] = [];
  try {
    const ctx = buildUnitContext(lib);
    for (const u of lib.units) {
      for (const v of u.versions) {
        if (!ctx.unitForRef({ uid: u.uid, version: v.version })) {
          problems.push(`单位“${v.name}”v${v.version} 无法注册（定义链可能不完整）`);
        }
      }
    }
  } catch (e) {
    problems.push(`单位库无法加载：${(e as Error).message}`);
  }
  return problems;
}

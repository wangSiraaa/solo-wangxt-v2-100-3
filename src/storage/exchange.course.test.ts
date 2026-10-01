import { describe, it, expect } from "vitest";
import {
  buildExport, buildUnitPackage, parseImport, parseUnitPackage, applyUnitPackage,
} from "./exchange";
import { emptyLibrary, saveUnit, migrateFormulaBindings } from "../engine/courseUnits";
import { CourseUnitResolver } from "../engine/courseResolver";
import { analyzeFormula } from "../engine/math";
import type { Formula, UnitRef } from "../engine/types";

describe("v2 导出：公式 + 单位库 + 版本绑定可追溯", () => {
  it("导出文件携带单位定义（含展开 baseUnit）与公式绑定", () => {
    let lib = emptyLibrary();
    lib = saveUnit(lib, { name: "cfs", label: "立方英尺每秒", factor: "1", definition: "ft^3/s" });
    const resolver = new CourseUnitResolver(lib);
    const r = analyzeFormula("Q", { Q: { value: "3", unit: "cfs" } }, "m^3/s", { resolver });
    const formula: Formula = {
      id: "f1", latex: "Q", note: "流量", createdAt: 1,
      variables: { Q: { value: "3", unit: "cfs", unitRefs: r.bindings!.variables.Q } },
      targetUnit: "m^3/s", targetUnitRefs: r.bindings!.target,
    };
    const data = buildExport([formula], lib);
    expect(data.version).toBe(2);
    expect(data.units?.[0].name).toBe("cfs");
    expect(data.units?.[0].baseUnit).toContain("ft");
    expect(data.formulas[0].variables.Q.unitRefs?.[0]).toMatchObject({ name: "cfs", version: 1 });
    // 目标单位 m^3/s 是内置单位，不产生课程单位绑定
    expect(data.formulas[0].targetUnitRefs ?? []).toHaveLength(0);
    expect(data.formulas[0].targetUnit).toBe("m^3/s");
  });
});

describe("单位包导出/导入往返", () => {
  it("导出包 → 解析 → 无冲突导入为本地单位，计算一致", () => {
    let lib = emptyLibrary();
    lib = saveUnit(lib, { name: "cfs", label: "", factor: "1", definition: "ft^3/s" });
    const file = buildUnitPackage(lib, lib.units, "水利包");
    expect(file.unitPackage?.name).toBe("水利包");

    const text = JSON.stringify(file);
    const parsed = parseUnitPackage(text, emptyLibrary());
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.conflicts).toHaveLength(0);
    const { lib: imported } = applyUnitPackage(emptyLibrary(), parsed, {});
    expect(imported.units[0].name).toBe("cfs");
    expect(imported.units[0].origin).toBe("local");

    const resolver = new CourseUnitResolver(imported);
    const r = analyzeFormula("Q", { Q: { value: "2", unit: "cfs" } }, "m^3/s", { resolver });
    expect(r.targetValue).toBeCloseTo(0.056633693184, 10);
  });

  it("冲突包刷新/往返：未迁移公式仍解析旧版本", () => {
    // 本地库 cfs = 1 ft^3/s
    let local = emptyLibrary();
    local = saveUnit(local, { name: "cfs", label: "本地", factor: "1", definition: "ft^3/s" });
    const resolver0 = new CourseUnitResolver(local);
    const old = analyzeFormula("Q", { Q: { value: "10", unit: "cfs" } }, "m^3/s", { resolver: resolver0 });
    const formula: Formula = {
      id: "f1", latex: "Q", note: "", createdAt: 1,
      variables: { Q: { value: "10", unit: "cfs", unitRefs: old.bindings!.variables.Q } },
      targetUnit: "m^3/s", targetUnitRefs: old.bindings!.target,
    };
    const oldVal = old.targetValue!;

    // 另一个库导出 cfs = 2 ft^3/s
    let other = emptyLibrary();
    other = saveUnit(other, { name: "cfs", label: "包", factor: "2", definition: "ft^3/s" });
    const pkgText = JSON.stringify(buildUnitPackage(other, other.units, "外来包"));
    const parsed = parseUnitPackage(pkgText, local);
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.conflicts).toHaveLength(1);

    // 以隔离方式导入
    const { lib: withPkg, migrated } = applyUnitPackage(local, parsed, { cfs: { action: "isolate", scope: "" } });
    expect(Object.keys(migrated)).toHaveLength(0);

    // 重新分析旧公式（模拟刷新）：仍是本地 v1，结果不变
    const resolver1 = new CourseUnitResolver(withPkg);
    const replay = analyzeFormula(formula.latex, formula.variables, formula.targetUnit, {
      resolver: resolver1, targetRefs: formula.targetUnitRefs,
    });
    expect(replay.bindings!.variables.Q[0].id).toBe(local.units[0].id);
    expect(replay.targetValue).toBeCloseTo(oldVal, 10);
  });

  it("迁移后公式绑定指向导入单位；导出文件仍记录该绑定，可追溯", () => {
    let local = emptyLibrary();
    local = saveUnit(local, { name: "cfs", label: "本地", factor: "1", definition: "ft^3/s" });
    const resolver0 = new CourseUnitResolver(local);
    const old = analyzeFormula("Q", { Q: { value: "10", unit: "cfs" } }, "m^3/s", { resolver: resolver0 });
    let formula: Formula = {
      id: "f1", latex: "Q", note: "迁移用", createdAt: 1,
      variables: { Q: { value: "10", unit: "cfs", unitRefs: old.bindings!.variables.Q } },
      targetUnit: "m^3/s", targetUnitRefs: old.bindings!.target,
    };
    const localId = local.units[0].id;

    let other = emptyLibrary();
    other = saveUnit(other, { name: "cfs", label: "包", factor: "2", definition: "ft^3/s" });
    const parsed = parseUnitPackage(JSON.stringify(buildUnitPackage(other, other.units, "外来包")), local);
    if ("error" in parsed) throw new Error(parsed.error);
    const { lib: withPkg, migrated } = applyUnitPackage(local, parsed, { cfs: { action: "migrate", scope: "" } });
    const importedId = migrated[localId];
    const meta = withPkg.units.find((u) => u.id === importedId)!;
    const targetRef: UnitRef = { id: importedId, version: 1, name: "cfs", origin: "import", scope: meta.scope };
    formula = migrateFormulaBindings([formula], localId, targetRef, new Set(["var:Q", "target"])).formulas[0];
    expect(formula.variables.Q.unitRefs?.[0].origin).toBe("import");

    const resolver1 = new CourseUnitResolver(withPkg);
    const after = analyzeFormula(formula.latex, formula.variables, formula.targetUnit, {
      resolver: resolver1, targetRefs: formula.targetUnitRefs,
    });
    expect(after.targetValue).toBeCloseTo(2 * old.targetValue!, 9);

    // 导出迁移后的状态：文件中保留导入绑定（含 scope），可追溯
    const exported = JSON.parse(JSON.stringify(buildExport([formula], withPkg)));
    const ref = exported.formulas[0].variables.Q.unitRefs[0];
    expect(ref.origin).toBe("import");
    expect(ref.scope).toBeTruthy();
    expect(ref.version).toBe(1);
  });
});

describe("旧版 v1 文件兼容", () => {
  it("没有 units 的文件仍能按原公式导入", () => {
    const file = buildExport([{
      id: "x", latex: "a+b", note: "", createdAt: 1,
      variables: { a: { value: "1", unit: "m" }, b: { value: "2", unit: "m" } },
      targetUnit: "",
    }]);
    file.version = 1;
    delete file.units;
    const { formulas, errors } = parseImport(JSON.stringify(file), new Set());
    expect(errors).toEqual([]);
    expect(formulas[0].variables.a.unit).toBe("m");
  });
});

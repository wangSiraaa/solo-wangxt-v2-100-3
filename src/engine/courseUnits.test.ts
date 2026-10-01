import { describe, it, expect } from "vitest";
import {
  emptyLibrary, saveUnit,
  formulasUsing, migrateFormulaBindings, planImport, importPackage,
  type CourseLibrary,
} from "./courseUnits";
import { CourseUnitResolver } from "./courseResolver";
import { analyzeFormula } from "./math";
import type { Formula, UnitRef } from "./types";

const F = (p: Partial<Formula> = {}): Formula => ({
  id: "f1", latex: "Q", note: "", variables: {}, targetUnit: "", createdAt: 1, ...p,
});

describe("验收 1：cfs 体积流量，变量计算与 m³/s 换算一致", () => {
  it("创建 cfs = ft^3/s，2 cfs → m^3/s 正确", () => {
    let lib = emptyLibrary();
    lib = saveUnit(lib, { name: "cfs", label: "立方英尺每秒", factor: "1", definition: "ft^3/s" });
    const resolver = new CourseUnitResolver(lib);
    const r = analyzeFormula("Q", { Q: { value: "2", unit: "cfs" } }, "m^3/s", { resolver });
    expect(r.status).toBe("ok");
    expect(r.resultUnit).toBe("cfs");
    expect(r.value).toBeCloseTo(2, 10);
    // 1 ft = 0.3048 m ⇒ 1 ft^3 = 0.028316846592 m^3；2 cfs = 0.056633693184 m^3/s
    expect(r.targetValue).toBeCloseTo(0.056633693184, 10);
    expect(r.targetUnit).toBe("m^3/s");
    // 绑定 v1
    expect(r.bindings?.variables.Q[0]).toMatchObject({ name: "cfs", version: 1 });
  });

  it("比例因子生效：kcfs = 1000 cfs", () => {
    let lib = emptyLibrary();
    lib = saveUnit(lib, { name: "cfs", label: "", factor: "1", definition: "ft^3/s" });
    lib = saveUnit(lib, { name: "kcfs", label: "", factor: "1000", definition: "cfs" });
    const resolver = new CourseUnitResolver(lib);
    const r = analyzeFormula("Q", { Q: { value: "1", unit: "kcfs" } }, "cfs", { resolver });
    expect(r.status).toBe("ok");
    expect(r.targetValue).toBeCloseTo(1000, 8);
    // 依赖被钉在 cfs v1
    const kcfs = lib.units.find((u) => u.name === "kcfs")!;
    expect(kcfs.versions[0].deps[lib.units.find((u) => u.name === "cfs")!.id]).toBe(1);
  });

  it("结果为流量量纲，换算到质量单位报未验证而不是乱算", () => {
    let lib = emptyLibrary();
    lib = saveUnit(lib, { name: "cfs", label: "", factor: "1", definition: "ft^3/s" });
    const resolver = new CourseUnitResolver(lib);
    const r = analyzeFormula("Q", { Q: { value: "2", unit: "cfs" } }, "kg", { resolver });
    expect(r.status).toBe("unverified");
    expect(r.issues.some((i) => i.message.includes("无法换算"))).toBe(true);
  });
});

describe("验收 2：A↔B 循环被完整拒绝，已有单位可继续使用", () => {
  it("先依赖尚不存在的单位 → 拒绝", () => {
    const lib = emptyLibrary();
    expect(() => saveUnit(lib, { name: "uA", label: "", factor: "1", definition: "uB" }))
      .toThrow(/未知单位/);
  });

  it("直接自引用 → 拒绝", () => {
    const lib = emptyLibrary();
    expect(() => saveUnit(lib, { name: "selfx", label: "", factor: "1", definition: "selfx/s" }))
      .toThrow(/自引用/);
  });

  it("A→m、B→A 合法；再把 A 改成 →B 构成 A→B→A，修订被拒绝且库不变", () => {
    let lib = emptyLibrary();
    lib = saveUnit(lib, { name: "goodv", label: "", factor: "1", definition: "m/s" });
    lib = saveUnit(lib, { name: "uA", label: "", factor: "1", definition: "m" });
    lib = saveUnit(lib, { name: "uB", label: "", factor: "1", definition: "uA" });
    const aId = lib.units.find((u) => u.name === "uA")!.id;
    const before = lib;
    expect(() => saveUnit(lib, { id: aId, name: "uA", label: "", factor: "1", definition: "uB" }))
      .toThrow(/循环/);
    // 库引用未变（没有残缺新版本）
    expect(lib).toBe(before);
    // 已有单位继续可用
    const resolver = new CourseUnitResolver(lib);
    const r = analyzeFormula("x", { x: { value: "3", unit: "goodv" } }, "m/s", { resolver });
    expect(r.status).toBe("ok");
    expect(r.value).toBe(3);
    const r2 = analyzeFormula("y", { y: { value: "2", unit: "uB" } }, "m", { resolver });
    expect(r2.status).toBe("ok");
    expect(r2.targetValue).toBeCloseTo(2, 10);
  });

  it("仿射温标组合被拒绝", () => {
    const lib = emptyLibrary();
    expect(() => saveUnit(lib, { name: "baddeg", label: "", factor: "1", definition: "degC/s" }))
      .toThrow(/仿射温标/);
    expect(() => saveUnit(lib, { name: "baddeg2", label: "", factor: "1", definition: "degF" }))
      .toThrow(/仿射温标/);
  });

  it("非法因子/非法名/无量纲被拒绝，不产生单位", () => {
    let lib = emptyLibrary();
    expect(() => saveUnit(lib, { name: "bad1", label: "", factor: "0", definition: "m" })).toThrow();
    expect(() => saveUnit(lib, { name: "bad2", label: "", factor: "-2", definition: "m" })).toThrow();
    expect(() => saveUnit(lib, { name: "m", label: "", factor: "1", definition: "ft" })).toThrow(/内置/);
    expect(() => saveUnit(lib, { name: "1abc", label: "", factor: "1", definition: "m" })).toThrow();
    expect(lib.units).toHaveLength(0);
  });
});

describe("验收 3：同名单位修订生成新版本，旧公式保留原值，显式迁移才采用新版本", () => {
  function setup() {
    let lib = emptyLibrary();
    lib = saveUnit(lib, { name: "flow", label: "流量", factor: "1", definition: "ft^3/s" });
    return lib;
  }

  it("修订后新版本追加，旧版本保留", () => {
    let lib = setup();
    const id = lib.units[0].id;
    lib = saveUnit(lib, { id, name: "flow", label: "流量", factor: "2", definition: "ft^3/s" });
    const u = lib.units[0];
    expect(u.versions).toHaveLength(2);
    expect(u.versions[0].factor).toBe(1);
    expect(u.versions[1].factor).toBe(2);
  });

  it("旧公式（钉住 v1）刷新后仍按 v1 计算；新建/迁移后按 v2", () => {
    let lib = setup();
    const resolver1 = new CourseUnitResolver(lib);
    // 历史公式：10 flow，换算到 m^3/s，保存绑定 v1
    const saved = F({
      variables: { Q: { value: "10", unit: "flow" } },
      targetUnit: "m^3/s",
    });
    const old = analyzeFormula(saved.latex, saved.variables, saved.targetUnit, { resolver: resolver1 });
    expect(old.status).toBe("ok");
    const v1M3s = old.targetValue!;
    const pinnedVar: UnitRef[] = old.bindings!.variables.Q;
    // 模拟公式持久化绑定
    const persisted: Formula = {
      ...saved,
      variables: { Q: { ...saved.variables.Q, unitRefs: pinnedVar } },
      targetUnitRefs: old.bindings!.target,
    };

    // 修订同名单位
    const id = lib.units[0].id;
    lib = saveUnit(lib, { id, name: "flow", label: "流量", factor: "2", definition: "ft^3/s" });
    const resolver2 = new CourseUnitResolver(lib);

    // 用新 resolver + 持久化旧绑定重新分析（刷新页面场景）
    const replayed = analyzeFormula(
      persisted.latex, persisted.variables, persisted.targetUnit,
      { resolver: resolver2, targetRefs: persisted.targetUnitRefs },
    );
    expect(replayed.bindings!.variables.Q[0].version).toBe(1);
    expect(replayed.targetValue).toBeCloseTo(v1M3s, 10); // 物理结果不变

    // 显式迁移到 v2：重写绑定
    const target: UnitRef = { id, version: 2, name: "flow", origin: "local" };
    const { formulas: migrated, count } = migrateFormulaBindings([persisted], id, target);
    expect(count).toBe(1);
    const after = analyzeFormula(
      migrated[0].latex, migrated[0].variables, migrated[0].targetUnit,
      { resolver: resolver2, targetRefs: migrated[0].targetUnitRefs },
    );
    expect(after.bindings!.variables.Q[0].version).toBe(2);
    expect(after.targetValue).toBeCloseTo(2 * v1M3s, 10);
  });

  it("内容没有变化的修订被拒绝（不制造空版本）", () => {
    let lib = setup();
    const id = lib.units[0].id;
    expect(() => saveUnit(lib, { id, name: "flow", label: "流量", factor: "1", definition: "ft^3/s" }))
      .toThrow(/相同/);
  });

  it("受影响公式清单正确", () => {
    let lib = setup();
    const id = lib.units[0].id;
    const resolver = new CourseUnitResolver(lib);
    const a = analyzeFormula("Q", { Q: { value: "1", unit: "flow" } }, "", { resolver });
    const f = F({ id: "fx", variables: { Q: { value: "1", unit: "flow", unitRefs: a.bindings!.variables.Q } } });
    const usage = formulasUsing(lib, [f], id);
    expect(usage).toHaveLength(1);
    expect(usage[0].locations.join()).toContain("变量 Q");
  });
});

describe("验收 4：导入同名冲突单位包，隔离/重命名/迁移可追溯", () => {
  function localLib(): CourseLibrary {
    let lib = emptyLibrary();
    // 本地 cfs = ft^3/s
    lib = saveUnit(lib, { name: "cfs", label: "立方英尺每秒", factor: "1", definition: "ft^3/s" });
    return lib;
  }
  // 导入包：cfs = 2 ft^3/s（同名、同量纲、不同比例）
  const incoming = [{
    name: "cfs", label: "课程包流量", factor: 2, definition: "ft^3/s",
    note: "包内定义", dimension: [0, 3, -1, 0, 0, 0, 0, 0, 0],
  }];

  it("planImport 识别同名且量纲/定义不一致", () => {
    const lib = localLib();
    const { conflicts, clean } = planImport(lib, incoming, "pkg");
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].sameDefinition).toBe(false);
    expect(clean).toHaveLength(0);
  });

  it("量纲不同也被标记（如 cfs vs m/s）", () => {
    let lib = emptyLibrary();
    lib = saveUnit(lib, { name: "cfs", label: "", factor: "1", definition: "ft^3/s" });
    const diffDim = [{
      name: "cfs", label: "", factor: 1, definition: "m/s",
      dimension: [0, 1, -1, 0, 0, 0, 0, 0, 0],
    }];
    const { conflicts } = planImport(lib, diffDim, "p");
    expect(conflicts).toHaveLength(1);
  });

  it("隔离：本地旧公式仍解析本地版，刷新后不变", () => {
    const lib0 = localLib();
    const localId = lib0.units[0].id;
    // 一条已保存、绑定本地 cfs v1 的公式
    const resolver0 = new CourseUnitResolver(lib0);
    const old = analyzeFormula("Q", { Q: { value: "10", unit: "cfs" } }, "m^3/s", { resolver: resolver0 });
    const formula: Formula = F({
      id: "fA",
      variables: { Q: { value: "10", unit: "cfs", unitRefs: old.bindings!.variables.Q } },
      targetUnit: "m^3/s", targetUnitRefs: old.bindings!.target,
    });
    const v1Val = old.targetValue!;

    // 以 isolate 导入
    const { lib: lib1 } = importPackage(lib0, incoming, { cfs: { action: "isolate", scope: "" } }, "pkg");
    const resolver1 = new CourseUnitResolver(lib1);
    const replay = analyzeFormula(
      formula.latex, formula.variables, formula.targetUnit,
      { resolver: resolver1, targetRefs: formula.targetUnitRefs },
    );
    expect(replay.bindings!.variables.Q[0].id).toBe(localId);
    expect(replay.bindings!.variables.Q[0].version).toBe(1);
    expect(replay.targetValue).toBeCloseTo(v1Val, 10);
  });

  it("重命名：导入单位成为新本地名，两个名字都能解析且互不影响", () => {
    const lib0 = localLib();
    const { lib: lib1 } = importPackage(
      lib0, incoming, { cfs: { action: "rename", newName: "cfsBig" } }, "pkg",
    );
    const names = lib1.units.map((u) => u.name).sort();
    expect(names).toEqual(["cfs", "cfsBig"]);
    const resolver = new CourseUnitResolver(lib1);
    const a = analyzeFormula("Q", { Q: { value: "1", unit: "cfs" } }, "ft^3/s", { resolver });
    const b = analyzeFormula("Q", { Q: { value: "1", unit: "cfsBig" } }, "ft^3/s", { resolver });
    expect(a.targetValue).toBeCloseTo(1, 9);
    expect(b.targetValue).toBeCloseTo(2, 9);
  });

  it("显式迁移：未勾选公式保留旧版本，勾选公式改用导入定义", () => {
    const lib0 = localLib();
    const localId = lib0.units.find((u) => u.name === "cfs")!.id;
    const resolver0 = new CourseUnitResolver(lib0);
    const mk = (id: string, value: string): Formula => {
      const r = analyzeFormula("Q", { Q: { value: value, unit: "cfs" } }, "m^3/s", { resolver: resolver0 });
      return F({
        id, variables: { Q: { value, unit: "cfs", unitRefs: r.bindings!.variables.Q } },
        targetUnit: "m^3/s", targetUnitRefs: r.bindings!.target,
      });
    };
    const fKeep = mk("keep", "10");
    const fMove = mk("move", "10");
    const keepVal = (() => {
      const rr = new CourseUnitResolver(lib0);
      return analyzeFormula(fKeep.latex, fKeep.variables, fKeep.targetUnit, { resolver: rr, targetRefs: fKeep.targetUnitRefs }).targetValue!;
    })();

    const { lib: lib1, migrated } = importPackage(
      lib0, incoming, { cfs: { action: "migrate", scope: "" } }, "pkg",
    );
    const importedId = migrated[localId];
    expect(importedId).toBeTruthy();
    const importedMeta = lib1.units.find((u) => u.id === importedId)!;
    const targetRef: UnitRef = {
      id: importedId, version: 1, name: importedMeta.name, origin: "import", scope: importedMeta.scope,
    };
    // 只显式迁移 fMove（传入需要迁移的公式子集），fKeep 不动
    const locs = new Set<string>(["var:Q", "target"]);
    const moved = migrateFormulaBindings([fMove], localId, targetRef, locs);
    expect(moved.count).toBe(1);
    const combined = [fKeep, moved.formulas[0]];

    const resolver1 = new CourseUnitResolver(lib1);
    const keepAfter = analyzeFormula(
      combined[0].latex, combined[0].variables, combined[0].targetUnit,
      { resolver: resolver1, targetRefs: combined[0].targetUnitRefs },
    );
    const moveAfter = analyzeFormula(
      combined[1].latex, combined[1].variables, combined[1].targetUnit,
      { resolver: resolver1, targetRefs: combined[1].targetUnitRefs },
    );
    expect(keepAfter.bindings!.variables.Q[0].id).toBe(localId);
    expect(keepAfter.targetValue).toBeCloseTo(keepVal, 10); // 未迁移：原值
    expect(moveAfter.bindings!.variables.Q[0].id).toBe(importedId);
    expect(moveAfter.bindings!.variables.Q[0].origin).toBe("import");
    expect(moveAfter.targetValue).toBeCloseTo(2 * keepVal, 10); // 迁移后：包内 2 倍定义
  });

  it("无冲突单位直接成为本地单位；任一批中非法单位整批中止", () => {
    const lib = emptyLibrary();
    const ok = [{ name: "newx", label: "", factor: 1, definition: "m/s", dimension: [0, 1, -1, 0, 0, 0, 0, 0, 0] }];
    const r = importPackage(lib, ok, {}, "p");
    expect(r.lib.units[0].origin).toBe("local");
    expect(r.lib.units[0].scope).toBeUndefined();

    const mixed = [
      { name: "ok2", label: "", factor: 1, definition: "m", dimension: [0, 1, 0, 0, 0, 0, 0, 0, 0] },
      { name: "bad3", label: "", factor: 1, definition: "nopeunit", dimension: [] },
    ];
    expect(() => importPackage(emptyLibrary(), mixed, {}, "p")).toThrow();
  });
});

describe("附加：裸名来源偏好（隔离包可被新公式显式选用）", () => {
  it("默认本地优先；preferredScope 指向隔离包时解析导入定义", () => {
    let lib = emptyLibrary();
    lib = saveUnit(lib, { name: "cfs", label: "本地", factor: "1", definition: "ft^3/s" });
    const incoming = [{
      name: "cfs", label: "包", factor: 2, definition: "ft^3/s",
      baseUnit: "ft^3 / s", dimension: [0, 3, -1, 0, 0, 0, 0, 0, 0],
    }];
    const { lib: lib1 } = importPackage(lib, incoming, { cfs: { action: "isolate", scope: "" } }, "pkg");
    const scope = lib1.units.find((u) => u.scope)!.scope!;
    const resolver = new CourseUnitResolver(lib1);

    // 默认：解析本地
    const local = analyzeFormula("Q", { Q: { value: "1", unit: "cfs" } }, "ft^3/s", { resolver });
    expect(local.bindings!.variables.Q[0].scope).toBeUndefined();
    expect(local.targetValue).toBeCloseTo(1, 9);

    // 偏好隔离包
    const scoped = analyzeFormula("Q", { Q: { value: "1", unit: "cfs" } }, "ft^3/s", { resolver, preferredScope: scope });
    expect(scoped.bindings!.variables.Q[0].scope).toBe(scope);
    expect(scoped.targetValue).toBeCloseTo(2, 9);
  });
});

describe("附加：保存失败的原子性（不留残缺）", () => {
  it("导入批中含非法单位时整批中止，原库不变", () => {
    const lib = emptyLibrary();
    const mixed = [
      { name: "okunit", label: "", factor: 1, definition: "m", baseUnit: "m", dimension: [0, 1, 0, 0, 0, 0, 0, 0, 0] },
      { name: "badunit", label: "", factor: 1, definition: "nopeunit", baseUnit: "nopeunit", dimension: [] },
    ];
    expect(() => importPackage(lib, mixed, {}, "p")).toThrow();
    expect(lib.units).toHaveLength(0);
  });
});

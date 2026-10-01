import { describe, it, expect } from "vitest";
import {
  buildUnitContext, createUnit, reviseUnit, migrateFormulas,
  validateDef, UnitDefError, emptyLibrary, latestVersion,
  normalizeImportLib, type UnitLibrary, type VariableDef,
} from "./courseUnits";
import { analyzeFormula } from "./math";
import type { Formula } from "./types";

// ---------- 测试辅助 ----------

let clock = 1_000_000;
const tick = () => (clock += 1);

function mkLib(): UnitLibrary { return emptyLibrary(); }

/** 建 cfs = 0.028316846592 m^3/s（1 立方英尺/秒） */
function libWithCfs(lib: UnitLibrary = mkLib()): { lib: UnitLibrary; uid: string } {
  const next = createUnit(
    lib,
    { name: "cfs", factor: 0.028316846592, dimension: "m^3/s", hint: "立方英尺每秒" },
    tick(),
  );
  return { lib: next, uid: next.units[next.units.length - 1].uid };
}

const v = (value: string, unit = "", unitRef?: VariableDef["unitRef"]): VariableDef =>
  unitRef ? { value, unit, unitRef } : { value, unit };

const formula = (p: Partial<Formula> = {}): Formula => ({
  id: "f1",
  latex: "Q*t",
  note: "流量×时间",
  variables: {},
  targetUnit: "",
  createdAt: tick(),
  ...p,
});

// ---------- 1) 创建 cfs：变量计算与 m³/s 换算一致 ----------

describe("验收1：cfs 体积流量单位创建与换算", () => {
  it("创建 cfs 后可作为变量单位参与计算", () => {
    const { lib, uid } = libWithCfs();
    const f: Formula = {
      ...formula(),
      variables: {
        Q: v("10", "cfs", { uid, version: 1, name: "cfs" }),
        t: v("2", "s"),
      },
    };
    const r = analyzeFormula(f.latex, f.variables, "", { units: buildUnitContext(lib) });
    expect(r.status).toBe("ok");
    expect(r.value).toBeCloseTo(10 * 2, 10);
    expect(r.resultUnit).toBe("cfs s");
  });

  it("cfs 结果换算到 m^3 与直接用 0.028316846592 m^3/s 一致", () => {
    const { lib, uid } = libWithCfs();
    const ctx = buildUnitContext(lib);
    const f: Formula = {
      ...formula(),
      variables: {
        Q: v("10", "cfs", { uid, version: 1, name: "cfs" }),
        t: v("2", "s"),
      },
      targetUnit: "m^3",
    };
    const r = analyzeFormula(f.latex, f.variables, f.targetUnit, { units: ctx });
    expect(r.status).toBe("ok");
    expect(r.targetValue).toBeCloseTo(10 * 2 * 0.028316846592, 10);
    expect(r.targetUnit).toBe("m^3");

    // 对照：直接写复合量纲 10 m^3/s * 2 s 结果一致
    const ref = analyzeFormula("Q*t", { Q: v("10", "m^3/s"), t: v("2", "s") }, "m^3");
    expect(ref.status).toBe("ok");
    expect(r.targetValue).toBeCloseTo(ref.targetValue! * 0.028316846592, 12);
  });

  it("m^3/s 也可反向换算到 cfs", () => {
    const { lib } = libWithCfs();
    const ctx = buildUnitContext(lib);
    const r = analyzeFormula(
      "q",
      { q: v("0.028316846592", "m^3/s") },
      "cfs",
      { units: ctx },
    );
    expect(r.status).toBe("ok");
    expect(r.targetValue).toBeCloseTo(1, 10);
  });

  it("自由文本（无绑定）输入 cfs 也能解析到当前最新版本", () => {
    const { lib } = libWithCfs();
    const r = analyzeFormula("q", { q: v("3", "cfs") }, "m^3/s", { units: buildUnitContext(lib) });
    expect(r.status).toBe("ok");
    expect(r.targetValue).toBeCloseTo(3 * 0.028316846592, 10);
  });

  it("课程单位可由其他课程单位组合定义（链式）", () => {
    let { lib } = libWithCfs();
    // 1 cusec_minute = 60 cfs
    lib = createUnit(lib, { name: "cfm_alt", factor: 60, dimension: "cfs" }, tick());
    const ctx = buildUnitContext(lib);
    const uid2 = lib.units.find((u) => latestVersion(u).name === "cfm_alt")!.uid;
    const r = analyzeFormula("x", { x: v("1", "cfm_alt", { uid: uid2, version: 1, name: "cfm_alt" }) }, "m^3/s", { units: ctx });
    expect(r.status).toBe("ok");
    expect(r.targetValue).toBeCloseTo(60 * 0.028316846592, 10);
  });

  it("无量纲比例单位（如 percent）可定义并参与运算", () => {
    let lib = emptyLibrary();
    lib = createUnit(lib, { name: "percent", factor: 0.01, dimension: "" }, tick());
    const uid = lib.units[0].uid;
    const ctx = buildUnitContext(lib);
    const r = analyzeFormula("x", { x: v("50", "percent", { uid, version: 1, name: "percent" }) }, "", { units: ctx });
    expect(r.status).toBe("ok");
    expect(r.value).toBeCloseTo(0.5, 12);
  });

  it("同量纲课程单位可相加（自动换算），不相容量纲报错", () => {
    let lib = libWithCfs().lib;
    // cfs2 = 0.05 m^3/s（同量纲）
    lib = createUnit(lib, { name: "cfs2", factor: 0.05, dimension: "m^3/s" }, tick());
    const uid2 = lib.units.find((u) => latestVersion(u).name === "cfs2")!.uid;
    const uid1 = lib.units.find((u) => latestVersion(u).name === "cfs")!.uid;
    const ctx = buildUnitContext(lib);
    const ok = analyzeFormula("a+b", {
      a: v("1", "cfs", { uid: uid1, version: 1, name: "cfs" }),
      b: v("1", "cfs2", { uid: uid2, version: 1, name: "cfs2" }),
    }, "m^3/s", { units: ctx });
    expect(ok.status).toBe("ok");
    expect(ok.targetValue).toBeCloseTo(0.028316846592 + 0.05, 10);

    // cfs（流量）与 s（时间）相加 → 量纲不兼容
    const bad = analyzeFormula("a+b", {
      a: v("1", "cfs", { uid: uid1, version: 1, name: "cfs" }),
      b: v("1", "s"),
    }, "", { units: ctx });
    expect(bad.status).toBe("error");
    expect(bad.issues.some((i) => i.message.includes("量纲不兼容"))).toBe(true);
  });

  it("课程单位可乘幂并换算（cfs^2）", () => {
    const { lib, uid } = libWithCfs();
    const ctx = buildUnitContext(lib);
    const r = analyzeFormula("Q^2", { Q: v("2", "cfs", { uid, version: 1, name: "cfs" }) }, "", { units: ctx });
    expect(r.status).toBe("ok");
    expect(r.value).toBeCloseTo(4, 10);
  });

  it("定义链中间接引入 degC 同样被拒绝（仿射温标不得经依赖混入）", () => {
    // base = degC（直接被拒）
    expect(() => createUnit(emptyLibrary(), { name: "base", factor: 1, dimension: "degC" }, tick()))
      .toThrow(UnitDefError);
  });

  it("绑定的定义版本缺失时报错，绝不静默改用同名新版本", () => {
    const { lib, uid } = libWithCfs();
    lib.units; // v1 存在
    const ctx = buildUnitContext(lib);
    const r = analyzeFormula("q", {
      q: v("10", "cfs", { uid, version: 99, name: "cfs" }),
    }, "m^3/s", { units: ctx });
    expect(r.status).toBe("error");
    expect(r.issues[0].message).toMatch(/无法识别|课程单位/);
  });
});

// ---------- 2) A↔B 循环依赖被完整拒绝，已有单位继续可用 ----------

describe("验收2：自引用 / 间接循环 / 未知单位 / 仿射温标", () => {
  it("A 直接依赖自身被拒绝", () => {
    let lib = createUnit(emptyLibrary(), { name: "selfU", factor: 2, dimension: "m" }, tick());
    const uidA = lib.units[0].uid;
    expect(() => reviseUnit(lib, uidA, { name: "selfU", factor: 1, dimension: "selfU/s" }, tick())).toThrow(UnitDefError);
    // 失败保存：库未变化
    expect(lib.units[0].versions).toHaveLength(1);
  });

  it("A 依赖 B、B 又依赖 A：第二个保存被完整拒绝，已有单位继续可用", () => {
    // 先建 rateB = 2 m/s（合法）
    let lib = createUnit(emptyLibrary(), { name: "rateB", factor: 2, dimension: "m/s" }, tick());
    const uidB = lib.units[0].uid;
    // 建 rateA = 3 rateB（合法，rateA 依赖 rateB）
    lib = createUnit(lib, { name: "rateA", factor: 3, dimension: "rateB" }, tick());
    const uidA = lib.units.find((u) => latestVersion(u).name === "rateA")!.uid;
    // 尝试把 rateB 修订为依赖 rateA：必须被拒绝（rateB -> rateA -> rateB 循环）
    let caught: UnitDefError | null = null;
    try {
      reviseUnit(lib, uidB, { name: "rateB", factor: 1, dimension: "rateA" }, tick());
    } catch (e) {
      caught = e as UnitDefError;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe("cycle");

    // 拒绝后没有产生残缺单位；rateA、rateB 旧定义照常计算
    const ctx = buildUnitContext(lib);
    const rA = analyzeFormula("x", { x: v("1", "rateA", { uid: uidA, version: 1, name: "rateA" }) }, "m/s", { units: ctx });
    expect(rA.status).toBe("ok");
    expect(rA.targetValue).toBeCloseTo(6, 10); // 3 * 2 m/s
    const rB = analyzeFormula("x", { x: v("1", "rateB", { uid: uidB, version: 1, name: "rateB" }) }, "m/s", { units: ctx });
    expect(rB.targetValue).toBeCloseTo(2, 10);
  });

  it("引用未知单位被拒绝", () => {
    expect(() => validateDef({ name: "x", factor: 1, dimension: "foobar/s" }, emptyLibrary())).toThrow(UnitDefError);
    try {
      validateDef({ name: "x", factor: 1, dimension: "foobar/s" }, emptyLibrary());
    } catch (e) {
      expect((e as UnitDefError).code).toBe("unknown-unit");
    }
  });

  it("比例因子必须为正数（0、负数、NaN 拒绝）", () => {
    for (const factor of [0, -3, Number.NaN]) {
      expect(() => validateDef({ name: "x", factor: factor as number, dimension: "m" }, emptyLibrary()))
        .toThrow(UnitDefError);
    }
  });

  it("非法名称与重名被拒绝", () => {
    let lib = createUnit(emptyLibrary(), { name: "cfs", factor: 1, dimension: "m^3/s" }, tick());
    expect(() => validateDef({ name: "1bad", factor: 1, dimension: "m" }, lib)).toThrow(UnitDefError);
    expect(() => validateDef({ name: "cfs", factor: 2, dimension: "kg" }, lib)).toThrow(UnitDefError);
  });

  it("不得覆盖内置单位名，名称不允许复合运算符", () => {
    for (const name of ["m", "s", "kg", "Pa", "degC", "L"]) {
      expect(() => validateDef({ name, factor: 1, dimension: "m" }, emptyLibrary())).toThrow(UnitDefError);
    }
    for (const name of ["m/s", "cfs-min", "a b", "ft^3"]) {
      expect(() => validateDef({ name, factor: 1, dimension: "m" }, emptyLibrary())).toThrow(UnitDefError);
    }
  });

  it("定义链含 degC/degF 等仿射温标被拒绝（给出改用 K 的提示）", () => {
    try {
      validateDef({ name: "tempRate", factor: 1, dimension: "degC/s" }, emptyLibrary());
      throw new Error("应当拒绝但没有");
    } catch (e) {
      expect((e as UnitDefError).code).toBe("affine-scale");
      expect((e as Error).message).toContain("K");
    }
    expect(() => validateDef({ name: "ftemp", factor: 2, dimension: "degF" }, emptyLibrary()))
      .toThrow(UnitDefError);
  });

  it("失败保存不改变库（createUnit 抛错时返回的仍是旧引用，无残缺条目）", () => {
    const lib = libWithCfs().lib;
    const before = lib.units.length;
    expect(() => createUnit(lib, { name: "bad", factor: 1, dimension: "nope/x" }, tick())).toThrow();
    expect(lib.units.length).toBe(before);
    expect(buildUnitContext(lib).listRegistered().length).toBe(before);
  });
});

// ---------- 3) 修订生成新版本：旧公式保持原值，显式迁移后才采用新版本 ----------

describe("验收3：不可变版本与显式迁移", () => {
  it("同名修订后，绑定旧版本的公式结果不变；新版本只影响新绑定", () => {
    let { lib, uid } = libWithCfs();
    // 旧公式：Q=10 cfs, t=2s，结果目标 m^3
    const f: Formula = {
      ...formula({ id: "old", note: "旧公式" }),
      variables: {
        Q: v("10", "cfs", { uid, version: 1, name: "cfs" }),
        t: v("2", "s"),
      },
      targetUnit: "m^3",
      targetUnitRef: undefined,
    };
    const before = analyzeFormula(f.latex, f.variables, f.targetUnit, { units: buildUnitContext(lib) });
    expect(before.targetValue).toBeCloseTo(10 * 2 * 0.028316846592, 12);

    // 修订同名单位：cfs 改为 factor 0.03（一个错误的“新比例”），生成 v2
    lib = reviseUnit(lib, uid, { name: "cfs", factor: 0.03, dimension: "m^3/s" }, tick());
    expect(latestVersion(lib.units.find((u) => u.uid === uid)!).version).toBe(2);

    const ctx = buildUnitContext(lib);
    const after = analyzeFormula(f.latex, f.variables, f.targetUnit, { units: ctx });
    // 旧公式仍然按 v1 解析：结果不被悄悄重解释
    expect(after.status).toBe("ok");
    expect(after.targetValue).toBeCloseTo(before.targetValue!, 12);
    expect(after.targetValue).not.toBeCloseTo(10 * 2 * 0.03, 6);

    // 新公式绑定 v2 → 用新比例
    const f2: Formula = {
      ...formula({ id: "new", note: "新公式" }),
      variables: {
        Q: v("10", "cfs", { uid, version: 2, name: "cfs" }),
        t: v("2", "s"),
      },
      targetUnit: "m^3",
    };
    const r2 = analyzeFormula(f2.latex, f2.variables, f2.targetUnit, { units: ctx });
    expect(r2.targetValue).toBeCloseTo(10 * 2 * 0.03, 10);
  });

  it("即使变量单位文本被改名/清空，旧绑定仍按旧版本解析（绑定优先）", () => {
    let { lib, uid } = libWithCfs();
    lib = reviseUnit(lib, uid, { name: "cfs", factor: 0.03, dimension: "m^3/s" }, tick());
    const ctx = buildUnitContext(lib);
    // 用户把文本删了，但 ref 还在 v1
    const r = analyzeFormula("q", { q: v("10", "", { uid, version: 1, name: "cfs" }) }, "m^3/s", { units: ctx });
    expect(r.status).toBe("ok");
    expect(r.targetValue).toBeCloseTo(10 * 0.028316846592, 12);
  });

  it("显式迁移后公式采用新版本，且 ref 上保留 migratedFrom 可追溯", () => {
    let { lib, uid } = libWithCfs();
    const oldF: Formula = {
      ...formula({ id: "old", note: "旧公式" }),
      variables: { Q: v("10", "cfs", { uid, version: 1, name: "cfs" }), t: v("2", "s") },
      targetUnit: "cfs",
      targetUnitRef: { uid, version: 1, name: "cfs" },
    };
    lib = reviseUnit(lib, uid, { name: "cfs", factor: 0.03, dimension: "m^3/s" }, tick());

    // 未迁移：旧结果
    const pre = analyzeFormula(oldF.latex, oldF.variables, "m^3", { units: buildUnitContext(lib) });
    expect(pre.targetValue).toBeCloseTo(10 * 2 * 0.028316846592, 12);

    // 显式迁移到 v2
    const now = tick();
    const [moved] = migrateFormulas([oldF], uid, uid, lib, 2, now);
    expect(moved.variables.Q.unitRef!.version).toBe(2);
    expect(moved.variables.Q.unitRef!.migratedFrom).toMatchObject({ uid, version: 1 });
    expect(moved.targetUnitRef!.version).toBe(2);
    expect(moved.targetUnitRef!.migratedFrom).toBeDefined();

    const post = analyzeFormula(moved.latex, moved.variables, "m^3", { units: buildUnitContext(lib) });
    expect(post.targetValue).toBeCloseTo(10 * 2 * 0.03, 10);
  });

  it("迁移只影响指定公式，其他公式保持旧绑定", () => {
    let { lib, uid } = libWithCfs();
    const f1: Formula = {
      ...formula({ id: "a", note: "A" }),
      variables: { q: v("1", "cfs", { uid, version: 1, name: "cfs" }) },
    };
    const f2: Formula = {
      ...formula({ id: "b", note: "B" }),
      variables: { q: v("1", "cfs", { uid, version: 1, name: "cfs" }) },
    };
    lib = reviseUnit(lib, uid, { name: "cfs", factor: 0.03, dimension: "m^3/s" }, tick());
    const [mf1] = migrateFormulas([f1], uid, uid, lib);
    expect(mf1.variables.q.unitRef!.version).toBe(2);
    expect(f2.variables.q.unitRef!.version).toBe(1);
  });
});

// ---------- 4) 导入单位包：同名冲突处理 + 刷新后仍解析原版本 + 导出可追溯 ----------

describe("验收4：单位包导入冲突、刷新持久化与导出追溯", () => {
  // 用 storage 层函数（避免循环依赖，这里直接动态导入）
  // 注：storage 依赖 fake-indexeddb 之外的东西，这些纯函数只在引擎上工作；
  // 这里直接测试 exchange 的纯函数（Node 环境无 IndexedDB 也不影响 parse/preview/apply）。
  it("同名不同量纲：隔离后两个定义并存，各按 uid 解析；重命名同理", async () => {
    const { previewUnitPackage, applyUnitPackage } = await import("../storage/exchange");
    // 本地：foo = m
    const local = createUnit(emptyLibrary(), { name: "foo", factor: 1, dimension: "m" }, tick());
    // 包：foo = kg（同名、不同量纲），带一条引用它的公式
    const incoming = createUnit(emptyLibrary(), { name: "foo", factor: 1, dimension: "kg" }, tick());
    const incomingUid = incoming.units[0].uid;
    const file = JSON.stringify({
      app: "dimension-notebook", version: 2, exportedAt: new Date().toISOString(),
      unitLibrary: incoming,
      formulas: [{
        id: "pf1", latex: "x", note: "包内公式",
        variables: { x: { value: "2", unit: "foo", unitRef: { uid: incomingUid, version: 1, name: "foo" } } },
        targetUnit: "", targetUnitRef: undefined, createdAt: 1,
      }],
    });
    const pv = previewUnitPackage(file, local, new Set());
    expect(pv.conflicts).toHaveLength(1);
    expect(pv.conflicts[0].sameDimension).toBe(false);
    expect(pv.conflicts[0].incomingFormulas).toHaveLength(1);

    // 选隔离
    pv.conflicts[0].resolution = { action: "isolate" };
    const applied = applyUnitPackage(pv, local);
    expect(applied.library.units).toHaveLength(2);
    // uid 不同 → 直接并存，包公式仍指向包 uid
    const pf = applied.formulas[0];
    expect(pf.variables.x.unitRef!.uid).toBe(incomingUid);

    // 合并后的上下文里，包内公式解析为 kg
    const ctx = buildUnitContext(applied.library);
    const r = analyzeFormula(pf.latex, pf.variables, "kg", { units: ctx });
    expect(r.status).toBe("ok");
    expect(r.targetValue).toBeCloseTo(2, 10);
    // 本地 foo 仍是 m
    const localUid = local.units[0].uid;
    const r2 = analyzeFormula("y", { y: v("2", "foo", { uid: localUid, version: 1, name: "foo" }) }, "m", { units: ctx });
    expect(r2.targetValue).toBeCloseTo(2, 10);
  });

  it("同名同量纲不同比例：未迁移公式解析原版本；显式迁移后公式采用本地版本", async () => {
    const { previewUnitPackage, applyUnitPackage } = await import("../storage/exchange");
    // 本地 cfs 已是 v2 比例 0.03；包内公式绑定包内 cfs v1（0.0283...）
    let local = createUnit(emptyLibrary(), { name: "cfs", factor: 0.028316846592, dimension: "m^3/s" }, tick());
    const localUid = local.units[0].uid;
    local = reviseUnit(local, localUid, { name: "cfs", factor: 0.03, dimension: "m^3/s" }, tick());

    const incoming = createUnit(emptyLibrary(), { name: "cfs", factor: 0.028316846592, dimension: "m^3/s" }, tick());
    const incomingUid = incoming.units[0].uid;
    const file = JSON.stringify({
      app: "dimension-notebook", version: 2, exportedAt: new Date().toISOString(),
      unitLibrary: incoming,
      formulas: [{
        id: "pf9", latex: "q", note: "包内流量",
        variables: { q: { value: "10", unit: "cfs", unitRef: { uid: incomingUid, version: 1, name: "cfs" } } },
        targetUnit: "m^3/s", targetUnitRef: undefined, createdAt: 1,
      }],
    });

    const pv = previewUnitPackage(file, local, new Set());
    expect(pv.conflicts).toHaveLength(1);
    expect(pv.conflicts[0].sameDimension).toBe(true);

    // 先隔离：刷新等价场景——从合并库重建上下文，未迁移公式仍解析包内版本
    pv.conflicts[0].resolution = { action: "isolate" };
    const isolated = applyUnitPackage(pv, local);
    const libAfterReload = normalizeImportLib(JSON.parse(JSON.stringify(isolated.library))) as UnitLibrary;
    const fAfterReload = JSON.parse(JSON.stringify(isolated.formulas)) as Formula[];
    const ctx = buildUnitContext(libAfterReload);
    const stillOld = analyzeFormula(
      fAfterReload[0].latex,
      fAfterReload[0].variables,
      "m^3/s",
      { units: ctx },
    );
    expect(stillOld.targetValue).toBeCloseTo(10 * 0.028316846592, 10);
    expect(stillOld.targetValue).not.toBeCloseTo(10 * 0.03, 6);

    // 再做显式迁移到本地 v2（模拟用户在冲突弹窗选 migrate）
    const pv2 = previewUnitPackage(file, local, new Set());
    pv2.conflicts[0].resolution = { action: "migrate", toUid: localUid, toVersion: 2 };
    const migrated = applyUnitPackage(pv2, local);
    const mf = migrated.formulas[0];
    expect(mf.variables.q.unitRef!.uid).toBe(localUid);
    expect(mf.variables.q.unitRef!.version).toBe(2);
    expect(mf.variables.q.unitRef!.migratedFrom).toMatchObject({ uid: incomingUid, version: 1 });
    const r = analyzeFormula(mf.latex, mf.variables, "m^3/s", { units: buildUnitContext(migrated.library) });
    expect(r.targetValue).toBeCloseTo(10 * 0.03, 10);
  });

  it("重命名：包内单位以新名导入，包内公式绑定跟随", async () => {
    const { previewUnitPackage, applyUnitPackage } = await import("../storage/exchange");
    const local = createUnit(emptyLibrary(), { name: "cfs", factor: 0.03, dimension: "m^3/s" }, tick());
    const incoming = createUnit(emptyLibrary(), { name: "cfs", factor: 0.028316846592, dimension: "m^3/s" }, tick());
    const file = JSON.stringify({
      app: "dimension-notebook", version: 2, exportedAt: new Date().toISOString(),
      unitLibrary: incoming,
      formulas: [],
    });
    const pv = previewUnitPackage(file, local, new Set());
    pv.conflicts[0].resolution = { action: "rename", newName: "cfsLegacy" };
    const applied = applyUnitPackage(pv, local);
    const names = applied.library.units.map((u) => latestVersion(u).name).sort();
    expect(names).toEqual(["cfs", "cfsLegacy"]);
  });

  it("未全部解决冲突时拒绝应用", async () => {
    const { previewUnitPackage, applyUnitPackage } = await import("../storage/exchange");
    const local = createUnit(emptyLibrary(), { name: "cfs", factor: 0.03, dimension: "m^3/s" }, tick());
    const incoming = createUnit(emptyLibrary(), { name: "cfs", factor: 1, dimension: "kg" }, tick());
    const file = JSON.stringify({ app: "dimension-notebook", version: 2, unitLibrary: incoming, formulas: [] });
    const pv = previewUnitPackage(file, local, new Set());
    expect(() => applyUnitPackage(pv, local)).toThrow(/冲突/);
  });

  it("导出文件携带库版本与公式绑定，可追溯每个公式实际使用的定义", async () => {
    const { buildExport, parseImport } = await import("../storage/exchange");
    let { lib, uid } = libWithCfs();
    lib = reviseUnit(lib, uid, { name: "cfs", factor: 0.03, dimension: "m^3/s" }, tick());
    const f: Formula = {
      ...formula({ latex: "q" }),
      variables: { q: v("10", "cfs", { uid, version: 1, name: "cfs" }) },
    };
    const file = buildExport([f], lib);
    expect(file.unitLibrary?.units[0].versions).toHaveLength(2);
    const text = JSON.stringify(file);
    const parsed = parseImport(text, new Set());
    expect(parsed.unitLibrary).toBeDefined();
    expect(parsed.formulas[0].variables.q.unitRef).toMatchObject({ uid, version: 1 });

    // 用导入回的库重建上下文：旧公式仍按 v1 计算
    const ctx = buildUnitContext(parsed.unitLibrary!);
    const r = analyzeFormula(
      parsed.formulas[0].latex,
      parsed.formulas[0].variables,
      "m^3/s",
      { units: ctx },
    );
    // 单个流量单位直接换算，10 cfs = 10*0.028316846592 m^3/s
    expect(r.targetValue).toBeCloseTo(10 * 0.028316846592, 10);
  });

  it("normalizeImportLib 过滤残缺条目，不拖垮整个库", async () => {
    const lib = normalizeImportLib({
      schemaVersion: 1,
      units: [
        { uid: "ok", versions: [{ version: 1, name: "ok", factor: 1, dimension: "m", createdAt: 1, deps: [] }] },
        { uid: "broken", versions: [] },
        { uid: "broken2", versions: [{ version: "x" }] },
        null,
      ],
    });
    expect(lib.units.map((u) => u.uid)).toEqual(["ok"]);
  });
});

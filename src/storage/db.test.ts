// IndexedDB 持久化与模式迁移（v1 公式库 → v2 增加课程单位库）
// Node 环境：用 fake-indexeddb 的内存实现
import { describe, it, expect, beforeEach } from "vitest";
import FDBFactory from "fake-indexeddb/lib/FDBFactory";
import { db } from "./db";
import { createUnit, emptyLibrary, latestVersion, reviseUnit } from "../engine/courseUnits";
import type { Formula } from "../engine/types";

let counter = 0;
const mkFormula = (p: Partial<Formula> = {}): Formula => ({
  id: `f_${counter++}`,
  latex: "x",
  note: "",
  variables: {},
  targetUnit: "",
  createdAt: Date.now(),
  ...p,
});

beforeEach(() => {
  // 每个用例使用全新的内存数据库
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new FDBFactory() as unknown as IDBFactory;
});

describe("IndexedDB 模式迁移 v1 → v2", () => {
  it("v1 库只有公式时升级到 v2 不丢公式，单位库初始化为空", async () => {
    // 手工建一个 v1 结构（仅 formulas store）
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open("dimension-notebook", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("formulas", { keyPath: "id" });
      req.onsuccess = () => { req.result.close(); resolve(); };
      req.onerror = () => reject(req.error);
    });
    await db.put(mkFormula({ id: "keep1", latex: "a+b" }));

    // 以 v2 重新打开：触发升级
    const rows = await db.all();
    expect(rows.map((f) => f.id)).toEqual(["keep1"]);
    const lib = await db.getLibrary();
    expect(lib.units).toEqual([]);
  });

  it("单位库可保存、再读回（含全部版本）", async () => {
    let lib = createUnit(emptyLibrary(), { name: "cfs", factor: 0.028316846592, dimension: "m^3/s" });
    const uid = lib.units[0].uid;
    lib = reviseUnit(lib, uid, { name: "cfs", factor: 0.03, dimension: "m^3/s" });
    await db.putLibrary(lib);

    const back = await db.getLibrary();
    expect(back.units).toHaveLength(1);
    expect(back.units[0].versions).toHaveLength(2);
    expect(latestVersion(back.units[0]).factor).toBe(0.03);
    expect(back.units[0].versions[0].factor).toBe(0.028316846592);
  });

  it("replaceLibraryAndFormulas 原子提交：库与公式一起可读", async () => {
    const lib = createUnit(emptyLibrary(), { name: "ksi", factor: 1000, dimension: "Pa" });
    const formulas = [mkFormula({ id: "g1" }), mkFormula({ id: "g2" })];
    await db.replaceLibraryAndFormulas(lib, formulas);

    const [rows, back] = await Promise.all([db.all(), db.getLibrary()]);
    expect(rows.map((f) => f.id).sort()).toEqual(["g1", "g2"]);
    expect(latestVersion(back.units[0]).name).toBe("ksi");
  });
});

// IndexedDB v1→v2 模式迁移与单位库原子保存（fake-indexeddb）
// @vitest-environment node
import { describe, it, expect, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import { db } from "./db";
import { emptyLibrary, saveUnit } from "../engine/courseUnits";

function deleteDB(name: string): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

/** 直接在 v1 结构（只有 formulas 仓）下写一条数据，模拟老用户库 */
async function seedV1Store(formula: unknown): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.open("dimension-notebook", 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore("formulas", { keyPath: "id" });
    };
    req.onsuccess = () => {
      const d = req.result;
      const t = d.transaction("formulas", "readwrite");
      t.objectStore("formulas").put(formula);
      t.oncomplete = () => { d.close(); resolve(); };
      t.onerror = () => reject(t.error);
    };
    req.onerror = () => reject(req.error);
  });
}

beforeEach(async () => {
  await deleteDB("dimension-notebook");
});

describe("IndexedDB 模式迁移 v1 → v2", () => {
  it("老库（只有 formulas）升级后公式仍可读，单位库为空且不报错", async () => {
    await seedV1Store({ id: "old1", latex: "a+b", variables: {}, targetUnit: "", createdAt: 7 });
    const rows = await db.all();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("old1");
    const { lib, warnings } = await db.loadLibrary();
    expect(lib.units).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("单位库保存后可原样读回（含版本）", async () => {
    let lib = emptyLibrary();
    lib = saveUnit(lib, { name: "cfs", label: "立方英尺每秒", factor: "1", definition: "ft^3/s" });
    const id = lib.units[0].id;
    lib = saveUnit(lib, { id, name: "cfs", label: "立方英尺每秒", factor: "2", definition: "ft^3/s" });
    await db.saveLibrary(lib);
    const { lib: read } = await db.loadLibrary();
    expect(read.units).toHaveLength(1);
    expect(read.units[0].versions).toHaveLength(2);
    expect(read.units[0].versions[1].factor).toBe(2);
    expect(read.units[0].versions[0].baseUnit).toContain("ft");
  });

  it("损坏的单位文档不会让读取崩溃：回退为空库", async () => {
    // 先正常升级到 v2
    await db.all();
    // 直接写入畸形文档
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open("dimension-notebook", 2);
      req.onsuccess = () => {
        const d = req.result;
        const t = d.transaction("courseUnits", "readwrite");
        t.objectStore("courseUnits").put({ junk: true }, "library");
        t.oncomplete = () => { d.close(); resolve(); };
        t.onerror = () => reject(t.error);
      };
    });
    const { lib } = await db.loadLibrary();
    expect(Array.isArray(lib.units)).toBe(true);
  });
});

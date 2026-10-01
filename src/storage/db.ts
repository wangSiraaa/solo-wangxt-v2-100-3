// IndexedDB 本地持久化。无服务器，所有数据仅保存在浏览器本地。
// v1：formulas 一个对象仓；v2：新增 courseUnits 仓保存「课程单位库」快照（整体单文档）。
import type { Formula } from "../engine/types";
import type { CourseLibrary } from "../engine/courseUnits";
import { emptyLibrary, verifyLibrary } from "../engine/courseUnits";

const DB_NAME = "dimension-notebook";
const STORE = "formulas";
const UNIT_STORE = "courseUnits";
const UNIT_DOC_ID = "library";
const VERSION = 2;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(UNIT_STORE)) {
        db.createObjectStore(UNIT_STORE); // keyPath 手动指定（单文档库）
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, storeName: string, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(storeName, mode);
        const req = run(t.objectStore(storeName));
        req.onsuccess = () => { resolve(req.result); db.close(); };
        req.onerror = () => { reject(req.error); db.close(); };
      }),
  );
}

export const db = {
  async all(): Promise<Formula[]> {
    const rows = await tx<Formula[]>("readonly", STORE, (s) => s.getAll() as IDBRequest<Formula[]>);
    return rows.sort((a, b) => a.createdAt - b.createdAt);
  },
  async put(formula: Formula): Promise<void> {
    await tx<IDBValidKey>("readwrite", STORE, (s) => s.put(formula));
  },
  async bulkPut(formulas: Formula[]): Promise<void> {
    const database = await openDB();
    await new Promise<void>((resolve, reject) => {
      const t = database.transaction(STORE, "readwrite");
      const store = t.objectStore(STORE);
      for (const f of formulas) store.put(f);
      t.oncomplete = () => { resolve(); database.close(); };
      t.onerror = () => { reject(t.error); database.close(); };
    });
  },
  async delete(id: string): Promise<void> {
    await tx<undefined>("readwrite", STORE, (s) => s.delete(id) as IDBRequest<undefined>);
  },
  async clear(): Promise<void> {
    await tx<undefined>("readwrite", STORE, (s) => s.clear() as IDBRequest<undefined>);
  },

  // ---------- 课程单位库（单文档整体读写） ----------

  async loadLibrary(): Promise<{ lib: CourseLibrary; warnings: string[] }> {
    const doc = await tx<CourseLibrary | undefined>(
      "readonly", UNIT_STORE, (s) => s.get(UNIT_DOC_ID) as IDBRequest<CourseLibrary | undefined>,
    );
    if (!doc || !Array.isArray(doc.units)) return { lib: emptyLibrary(), warnings: [] };
    // 模式迁移：历史/损坏数据兜底，保证至少有 scopes 字段
    const lib: CourseLibrary = { units: doc.units, scopes: doc.scopes ?? {} };
    const warnings = verifyLibrary(lib);
    return { lib, warnings };
  },
  async saveLibrary(lib: CourseLibrary): Promise<void> {
    // 写入前完整校验：任何版本无法注册都拒绝写入，库里的旧文档保持不变（不留残缺）
    const problems = verifyLibrary(lib);
    if (problems.length) {
      throw new Error(`课程单位库校验未通过，已取消保存：${problems[0]}`);
    }
    await tx<IDBValidKey>("readwrite", UNIT_STORE, (s) => s.put(lib, UNIT_DOC_ID));
  },
};

export function newId(): string {
  return `f_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

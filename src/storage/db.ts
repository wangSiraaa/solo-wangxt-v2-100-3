// IndexedDB 本地持久化。无服务器，所有数据仅保存在浏览器本地。
// v2：新增 unitLibrary 存储（课程单位库，含全部不可变版本）。
import type { Formula } from "../engine/types";
import { emptyLibrary, normalizeImportLib, type UnitLibrary } from "../engine/courseUnits";

const DB_NAME = "dimension-notebook";
const STORE = "formulas";
const LIB_STORE = "unitLibrary";
const LIB_KEY = "current";
const VERSION = 2;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // v1 → v2：单位库对象仓（单文档，无 keyPath，用显式键）
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(LIB_STORE)) {
        db.createObjectStore(LIB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = run(t.objectStore(STORE));
        req.onsuccess = () => { resolve(req.result); db.close(); };
        req.onerror = () => { reject(req.error); db.close(); };
      }),
  );
}

/** 读取课程单位库；缺失（极端情况：升级预置失败）时回退空库 */
async function loadLib(database: IDBDatabase): Promise<UnitLibrary> {
  return new Promise((resolve) => {
    const t = database.transaction(LIB_STORE, "readonly");
    const req = t.objectStore(LIB_STORE).get(LIB_KEY);
    req.onsuccess = () => {
      const row = req.result as (UnitLibrary & { key?: string } | undefined);
      if (row) {
        const { key: _key, ...lib } = row as UnitLibrary & { key?: string };
        void _key;
        resolve(normalizeImportLib(lib));
      } else {
        resolve(emptyLibrary());
      }
    };
    req.onerror = () => resolve(emptyLibrary());
  });
}

export const db = {
  async all(): Promise<Formula[]> {
    const rows = await tx<Formula[]>("readonly", (s) => s.getAll() as IDBRequest<Formula[]>);
    return rows.sort((a, b) => a.createdAt - b.createdAt);
  },
  async put(formula: Formula): Promise<void> {
    await tx<IDBValidKey>("readwrite", (s) => s.put(formula));
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
    await tx<undefined>("readwrite", (s) => s.delete(id) as IDBRequest<undefined>);
  },
  async clear(): Promise<void> {
    await tx<undefined>("readwrite", (s) => s.clear() as IDBRequest<undefined>);
  },

  async getLibrary(): Promise<UnitLibrary> {
    const database = await openDB();
    try {
      return await loadLib(database);
    } finally {
      database.close();
    }
  },

  /** 整库覆盖写（单位保存失败前已在引擎层校验，这里整体提交不留半截） */
  async putLibrary(lib: UnitLibrary): Promise<void> {
    const database = await openDB();
    await new Promise<void>((resolve, reject) => {
      const t = database.transaction(LIB_STORE, "readwrite");
      t.objectStore(LIB_STORE).put({ ...lib, key: LIB_KEY }, LIB_KEY);
      t.oncomplete = () => { resolve(); database.close(); };
      t.onerror = () => { reject(t.error); database.close(); };
    });
  },

  /**
   * 原子地同时落库单位定义与受影响公式（如显式迁移）。
   * 任一步失败整个事务回滚 —— 绝不留下“新单位 + 半迁移公式”。
   */
  async replaceLibraryAndFormulas(lib: UnitLibrary, formulas: Formula[]): Promise<void> {
    const database = await openDB();
    await new Promise<void>((resolve, reject) => {
      const t = database.transaction([LIB_STORE, STORE], "readwrite");
      t.objectStore(LIB_STORE).put({ ...lib, key: LIB_KEY }, LIB_KEY);
      const fs = t.objectStore(STORE);
      for (const f of formulas) fs.put(f);
      t.oncomplete = () => { resolve(); database.close(); };
      t.onerror = () => { reject(t.error); database.close(); };
      t.onabort = () => { reject(t.error); database.close(); };
    });
  },
};

export function newId(): string {
  return `f_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

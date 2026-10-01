import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Formula } from "./engine/types";
import { db, newId } from "./storage/db";
import {
  applyUnitPackage, buildExport, downloadJSON, parseImport,
  previewUnitPackage, type PackagePreview,
} from "./storage/exchange";
import {
  emptyLibrary, latestVersion, migrateFormulas,
  type UnitLibrary,
} from "./engine/courseUnits";
import FormulaCard from "./components/FormulaCard";
import UnitLibraryPanel from "./components/UnitLibraryPanel";
import UnitSuggestions from "./components/UnitSuggestions";
import ImportConflictDialog from "./components/ImportConflictDialog";

function makeFormula(partial?: Partial<Formula>): Formula {
  return {
    id: newId(),
    latex: "",
    note: "",
    variables: {},
    targetUnit: "",
    createdAt: Date.now(),
    ...partial,
  };
}

export default function App() {
  const [formulas, setFormulas] = useState<Formula[]>([]);
  const [library, setLibrary] = useState<UnitLibrary>(emptyLibrary());
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState<string>("");
  const [preview, setPreview] = useState<PackagePreview | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const pkgFileRef = useRef<HTMLInputElement>(null);

  // 启动时读取 IndexedDB（v2：公式 + 课程单位库）
  useEffect(() => {
    Promise.all([db.all(), db.getLibrary()])
      .then(([rows, lib]) => { setFormulas(rows); setLibrary(lib); })
      .catch((e) => setNotice(`读取本地存储失败：${(e as Error).message}`))
      .finally(() => setLoaded(true));
  }, []);

  // 公式变更防抖写入
  const saveTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!loaded) return;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      db.bulkPut(formulas).catch((e) => setNotice(`保存失败：${(e as Error).message}`));
    }, 300);
  }, [formulas, loaded]);

  // 单位库变更立即原子落库（保存动作本身已在引擎层校验通过才会到达这里）
  const saveLibrary = useCallback((next: UnitLibrary) => {
    setLibrary(next);
    db.putLibrary(next).catch((e) => setNotice(`单位库保存失败：${(e as Error).message}`));
  }, []);

  const onCommitLibrary = useCallback((next: UnitLibrary, description: string) => {
    saveLibrary(next);
    setNotice(description);
  }, [saveLibrary]);

  const update = useCallback((id: string, patch: Partial<Formula>) => {
    setFormulas((fs) => fs.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  }, []);

  const remove = useCallback(async (id: string) => {
    setFormulas((fs) => fs.filter((f) => f.id !== id));
    await db.delete(id).catch(() => undefined);
  }, []);

  const add = () => setFormulas((fs) => [...fs, makeFormula()]);

  const addExample = (kind: "unit" | "degC" | "angle" | "dimErr" | "divZero" | "cfs") => {
    const presets: Record<string, Formula> = {
      unit: makeFormula({
        latex: "v\\cdot t+\\frac{1}{2}a t^{2}",
        note: "匀变速直线运动位移",
        variables: {
          v: { value: "2", unit: "m/s" },
          t: { value: "3", unit: "s" },
          a: { value: "4", unit: "m/s^2" },
        },
        targetUnit: "m",
      }),
      degC: makeFormula({
        latex: "T_1+T_2",
        note: "摄氏度直接相加 —— 应提示偏移温标歧义并标记未验证",
        variables: {
          T_1: { value: "10", unit: "degC" },
          T_2: { value: "5", unit: "degC" },
        },
        targetUnit: "",
      }),
      angle: makeFormula({
        latex: "\\theta+\\alpha",
        note: "度与弧度相加 —— 量纲兼容，自动换算",
        variables: {
          theta: { value: "1", unit: "rad" },
          alpha: { value: "180", unit: "deg" },
        },
        targetUnit: "deg",
      }),
      dimErr: makeFormula({
        latex: "(a+b)\\cdot c",
        note: "m 与 kg 相加 —— 应定位到括号内的 + 节点",
        variables: {
          a: { value: "1", unit: "m" },
          b: { value: "2", unit: "kg" },
          c: { value: "3", unit: "" },
        },
        targetUnit: "",
      }),
      divZero: makeFormula({
        latex: "x/y",
        note: "除零 —— 必须明确报错，不产生 Infinity",
        variables: {
          x: { value: "10", unit: "m" },
          y: { value: "0", unit: "s" },
        },
        targetUnit: "",
      }),
      cfs: makeFormula({
        latex: "Q\\cdot t",
        note: "课程单位 cfs（体积流量）示例：变量单位选 cfs，结果换算 m^3",
        variables: {
          Q: { value: "10", unit: "cfs" },
          t: { value: "2", unit: "s" },
        },
        targetUnit: "m^3",
      }),
    };
    setFormulas((fs) => [...fs, presets[kind]]);
  };

  // ---------- 显式迁移 ----------

  /** 迁移单条公式内某个单位的旧绑定到其最新版本（单位面板“迁移此公式”按钮） */
  const migrateOneFormula = useCallback((formulaId: string, uid: string) => {
    setFormulas((fs) => {
      const only = fs.filter((f) => f.id === formulaId);
      const moved = migrateFormulas(only, uid, uid, library);
      const next = fs.map((f) => (f.id === formulaId ? moved[0] : f));
      db.replaceLibraryAndFormulas(library, next).catch((e) =>
        setNotice(`迁移保存失败（已回滚）：${(e as Error).message}`));
      return next;
    });
    const u = library.units.find((x) => x.uid === uid);
    setNotice(`公式已显式迁移到“${u ? latestVersion(u).name : uid}”最新版本；迁移记录保留在绑定中`);
  }, [library]);

  /** 迁移所有仍引用某单位旧版本的公式（单位面板“全部迁移”按钮，传 uid） */
  const migrateAllForUnit = useCallback((uid: string) => {
    setFormulas((fs) => {
      const moved = migrateFormulas(fs, uid, uid, library);
      db.replaceLibraryAndFormulas(library, moved).catch(() => undefined);
      return moved;
    });
    const u = library.units.find((x) => x.uid === uid);
    if (u) setNotice(`全部引用已显式迁移到“${latestVersion(u).name} v${latestVersion(u).version}”`);
  }, [library]);

  /** 迁移单条公式内所有过期绑定到各自最新版本（公式卡片按钮，传公式 id） */
  const migrateOneCard = useCallback((formulaId: string) => {
    setFormulas((fs) => {
      let target = fs.find((f) => f.id === formulaId);
      if (!target) return fs;
      const staleUids = new Set<string>();
      for (const v of Object.values(target.variables)) {
        const r = v.unitRef;
        const u = r && library.units.find((x) => x.uid === r.uid);
        if (r && u && r.version < latestVersion(u).version) staleUids.add(r.uid);
      }
      const tr = target.targetUnitRef;
      const tu = tr && library.units.find((x) => x.uid === tr.uid);
      if (tr && tu && tr.version < latestVersion(tu).version) staleUids.add(tr.uid);
      for (const uid of staleUids) {
        [target] = migrateFormulas([target], uid, uid, library);
      }
      const out = fs.map((f) => (f.id === formulaId ? target! : f));
      db.replaceLibraryAndFormulas(library, out).catch(() => undefined);
      return out;
    });
    setNotice("本公式已显式迁移到各单位最新版本（迁移记录保留在绑定中）");
  }, [library]);

  // ---------- 导出 / 导入 ----------

  const onExport = () => {
    if (formulas.length === 0) { setNotice("当前没有可导出的公式"); return; }
    downloadJSON(buildExport(formulas, library));
  };

  /** 仅导出单位包（库定义，不含公式） */
  const onExportPackage = () => {
    if (library.units.length === 0) { setNotice("当前课程单位库为空，无可导出的单位包"); return; }
    downloadJSON(buildExport([], library), `课程单位包_${new Date().toISOString().slice(0, 10)}.json`);
  };

  const onImportFile = async (file: File) => {
    const text = await file.text();
    const parsed = parseImport(text, new Set(formulas.map((f) => f.id)));

    // 带单位库的文件：走“单位包冲突”流程
    if (parsed.unitLibrary) {
      const pv = previewUnitPackage(text, library, new Set(formulas.map((f) => f.id)));
      if (pv.errors.length && pv.conflicts.length === 0 && pv.clean.length === 0) {
        setNotice(pv.errors[0] ?? "单位包无法解析");
        return;
      }
      if (pv.conflicts.length > 0) {
        setPreview(pv);
        return;
      }
      finishPackageImport(pv);
      return;
    }

    if (parsed.formulas.length === 0) {
      setNotice(parsed.errors[0] ?? "文件中没有可导入的公式");
      return;
    }
    setFormulas((fs) => [...fs, ...parsed.formulas]);
    setNotice(`已导入 ${parsed.formulas.length} 条公式${parsed.errors.length ? `；${parsed.errors.length} 条被跳过（${parsed.errors[0]}）` : ""}`);
  };

  const onImportPackage = async (file: File) => {
    const text = await file.text();
    const pv = previewUnitPackage(text, library, new Set(formulas.map((f) => f.id)));
    if (pv.conflicts.length > 0) { setPreview(pv); return; }
    if (pv.clean.length === 0 && pv.formulas.length === 0) {
      setNotice(pv.errors[0] ?? "单位包中没有可导入内容");
      return;
    }
    finishPackageImport(pv);
  };

  const finishPackageImport = (pv: PackagePreview) => {
    try {
      const applied = applyUnitPackage(pv, library);
      // 库 + 包内公式原子提交
      const nextFormulas = [...formulas, ...applied.formulas];
      db.replaceLibraryAndFormulas(applied.library, nextFormulas)
        .then(() => {
          setLibrary(applied.library);
          setFormulas(nextFormulas);
          const summary = applied.decisions.map((d) => `${d.name}:${d.action}`).join("；");
          setNotice(`单位包已导入${applied.formulas.length ? `，新增公式 ${applied.formulas.length} 条` : ""}${summary ? `；冲突处理：${summary}` : ""}`);
        })
        .catch((e) => setNotice(`导入失败（已整体回滚，不留残缺单位）：${(e as Error).message}`));
    } catch (e) {
      setNotice(`导入被拒绝：${(e as Error).message}`);
    }
  };

  const onConflictChange = (index: number, resolution: PackagePreview["conflicts"][number]["resolution"]) => {
    setPreview((pv) => {
      if (!pv) return pv;
      const conflicts = pv.conflicts.map((c, i) => (i === index ? { ...c, resolution } : c));
      return { ...pv, conflicts };
    });
  };

  const onConfirmConflicts = () => {
    if (!preview) return;
    finishPackageImport(preview);
    setPreview(null);
  };

  const staleRefs = useMemo(() => {
    let n = 0;
    for (const f of formulas) {
      for (const v of Object.values(f.variables)) {
        const r = v.unitRef;
        if (r) {
          const u = library.units.find((x) => x.uid === r.uid);
          if (u && r.version < latestVersion(u).version) n++;
        }
      }
      const t = f.targetUnitRef;
      if (t) {
        const u = library.units.find((x) => x.uid === t.uid);
        if (u && t.version < latestVersion(u).version) n++;
      }
    }
    return n;
  }, [formulas, library]);

  return (
    <div className="app">
      <header className="topbar">
        <h1>量纲检查笔记本</h1>
        <p className="subtitle">
          本地运行 · 数据仅保存在本浏览器（IndexedDB）· 支持 + − × ÷、幂、常用单位与课程单位库
        </p>
        <div className="actions">
          <button type="button" onClick={add}>＋ 新建公式</button>
          <span className="sep" />
          <button type="button" className="ghost" onClick={() => addExample("unit")}>示例：单位运算</button>
          <button type="button" className="ghost" onClick={() => addExample("cfs")}>示例：cfs 流量</button>
          <button type="button" className="ghost" onClick={() => addExample("degC")}>示例：摄氏温标</button>
          <button type="button" className="ghost" onClick={() => addExample("angle")}>示例：角度弧度</button>
          <button type="button" className="ghost" onClick={() => addExample("dimErr")}>示例：量纲错误</button>
          <button type="button" className="ghost" onClick={() => addExample("divZero")}>示例：除零</button>
          <span className="sep" />
          <button type="button" className="ghost" onClick={onExport}>导出 JSON</button>
          <button type="button" className="ghost" onClick={onExportPackage}>导出单位包</button>
          <button type="button" className="ghost" onClick={() => fileRef.current?.click()}>导入 JSON</button>
          <button type="button" className="ghost" onClick={() => pkgFileRef.current?.click()}>导入单位包</button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onImportFile(f);
              e.target.value = "";
            }}
          />
          <input
            ref={pkgFileRef}
            type="file"
            accept="application/json,.json"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onImportPackage(f);
              e.target.value = "";
            }}
          />
        </div>
        {notice && <div className="notice">{notice}</div>}
      </header>

      <UnitLibraryPanel
        library={library}
        formulas={formulas}
        onCommit={onCommitLibrary}
        onMigrateOne={migrateOneFormula}
        onMigrateAll={migrateAllForUnit}
      />
      <UnitSuggestions library={library} />

      <main>
        {!loaded ? (
          <p className="muted">正在加载本地笔记…</p>
        ) : formulas.length === 0 ? (
          <div className="empty-state">
            <p>还没有公式。点击「新建公式」或加载一个示例开始。</p>
            <p className="muted small">
              规则：未赋值变量与除零都会明确报错（不会自动取零）；摄氏/华氏温标的四则运算、未列出的函数等会标记为「未验证」。
              课程单位修订只生成新版本，旧公式保持旧定义，显式迁移后才采用新版本。
            </p>
          </div>
        ) : (
          formulas.map((f, i) => (
            <FormulaCard
              key={f.id}
              formula={f}
              index={i}
              library={library}
              onChange={(patch) => update(f.id, patch)}
              onDelete={() => void remove(f.id)}
              onMigrateAll={migrateOneCard}
            />
          ))
        )}
      </main>

      {staleRefs > 0 && (
        <div className="stale-hint">有 {staleRefs} 处单位引用仍绑定旧版本（旧计算保持原值）；在公式卡片或单位库中可显式迁移。</div>
      )}

      {preview && (
        <ImportConflictDialog
          conflicts={preview.conflicts}
          onChange={onConflictChange}
          onCancel={() => setPreview(null)}
          onConfirm={onConfirmConflicts}
        />
      )}

      <footer className="footer">
        <p>
          红色 = 明确错误（量纲不兼容、未赋值、除零、语法错误）；橙色 = 超出支持范围，结果未验证。
          公式之间完全独立；课程单位按 <code>uid + version</code> 绑定，历史定义不可篡改。
        </p>
      </footer>
    </div>
  );
}

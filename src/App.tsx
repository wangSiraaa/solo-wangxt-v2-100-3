import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Formula, UnitRef } from "./engine/types";
import {
  type CourseLibrary, migrateFormulaBindings,
} from "./engine/courseUnits";
import { CourseUnitResolver } from "./engine/courseResolver";
import { db, newId } from "./storage/db";
import {
  buildExport, buildUnitPackage, downloadJSON, parseImport,
  parseUnitPackage, applyUnitPackage, type UnitPackageImport,
} from "./storage/exchange";
import type { ConflictDecision } from "./engine/courseUnits";
import FormulaCard from "./components/FormulaCard";
import UnitSuggestions from "./components/UnitSuggestions";
import UnitLibraryPanel from "./components/UnitLibraryPanel";

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
  const [library, setLibrary] = useState<CourseLibrary>({ units: [], scopes: {} });
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState<string>("");
  const [libOpen, setLibOpen] = useState(false);
  const [pendingPackage, setPendingPackage] = useState<UnitPackageImport | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const unitFileRef = useRef<HTMLInputElement>(null);

  // 课程单位解析器：随库快照重建（旧 resolver 仍被 useMemo 中的 FormulaCard 短暂持有，无副作用）
  const resolver = useMemo(() => new CourseUnitResolver(library), [library]);

  // 启动时读取 IndexedDB（公式 v1 + 单位库 v2 自动迁移）
  useEffect(() => {
    Promise.all([db.all(), db.loadLibrary()])
      .then(([rows, { lib, warnings }]) => {
        setFormulas(rows);
        setLibrary(lib);
        if (warnings.length) setNotice(`课程单位库自检：${warnings.length} 个定义异常（${warnings[0]}）`);
      })
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

  const persistLibrary = useCallback((next: CourseLibrary) => {
    // 先尝试持久化：校验失败（含残缺定义）会拒绝，内存状态也不更新
    db.saveLibrary(next)
      .then(() => setLibrary(next))
      .catch((e) => setNotice(`课程单位库未保存：${(e as Error).message}`));
  }, []);

  /** 分析完成后把实际绑定的单位版本持久化到公式（只在绑定变化时写，避免循环更新） */
  const commitBindings = useCallback((id: string, bindings: { variables: Record<string, UnitRef[]>; target: UnitRef[] }) => {
    setFormulas((fs) => {
      let changed = false;
      const next = fs.map((f) => {
        if (f.id !== id) return f;
        const variables = { ...f.variables };
        for (const [vn, refs] of Object.entries(bindings.variables)) {
          const prev = variables[vn];
          const same = prev && sameRefs(prev.unitRefs, refs);
          if (!same) {
            changed = true;
            variables[vn] = { ...prev!, unitRefs: refs.length ? refs : undefined };
          }
        }
        // 文本中已经不包含课程单位的变量：清掉失效绑定
        for (const vn of Object.keys(variables)) {
          if (!(vn in bindings.variables) && variables[vn].unitRefs?.length) {
            changed = true;
            variables[vn] = { ...variables[vn], unitRefs: undefined };
          }
        }
        const targetSame = sameRefs(f.targetUnitRefs, bindings.target);
        if (!targetSame) {
          changed = true;
          return { ...f, variables, targetUnitRefs: bindings.target.length ? bindings.target : undefined };
        }
        return changed ? { ...f, variables } : f;
      });
      return changed ? next : fs;
    });
  }, []);

  const update = useCallback((id: string, patch: Partial<Formula>) => {
    setFormulas((fs) => fs.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  }, []);

  const remove = useCallback(async (id: string) => {
    setFormulas((fs) => fs.filter((f) => f.id !== id));
    await db.delete(id).catch(() => undefined);
  }, []);

  const add = () => setFormulas((fs) => [...fs, makeFormula()]);

  const addExample = (kind: "unit" | "degC" | "angle" | "dimErr" | "divZero") => {
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
    };
    setFormulas((fs) => [...fs, presets[kind]]);
  };

  const onExport = () => {
    if (formulas.length === 0) { setNotice("当前没有可导出的公式"); return; }
    downloadJSON(buildExport(formulas, library));
  };

  const onImportFile = async (file: File) => {
    const text = await file.text();
    // 优先尝试作为「含单位的文件」：若带 units 则先引导单位导入
    const pkg = parseUnitPackage(text, library);
    if ("error" in pkg) {
      const { formulas: imported, errors } = parseImport(text, new Set(formulas.map((f) => f.id)));
      if (imported.length === 0) {
        setNotice(errors[0] ?? "文件中没有可导入的公式");
        return;
      }
      setFormulas((fs) => [...fs, ...imported]);
      setNotice(`已导入 ${imported.length} 条公式${errors.length ? `；${errors.length} 条被跳过（${errors[0]}）` : ""}`);
      return;
    }
    // 含单位库：暂存冲突决策，打开面板
    setPendingPackage(pkg);
    setLibOpen(true);
  };

  const onPickPackageFile = () => unitFileRef.current?.click();

  const onPackageFileChosen = async (file: File) => {
    const text = await file.text();
    const pkg = parseUnitPackage(text, library);
    if ("error" in pkg) { setNotice(pkg.error); return; }
    setPendingPackage(pkg);
    setLibOpen(true);
  };

  /** 应用单位包导入：先落库，再按勾选迁移公式绑定（未勾选公式保持旧版本） */
  const onApplyImport = useCallback((decisions: Record<string, ConflictDecision>, migrateKeys: Set<string>) => {
    if (!pendingPackage) return;
    try {
      const { lib: nextLib, migrated } = applyUnitPackage(library, pendingPackage, decisions);
      let nextFormulas = formulas;
      let migratedCount = 0;
      for (const [fromId, toId] of Object.entries(migrated)) {
        const meta = nextLib.units.find((u) => u.id === toId)!;
        const ver = meta.versions[meta.versions.length - 1];
        const targetRef: UnitRef = { id: toId, version: ver.version, name: meta.name, origin: "import", scope: meta.scope };
        // migrateKeys 形如 `${fromId}:${formulaId}`；收集该单位被勾选的公式 id 与位置
        const locs = new Set<string>();
        for (const key of migrateKeys) {
          const [fid, formulaId] = key.split(":");
          if (fid !== fromId) continue;
          // 整公式勾选 = 该公式内全部位置
          const fObj = formulas.find((x) => x.id === formulaId);
          if (!fObj) continue;
          for (const vn of Object.keys(fObj.variables)) locs.add(`var:${vn}`);
          locs.add("target");
        }
        const r = migrateFormulaBindings(nextFormulas, fromId, targetRef, locs.size ? locs : undefined);
        nextFormulas = r.formulas;
        migratedCount += r.count;
      }
      db.saveLibrary(nextLib)
        .then(() => db.bulkPut(nextFormulas))
        .then(() => {
          setLibrary(nextLib);
          setFormulas(nextFormulas);
          setPendingPackage(null);
          setLibOpen(false);
          setNotice(`单位包「${pendingPackage.packageName}」已导入${migratedCount ? `，并迁移了 ${migratedCount} 条公式的绑定（其余公式仍用旧版本，可追溯）` : "；未迁移的公式继续解析原版本"}。`);
        })
        .catch((e) => setNotice(`导入未保存：${(e as Error).message}`));
    } catch (e) {
      setNotice(`导入失败（未写入任何数据）：${(e as Error).message}`);
    }
  }, [pendingPackage, library, formulas]);

  const onSaveUnit = useCallback((next: CourseLibrary) => {
    persistLibrary(next);
  }, [persistLibrary]);

  /** 本地单位修订后，把勾选的公式显式迁移到指定最新版本 */
  const onMigrateRevision = useCallback((unitId: string, toVersion: number, formulaIds: string[]) => {
    const meta = library.units.find((u) => u.id === unitId);
    if (!meta || formulaIds.length === 0) return;
    const targetRef: UnitRef = {
      id: unitId, version: toVersion, name: meta.name,
      origin: meta.origin, scope: meta.scope,
    };
    // 只迁移被勾选公式：按公式分别迁移
    let next = formulas;
    let total = 0;
    for (const fid of formulaIds) {
      const one: Formula[] = next.filter((f) => f.id === fid);
      const r = migrateFormulaBindings(one, unitId, targetRef);
      if (r.count) {
        total += r.count;
        next = next.map((f) => (f.id === fid ? r.formulas[0] : f));
      }
    }
    if (total === 0) return;
    db.bulkPut(next)
      .then(() => { setFormulas(next); setNotice(`已将 ${total} 条公式显式迁移到「${meta.name} v${toVersion}」；其余公式仍用原版本。`); })
      .catch((e) => setNotice(`迁移保存失败：${(e as Error).message}`));
  }, [library, formulas]);

  const onExportPackage = () => {
    if (library.units.length === 0) return;
    downloadJSON(
      buildUnitPackage(library, library.units, `课程单位包_${new Date().toISOString().slice(0, 10)}`),
      `课程单位包_${new Date().toISOString().slice(0, 10)}.json`,
    );
  };

  return (
    <div className="app">
      <UnitSuggestions library={library} />
      <header className="topbar">
        <h1>量纲检查笔记本</h1>
        <p className="subtitle">
          本地运行 · 数据仅保存在本浏览器（IndexedDB）· 支持自定义工程单位与版本绑定
        </p>
        <div className="actions">
          <button type="button" onClick={add}>＋ 新建公式</button>
          <span className="sep" />
          <button type="button" className="ghost" onClick={() => addExample("unit")}>示例：单位运算</button>
          <button type="button" className="ghost" onClick={() => addExample("degC")}>示例：摄氏温标</button>
          <button type="button" className="ghost" onClick={() => addExample("angle")}>示例：角度弧度</button>
          <button type="button" className="ghost" onClick={() => addExample("dimErr")}>示例：量纲错误</button>
          <button type="button" className="ghost" onClick={() => addExample("divZero")}>示例：除零</button>
          <span className="sep" />
          <button type="button" className="ghost" onClick={() => { setPendingPackage(null); setLibOpen(true); }}>
            📚 课程单位库{library.units.length ? `（${library.units.length}）` : ""}
          </button>
          <button type="button" className="ghost" onClick={onExport}>导出 JSON</button>
          <button type="button" className="ghost" onClick={() => fileRef.current?.click()}>导入 JSON</button>
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
            ref={unitFileRef}
            type="file"
            accept="application/json,.json"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onPackageFileChosen(f);
              e.target.value = "";
            }}
          />
        </div>
        {notice && <div className="notice">{notice}</div>}
      </header>

      <main>
        {!loaded ? (
          <p className="muted">正在加载本地笔记…</p>
        ) : formulas.length === 0 ? (
          <div className="empty-state">
            <p>还没有公式。点击「新建公式」或加载一个示例开始。</p>
            <p className="muted small">
              规则：未赋值变量与除零都会明确报错（不会自动取零）；
              摄氏/华氏温标的四则运算、未列出的函数等会标记为「未验证」，需要人工确认。
              在「课程单位库」中可用已支持单位 + 比例因子定义 cfs 等工程单位，定义修订只生成新版本，旧公式不受影响。
            </p>
          </div>
        ) : (
          formulas.map((f, i) => (
            <FormulaCard
              key={f.id}
              formula={f}
              index={i}
              resolver={resolver}
              library={library}
              onBindings={(b) => commitBindings(f.id, b)}
              onChange={(patch) => update(f.id, patch)}
              onDelete={() => void remove(f.id)}
            />
          ))
        )}
      </main>

      {libOpen && (
        <UnitLibraryPanel
          library={library}
          formulas={formulas}
          onClose={() => { setLibOpen(false); setPendingPackage(null); }}
          onSaveUnit={onSaveUnit}
          onMigrateRevision={onMigrateRevision}
          onApplyImport={onApplyImport}
          pendingPackage={pendingPackage}
          onPickPackageFile={onPickPackageFile}
          onExportPackage={onExportPackage}
        />
      )}

      <footer className="footer">
        <p>
          红色 = 明确错误；橙色 = 超出支持范围，结果未验证。公式之间完全独立。
          课程单位按「定义版本」绑定：修订单位会生成新版本，只有显式迁移的公式才采用新定义。
        </p>
      </footer>
    </div>
  );
}

function sameRefs(a: UnitRef[] | undefined, b: UnitRef[] | undefined): boolean {
  if (!a || a.length === 0) return !b || b.length === 0;
  if (!b || a.length !== b.length) return false;
  return a.every((x, i) => x.id === b[i].id && x.version === b[i].version && x.name === b[i].name);
}

// 课程单位库管理面板：新建/修订单位、版本历史、受影响公式、单位包导入导出。
import { useMemo, useState } from "react";
import {
  type CourseLibrary, type CourseUnit, type DraftInput,
  type FormulaLike, type ImportConflict, type ConflictDecision,
  UnitDefinitionError, dimensionKey, formulasUsing, saveUnit,
} from "../engine/courseUnits";
import type { UnitPackageImport } from "../storage/exchange";

interface Props {
  library: CourseLibrary;
  formulas: FormulaLike[];
  onClose: () => void;
  /** 保存（新建/修订）单位，失败时由本组件展示错误，App 不写入任何残缺数据 */
  onSaveUnit: (next: CourseLibrary) => void;
  /** 把勾选的公式从指定单位（某版本）显式迁移到最新版本 */
  onMigrateRevision: (unitId: string, toVersion: number, formulaIds: string[]) => void;
  /** 导入单位包：解析结果 + 用户决策 */
  onApplyImport: (decisions: Record<string, ConflictDecision>, migrateFormulas: Set<string>) => void;
  pendingPackage: UnitPackageImport | null;
  onPickPackageFile: () => void;
  onExportPackage: () => void;
}

const blankDraft: DraftInput = { name: "", label: "", factor: "1", definition: "", note: "" };

export default function UnitLibraryPanel({
  library, formulas, onClose, onSaveUnit, onMigrateRevision, onApplyImport, pendingPackage, onPickPackageFile, onExportPackage,
}: Props) {
  const [draft, setDraft] = useState<DraftInput>(blankDraft);
  const [formError, setFormError] = useState("");
  const [revisingId, setRevisingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  const startRevise = (u: CourseUnit) => {
    const last = u.versions[u.versions.length - 1];
    // 回显「用户填写的因子」= 总因子 / 依赖单位当前因子之积（保存时会重新按链累乘）
    let depProduct = 1;
    for (const [depId] of Object.entries(last.deps)) {
      const dep = library.units.find((x) => x.id === depId);
      if (dep) depProduct *= dep.versions[dep.versions.length - 1].factor;
    }
    const userFactor = last.factor / depProduct;
    setRevisingId(u.id);
    setDraft({
      id: u.id, name: u.name, label: u.label,
      factor: String(Number(userFactor.toPrecision(12))),
      definition: last.definition, note: last.note,
    });
    setFormError("");
  };

  const submit = () => {
    setFormError("");
    try {
      // 修订时强制使用被修订单位的现有 name（同名修订 → 新版本），不允许改名
      const payload = revisingId ? { ...draft, id: revisingId } : draft;
      const next = saveUnit(library, payload);
      onSaveUnit(next);
      const target = next.units.find((u) => u.id === (revisingId ?? payload.name));
      const ver = target?.versions.length;
      setNotice(revisingId ? `已生成新版本 v${ver}；旧公式仍绑定旧版本，需显式迁移才会改变。` : `已创建课程单位“${draft.name}”（v1）。`);
      setDraft(blankDraft);
      setRevisingId(null);
    } catch (e) {
      setFormError(e instanceof UnitDefinitionError ? e.message : `保存失败：${(e as Error).message}`);
    }
  };

  const resetForm = () => { setDraft(blankDraft); setRevisingId(null); setFormError(""); };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>课程单位库</h2>
          <button type="button" className="mini-btn" onClick={onClose}>关闭 ✕</button>
        </header>

        {pendingPackage && (
          <ImportConflictView
            pkg={pendingPackage}
            library={library}
            formulas={formulas}
            onCancel={onClose}
            onApply={(decisions, migrateFormulas) => { onApplyImport(decisions, migrateFormulas); }}
          />
        )}

        <div className="lib-toolbar">
          <button type="button" className="ghost" onClick={onPickPackageFile}>导入单位包…</button>
          <button type="button" className="ghost" onClick={onExportPackage} disabled={library.units.length === 0}>
            导出单位包…
          </button>
          <span className="muted small">导入同名但量纲/比例不同的单位时，可选择隔离、重命名或显式迁移。</span>
        </div>

        <div className="lib-form">
          <h3>{revisingId ? "修订单位（将生成新版本）" : "新建自定义单位"}</h3>
          {revisingId && (
            <div className="warn-text small">
              正在修订已有单位：保存后产生新版本，<strong>旧公式继续使用旧版本定义</strong>，不会被同名新定义重解释。
            </div>
          )}
          <div className="lib-form-grid">
            <label>单位名（英文，解析用）
              <input
                value={draft.name}
                placeholder="如 cfs"
                disabled={!!revisingId}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              />
            </label>
            <label>中文说明
              <input
                value={draft.label}
                placeholder="如 立方英尺每秒"
                onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
              />
            </label>
            <label>比例因子（1 本单位 = 因子 × 量纲）
              <input
                value={draft.factor}
                inputMode="decimal"
                placeholder="1"
                onChange={(e) => setDraft((d) => ({ ...d, factor: e.target.value }))}
              />
            </label>
            <label className="wide">复合量纲（已支持单位组成，可引用其他课程单位）
              <input
                value={draft.definition}
                placeholder="如 ft^3/s、m^3/s、1000 cfs"
                onChange={(e) => setDraft((d) => ({ ...d, definition: e.target.value }))}
              />
            </label>
            <label className="wide">备注（可选）
              <input
                value={draft.note ?? ""}
                placeholder="如 水工流量单位"
                onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))}
              />
            </label>
          </div>
          {formError && <div className="err-text small">{formError}</div>}
          <div className="lib-form-actions">
            <button type="button" onClick={submit}>{revisingId ? "保存为新版本" : "创建单位"}</button>
            {revisingId && <button type="button" className="ghost" onClick={resetForm}>取消修订</button>}
          </div>
          {notice && <div className="ok-text small">{notice}</div>}
        </div>

        <div className="lib-list">
          <h3>已定义单位（{library.units.length}）</h3>
          {library.units.length === 0 && <p className="muted small">还没有自定义单位。新建一个试试，例如 cfs = 1 × ft^3/s。</p>}
          {library.units.map((u) => (
            <UnitRow
              key={u.id}
              unit={u}
              formulas={formulas}
              expanded={expandedId === u.id}
              onToggle={() => setExpandedId((x) => (x === u.id ? null : u.id))}
              onRevise={() => startRevise(u)}
              onMigrate={(formulaIds) => onMigrateRevision(u.id, u.versions[u.versions.length - 1].version, formulaIds)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function UnitRow({
  unit, formulas, expanded, onToggle, onRevise, onMigrate,
}: {
  unit: CourseUnit;
  formulas: FormulaLike[];
  expanded: boolean;
  onToggle: () => void;
  onRevise: () => void;
  onMigrate: (formulaIds: string[]) => void;
}) {
  const last = unit.versions[unit.versions.length - 1];
  const usage = useMemo(() => formulasUsing(undefined as unknown as CourseLibrary, formulas, unit.id), [formulas, unit.id]);
  const totalRefs = usage.reduce((n, x) => n + x.locations.length, 0);
  // 只有存在「钉在旧版本」的公式时才需要迁移操作
  const oldVersionUsages = usage.filter((x) => x.version < last.version);
  const [checked, setChecked] = useState<Set<string>>(new Set());

  const toggleCheck = (fid: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(fid)) next.delete(fid); else next.add(fid);
      return next;
    });
  return (
    <div className={`lib-unit ${unit.scope ? "scoped" : ""}`}>
      <div className="lib-unit-head">
        <button type="button" className="collapse-btn" onClick={onToggle}>{expanded ? "▾" : "▸"}</button>
        <strong className="lib-unit-name">
          {unit.name}
          <span className="muted small"> {unit.label}</span>
        </strong>
        <span className="lib-unit-def" title="当前版本定义">
          = {last.factor} {last.baseUnit}
        </span>
        <span className="badge-version">v{last.version}{unit.versions.length > 1 ? `（共 ${unit.versions.length} 版）` : ""}</span>
        {unit.scope && <span className="badge-scope" title={unit.packageName}>隔离包</span>}
        {totalRefs > 0 && <span className="badge-use">{totalRefs} 处引用</span>}
        <button type="button" className="mini-btn" onClick={onRevise}>修订</button>
      </div>
      {expanded && (
        <div className="lib-unit-body">
          <div className="muted small">量纲签名 [{last.dimension.join(", ")}]</div>
          <details open>
            <summary className="small">版本历史（旧版本永久保留，公式按绑定版本解析）</summary>
            <ul className="version-list">
              {[...unit.versions].reverse().map((v) => (
                <li key={v.version}>
                  <code>v{v.version}</code>：1 {unit.name} = {v.factor} {v.baseUnit}
                  {v.definition !== v.baseUnit && <span className="muted small">（用户写法：{v.definition}）</span>}
                  {v.note && <span className="muted small"> — {v.note}</span>}
                  <span className="muted small"> {new Date(v.createdAt).toLocaleString()}</span>
                </li>
              ))}
            </ul>
          </details>
          <details>
            <summary className="small">受影响公式（{usage.length} 条{oldVersionUsages.length ? `，其中 ${oldVersionUsages.length} 条仍绑定旧版本` : ""}）</summary>
            {usage.length === 0 ? (
              <p className="muted small">当前没有公式引用该单位。</p>
            ) : (
              <>
                <ul className="usage-list">
                  {usage.map((x) => (
                    <li key={x.formulaId}>
                      {oldVersionUsages.some((o) => o.formulaId === x.formulaId) && (
                        <input
                          type="checkbox"
                          className="migrate-check"
                          data-formula={x.formulaId}
                          checked={checked.has(x.formulaId)}
                          onChange={() => toggleCheck(x.formulaId)}
                          style={{ marginRight: 6 }}
                        />
                      )}
                      {x.formulaNote || x.formulaId.slice(0, 10)}：{x.locations.join("；")}
                    </li>
                  ))}
                </ul>
                {oldVersionUsages.length > 0 && (
                  <div className="migrate-revision">
                    <button
                      type="button"
                      className="mini-btn"
                      disabled={checked.size === 0}
                      onClick={() => {
                        onMigrate([...checked]);
                        setChecked(new Set());
                      }}
                    >
                      将勾选的 {checked.size} 条公式迁移到最新 v{last.version}
                    </button>
                    <span className="muted small"> 未勾选的公式继续按原版本解析，历史结果不变。</span>
                  </div>
                )}
              </>
            )}
          </details>
        </div>
      )}
    </div>
  );
}

// ---------- 导入冲突决策视图 ----------

function ImportConflictView({
  pkg, library, formulas, onCancel, onApply,
}: {
  pkg: UnitPackageImport;
  library: CourseLibrary;
  formulas: FormulaLike[];
  onCancel: () => void;
  onApply: (decisions: Record<string, ConflictDecision>, migrateFormulas: Set<string>) => void;
}) {
  const [choices, setChoices] = useState<Record<string, ConflictDecision["action"]>>({});
  const [renameVals, setRenameVals] = useState<Record<string, string>>({});
  // 迁移模式下勾选的公式
  const [checked, setChecked] = useState<Record<string, Set<string>>>({});

  if (pkg.conflicts.length === 0) {
    return (
      <div className="conflict-box">
        <h3>导入「{pkg.packageName}」</h3>
        <p className="ok-text small">包内 {pkg.units.length} 个单位均无同名冲突，可直接导入为本地单位。</p>
        <div className="conflict-actions">
          <button type="button" onClick={() => onApply({}, new Set())}>确认导入</button>
          <button type="button" className="ghost" onClick={onCancel}>取消</button>
        </div>
      </div>
    );
  }

  const buildDecisions = (): Record<string, ConflictDecision> | null => {
    const out: Record<string, ConflictDecision> = {};
    for (const c of pkg.conflicts) {
      const action = choices[c.incoming.name] ?? "isolate";
      if (action === "rename") {
        const newName = (renameVals[c.incoming.name] ?? "").trim();
        if (!/^[A-Za-z][A-Za-z0-9]*$/.test(newName)) return null;
        if (library.units.some((u) => u.name === newName)) return null;
        out[c.incoming.name] = { action: "rename", newName };
      } else if (action === "isolate") {
        out[c.incoming.name] = { action: "isolate", scope: "" };
      } else {
        out[c.incoming.name] = { action: "migrate", scope: "" };
      }
    }
    return out;
  };

  const migrateLocations = new Set<string>();
  for (const c of pkg.conflicts) {
    if (choices[c.incoming.name] === "migrate") {
      const set = checked[c.existing.id] ?? new Set<string>();
      for (const f of set) migrateLocations.add(`${c.existing.id}:${f}`);
    }
  }

  return (
    <div className="conflict-box">
      <h3>导入「{pkg.packageName}」：{pkg.conflicts.length} 个同名单位需要选择</h3>
      {pkg.conflicts.map((c) => (
        <ConflictRow
          key={c.incoming.name}
          conflict={c}
          formulas={formulas}
          choice={choices[c.incoming.name] ?? "isolate"}
          renameVal={renameVals[c.incoming.name] ?? ""}
          checkedSet={checked[c.existing.id] ?? new Set<string>()}
          onChoice={(a) => setChoices((x) => ({ ...x, [c.incoming.name]: a }))}
          onRename={(v) => setRenameVals((x) => ({ ...x, [c.incoming.name]: v }))}
          onToggleFormula={(fid) =>
            setChecked((x) => {
              const prev = x[c.existing.id] ?? new Set<string>(defaultChecked(c, formulas));
              const next = new Set(prev);
              if (next.has(fid)) next.delete(fid); else next.add(fid);
              return { ...x, [c.existing.id]: next };
            })}
        />
      ))}
      <div className="conflict-actions">
        <button
          type="button"
          onClick={() => {
            const d = buildDecisions();
            if (!d) { alert("重命名需要填写合法且不重名的英文名（字母开头、字母数字）"); return; }
            onApply(d, migrateLocations);
          }}
        >
          按选择导入
        </button>
        <button type="button" className="ghost" onClick={onCancel}>取消</button>
      </div>
    </div>
  );
}

function defaultChecked(c: ImportConflict, formulas: FormulaLike[]): string[] {
  // 默认不勾选任何公式迁移：保证未显式迁移的公式继续解析旧版本
  void c; void formulas;
  return [];
}

function ConflictRow({
  conflict, formulas, choice, renameVal, checkedSet, onChoice, onRename, onToggleFormula,
}: {
  conflict: ImportConflict;
  formulas: FormulaLike[];
  choice: ConflictDecision["action"];
  renameVal: string;
  checkedSet: Set<string>;
  onChoice: (a: ConflictDecision["action"]) => void;
  onRename: (v: string) => void;
  onToggleFormula: (fid: string) => void;
}) {
  const c = conflict;
  const exv = c.existing.versions[c.existing.versions.length - 1];
  const sameDim = dimensionKey(exv.dimension) === dimensionKey(c.incoming.dimension);
  const usage = formulasUsing(undefined as unknown as CourseLibrary, formulas, c.existing.id);
  return (
    <div className="conflict-row">
      <div className="conflict-head">
        <strong>{c.incoming.name}</strong>{" "}
        <span className="muted small">{c.incoming.label}</span>
        <span className={sameDim ? "ok-text small" : "err-text small"}>
          {sameDim ? "量纲相同，比例不同" : "量纲不同！"}
        </span>
      </div>
      <div className="conflict-defs">
        <div>本地：1 {c.existing.name} = {exv.factor} {exv.baseUnit} <span className="muted small">[{exv.dimension.join(",")}]</span></div>
        <div>导入：1 {c.incoming.name} = {c.incoming.factor} {dimensionName(c.incoming.dimension)} <span className="muted small">[{c.incoming.dimension.join(",")}]</span></div>
      </div>
      <div className="conflict-options">
        <label><input type="radio" checked={choice === "isolate"} onChange={() => onChoice("isolate")} /> 隔离（保留两套，互不影响；新公式默认用本地版）</label>
        <label><input type="radio" checked={choice === "rename"} onChange={() => onChoice("rename")} /> 重命名导入为
          <input
            className="rename-input"
            value={renameVal}
            placeholder="如 cfsImp"
            onChange={(e) => { onChoice("rename"); onRename(e.target.value); }}
          />
        </label>
        <label><input type="radio" checked={choice === "migrate"} onChange={() => onChoice("migrate")} /> 显式迁移（勾选要改用导入定义的公式）</label>
      </div>
      {choice === "migrate" && (
        <div className="migrate-formulas">
          {usage.length === 0 ? (
            <p className="muted small">当前没有公式引用本地“{c.existing.name}”；迁移后新公式可直接选用导入定义。</p>
          ) : (
            <ul>
              {usage.map((u) => (
                <li key={u.formulaId}>
                  <label>
                    <input
                      type="checkbox"
                      checked={checkedSet.has(u.formulaId)}
                      onChange={() => onToggleFormula(u.formulaId)}
                    />
                    {u.formulaNote || u.formulaId.slice(0, 10)} — {u.locations.join("；")}
                  </label>
                </li>
              ))}
            </ul>
          )}
          <p className="muted small">未勾选的公式将继续按本地旧版本解析，历史计算值不变，刷新后仍然如此。</p>
        </div>
      )}
    </div>
  );
}

function dimensionName(dim: number[]): string {
  // 展示用：维度全 0 或信息不足时回退为量纲签名
  if (!dim.length) return "?";
  return `[${dim.join(",")}]`;
}

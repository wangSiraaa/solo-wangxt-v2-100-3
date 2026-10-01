// 课程单位库面板：定义/修订自定义单位，展示版本链与“仍绑定旧版本”的受影响公式。
import { useMemo, useState } from "react";
import type { UnitLibrary, DraftDef, UnitDefError, FormulaLike } from "../engine/courseUnits";
import {
  createUnit, latestVersion, reviseUnit, usagesOf, validateDef,
} from "../engine/courseUnits";

interface Props {
  library: UnitLibrary;
  formulas: FormulaLike[];
  onCommit: (next: UnitLibrary, description: string) => void;
  onMigrateOne: (formulaId: string, uid: string) => void;
  onMigrateAll: (uid: string) => void;
}

const EMPTY: DraftDef = { name: "", factor: 1, dimension: "", hint: "" };

export default function UnitLibraryPanel({ library, formulas, onCommit, onMigrateOne, onMigrateAll }: Props) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DraftDef>(EMPTY);
  const [editingUid, setEditingUid] = useState<string | null>(null);
  const [error, setError] = useState<string>("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // 实时校验预览（不写库）
  const live = useMemo(() => {
    if (!draft.name.trim() && !draft.dimension.trim()) return { ok: false as const, text: "填写名称、比例因子与复合量纲后保存" };
    try {
      validateDef(draft, library, editingUid ?? undefined);
      const d = `${draft.factor}${draft.dimension.trim() ? ` ${draft.dimension.trim()}` : "（无量纲）"}`;
      return { ok: true as const, text: `将定义：1 ${draft.name.trim()} = ${d}` };
    } catch (e) {
      return { ok: false as const, text: (e as UnitDefError).message };
    }
  }, [draft, library, editingUid]);

  const startCreate = () => { setEditingUid(null); setDraft(EMPTY); setError(""); };
  const startRevise = (uid: string) => {
    const u = library.units.find((x) => x.uid === uid)!;
    const v = latestVersion(u);
    setEditingUid(uid);
    setDraft({ name: v.name, factor: v.factor, dimension: v.dimension, hint: v.hint ?? "" });
    setError("");
    setExpanded((s) => new Set(s).add(uid));
  };

  const save = () => {
    try {
      if (editingUid) {
        const next = reviseUnit(library, editingUid, draft);
        const u = next.units.find((x) => x.uid === editingUid)!;
        onCommit(next, `单位“${latestVersion(u).name}”已生成 v${latestVersion(u).version}；旧公式仍按原版本计算，需显式迁移才会采用新版本`);
      } else {
        const next = createUnit(library, draft);
        const u = next.units[next.units.length - 1];
        onCommit(next, `已创建课程单位“${latestVersion(u).name}”（v1）`);
      }
      setDraft(EMPTY);
      setEditingUid(null);
      setError("");
    } catch (e) {
      // 保存失败：不产生任何写入，已有单位不受影响
      setError((e as Error).message);
    }
  };

  const toggle = (uid: string) => setExpanded((s) => {
    const next = new Set(s);
    if (next.has(uid)) next.delete(uid); else next.add(uid);
    return next;
  });

  return (
    <section className="unit-lib">
      <header className="unit-lib-head">
        <button type="button" className="ghost" onClick={() => { setOpen((o) => !o); if (!open) startCreate(); }}>
          {open ? "▾ 收起课程单位库" : "▸ 课程单位库"}
        </button>
        <span className="muted small">
          自定义单位带稳定标识与不可变版本；修订只生成新版本，旧公式继续解析旧定义
        </span>
      </header>

      {open && (
        <div className="unit-lib-body">
          <div className="unit-form">
            <div className="unit-form-row">
              <label>
                单位名
                <input
                  value={draft.name}
                  placeholder="如 cfs、ksi、percent"
                  onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                />
              </label>
              <label>
                比例因子（正）
                <input
                  inputMode="decimal"
                  value={String(draft.factor)}
                  onChange={(e) => setDraft((d) => ({ ...d, factor: Number(e.target.value) }))}
                />
              </label>
            </div>
            <label>
              复合量纲（由已支持单位/课程单位组合；空 = 无量纲比例）
              <input
                value={draft.dimension}
                placeholder="如 m^3/s、Pa*1000、kg/m^3、m^3/s（可用 / * ^）"
                onChange={(e) => setDraft((d) => ({ ...d, dimension: e.target.value }))}
              />
            </label>
            <label>
              说明（可选）
              <input
                value={draft.hint ?? ""}
                placeholder="如 立方英尺每秒"
                onChange={(e) => setDraft((d) => ({ ...d, hint: e.target.value }))}
              />
            </label>
            <div className="unit-form-actions">
              <button type="button" onClick={save} disabled={!live.ok}>
                {editingUid ? "生成新版本（不改旧版本）" : "保存新单位"}
              </button>
              {editingUid && (
                <button type="button" className="ghost" onClick={startCreate}>取消修订（新建）</button>
              )}
              <span className={live.ok ? "hint-ok small" : "hint-warn small"}>{live.text}</span>
              {error && <span className="err-text small">保存被拒绝：{error}</span>}
            </div>
            <p className="muted small">
              规则：不允许自引用或 A→B→A 循环、不允许引用未知单位、不允许 degC/degF 等带偏移温标进入定义链（请用 K）。
            </p>
          </div>

          <ul className="unit-list">
            {library.units.length === 0 && (
              <li className="muted small">还没有课程单位。用上方表单创建，例如 <code>cfs</code> = 0.028316846592 × <code>m^3/s</code>。</li>
            )}
            {library.units.map((u) => {
              const lv = latestVersion(u);
              const oldUsages = usagesOf(formulas, u.uid, true, library);
              const allUsages = usagesOf(formulas, u.uid);
              const isOpen = expanded.has(u.uid);
              return (
                <li key={u.uid} className="unit-item">
                  <div className="unit-item-head">
                    <button type="button" className="link-btn" onClick={() => toggle(u.uid)}>
                      {isOpen ? "▾" : "▸"} <strong>{lv.name}</strong>
                      <span className="muted small"> v{lv.version}</span>
                    </button>
                    <span className="muted small" title="稳定标识（跨版本不变）">{u.uid}</span>
                    <span className="muted small">
                      = {lv.factor}{lv.dimension ? ` ${lv.dimension}` : "（无量纲）"}
                    </span>
                    {lv.hint && <span className="muted small">{lv.hint}</span>}
                    <button type="button" className="mini-btn" onClick={() => startRevise(u.uid)}>修订出新版本</button>
                  </div>
                  {allUsages.length > 0 && (
                    <div className="unit-usage small">
                      {oldUsages.length > 0 ? (
                        <>
                          <span className="warn-text">
                            {oldUsages.length} 处引用仍绑定旧版本（不会被新定义重解释）：
                          </span>
                          <ul className="usage-list">
                            {oldUsages.map((use, i) => (
                              <li key={i}>
                                公式“{use.formulaNote || use.formulaId}”
                                的{use.where === "target" ? "结果目标单位" : `变量 ${use.varName}`}
                                → {use.ref.name} v{use.ref.version}
                                <button type="button" className="mini-btn" onClick={() => onMigrateOne(use.formulaId, u.uid)}>
                                  迁移此公式
                                </button>
                              </li>
                            ))}
                          </ul>
                          <button type="button" className="mini-btn" onClick={() => onMigrateAll(u.uid)}>
                            全部迁移到 v{lv.version}
                          </button>
                        </>
                      ) : (
                        <span className="muted">全部 {allUsages.length} 处引用均在最新版本。</span>
                      )}
                    </div>
                  )}
                  {isOpen && (
                    <ul className="version-list">
                      {[...u.versions].reverse().map((v) => (
                        <li key={v.version} className={v.version === lv.version ? "ver-latest" : "ver-old"}>
                          <code>v{v.version}</code>
                          {" "}{v.name} = {v.factor}{v.dimension ? ` ${v.dimension}` : "（无量纲）"}
                          <span className="muted"> · {new Date(v.createdAt).toLocaleString()}</span>
                          {v.version !== lv.version && <span className="muted">（旧版本仍可被旧公式解析）</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}

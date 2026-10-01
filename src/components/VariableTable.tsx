// 变量赋值区：自动列出公式中出现的变量，填写数值与单位。
// 单位可选择课程单位的具体版本；选择后生成 UnitRef 锁定定义，公式不会被后续修订重解释。
import type { VariableDef } from "../engine/types";
import type { UnitLibrary, UnitRef } from "../engine/courseUnits";
import { findVersion, latestVersion } from "../engine/courseUnits";

interface Props {
  /** 公式中识别到的变量名 */
  names: string[];
  value: Record<string, VariableDef>;
  onChange: (next: Record<string, VariableDef>) => void;
  /** 课程单位库快照 */
  library: UnitLibrary;
  /** 手动把某变量的单位绑定到指定单位版本 */
  onBindUnit: (varName: string, ref: UnitRef | undefined) => void;
}

export default function VariableTable({ names, value, onChange, library, onBindUnit }: Props) {
  // 用户曾经定义、但当前公式里已不存在的变量也暂时保留（切换公式文本时不丢输入）
  const extra = Object.keys(value).filter((k) => !names.includes(k));
  const rows = [...names, ...extra];

  if (rows.length === 0) {
    return <p className="muted small">该公式中没有需要赋值的变量（只有数字和 π 等常量）。</p>;
  }

  const set = (name: string, patch: Partial<VariableDef>) => {
    const prev = value[name] ?? { value: "", unit: "" };
    onChange({ ...value, [name]: { ...prev, ...patch } });
  };

  const customUnits = library.units.map((u) => ({ uid: u.uid, v: latestVersion(u) }));

  const bindStatus = (def: VariableDef): { text: string; outdated: boolean } | null => {
    const r = def.unitRef;
    if (!r) return null;
    const bound = findVersion(library, r.uid, r.version);
    if (!bound) return { text: `绑定的定义 v${r.version} 已缺失（按错误处理，不会静默改用其他定义）`, outdated: true };
    const latest = latestVersion(library.units.find((u) => u.uid === r.uid)!);
    if (r.version < latest.version) {
      return { text: `绑定旧版 v${r.version}（最新 v${latest.version}）`, outdated: true };
    }
    return { text: `v${r.version}`, outdated: false };
  };

  return (
    <div className="var-table">
      <div className="var-row var-head">
        <span>变量</span><span>数值</span><span>单位（留空 = 纯数）</span><span />
      </div>
      {rows.map((name) => {
        const def = value[name] ?? { value: "", unit: "" };
        const ghost = extra.includes(name);
        const status = bindStatus(def);
        return (
          <div className={`var-row ${ghost ? "ghost" : ""}`} key={name}>
            <span className="var-name" title={ghost ? "当前公式未引用该变量" : undefined}>{name}</span>
            <input
              className="num-input"
              inputMode="decimal"
              placeholder="如 9.81"
              value={def.value}
              onChange={(e) => set(name, { value: e.target.value })}
            />
            <span className="unit-cell">
              <input
                className="unit-input"
                list="unit-suggestions"
                placeholder="如 m/s^2"
                value={def.unit}
                onChange={(e) => {
                  const text = e.target.value;
                  // 手动改文本：若恰好等于某课程单位最新显示名则自动绑定，否则解除绑定走自由解析
                  const match = customUnits.find((c) => c.v.name === text.trim());
                  set(name, { unit: text, unitRef: match ? { uid: match.uid, version: match.v.version, name: match.v.name } : undefined });
                }}
              />
              <select
                className="unit-version-select"
                value={def.unitRef ? `${def.unitRef.uid}@${def.unitRef.version}` : ""}
                onChange={(e) => {
                  const key = e.target.value;
                  if (!key) { onBindUnit(name, undefined); return; }
                  const [uid, ver] = key.split("@");
                  const v = findVersion(library, uid, Number(ver));
                  if (v) onBindUnit(name, { uid, version: v.version, name: v.name });
                }}
                title="选择课程单位版本（选择后锁定定义）"
              >
                <option value="">课程单位…</option>
                {library.units.map((u) =>
                  u.versions.map((v) => (
                    <option key={`${u.uid}@${v.version}`} value={`${u.uid}@${v.version}`}>
                      {v.name} v{v.version}{v.version === latestVersion(u).version ? "（最新）" : ""}
                    </option>
                  )),
                )}
              </select>
              {status && (
                <span className={`bind-tag ${status.outdated ? "outdated" : "current"}`} title={def.unitRef?.migratedFrom
                  ? `由 ${def.unitRef.migratedFrom.name ?? def.unitRef.migratedFrom.uid} v${def.unitRef.migratedFrom.version} 显式迁移而来`
                  : "该变量锁定此定义版本"}>
                  {status.text}
                  {def.unitRef?.migratedFrom && <span className="migrated-dot" title="显式迁移">⇄</span>}
                </span>
              )}
            </span>
            {ghost && (
              <button
                type="button"
                className="mini-btn"
                title="删除未引用的变量"
                onClick={() => {
                  const next = { ...value };
                  delete next[name];
                  onChange(next);
                }}
              >
                ×
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

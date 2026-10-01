// 单位包导入冲突对话框：同名（可能不同量纲/定义）时，由用户选择隔离、重命名或显式迁移。
import { useState } from "react";
import type { UnitConflict } from "../storage/exchange";
import { latestVersion } from "../engine/courseUnits";

interface Props {
  conflicts: UnitConflict[];
  onChange: (index: number, resolution: UnitConflict["resolution"]) => void;
  onCancel: () => void;
  onConfirm: () => void;
}

export default function ImportConflictDialog({ conflicts, onChange, onCancel, onConfirm }: Props) {
  const [showFormulas, setShowFormulas] = useState<number | null>(null);
  const allResolved = conflicts.every((c) => c.resolution);

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal">
        <h2>导入单位包：{conflicts.length} 个同名冲突</h2>
        <p className="muted small">
          同名单位的量纲或定义与本地不同。每个冲突都需要你决定处理方式；
          <strong>未迁移的公式将继续按原版本解析，不会被同名新定义悄悄重解释。</strong>
        </p>

        <div className="conflict-list">
          {conflicts.map((c, i) => {
            const inV = latestVersion(c.incoming);
            const localV = latestVersion(c.local);
            const res = c.resolution?.action;
            return (
              <fieldset key={c.incoming.uid} className="conflict-item">
                <legend>
                  <strong>{inV.name}</strong>
                  <span className={c.sameDimension ? "muted" : "warn-text"}>
                    {c.sameDimension ? "（量纲相同，定义/比例不同）" : "（量纲不同！）"}
                  </span>
                </legend>
                <div className="conflict-grid">
                  <div>
                    <div className="small">包内版本 v{inV.version}</div>
                    <code>= {inV.factor} {inV.dimension || "（无量纲）"}</code>
                  </div>
                  <div>
                    <div className="small">本地最新 v{localV.version}</div>
                    <code>= {localV.factor} {localV.dimension || "（无量纲）"}</code>
                  </div>
                </div>

                <div className="conflict-actions">
                  <label className={res === "isolate" ? "chosen" : ""}>
                    <input
                      type="radio"
                      name={`conf-${i}`}
                      checked={res === "isolate"}
                      onChange={() => onChange(i, { action: "isolate" })}
                    />
                    隔离：两个定义并存，包内公式继续用包内定义
                  </label>
                  <label className={res === "rename" ? "chosen" : ""}>
                    <input
                      type="radio"
                      name={`conf-${i}`}
                      checked={res === "rename"}
                      onChange={() => onChange(i, { action: "rename", newName: `${inV.name}2` })}
                    />
                    重命名为
                    <input
                      className="rename-input"
                      value={res === "rename" ? (c.resolution as { newName: string }).newName : ""}
                      disabled={res !== "rename"}
                      onChange={(e) => onChange(i, { action: "rename", newName: e.target.value })}
                    />
                  </label>
                  <label className={res === "migrate" ? "chosen" : ""}>
                    <input
                      type="radio"
                      name={`conf-${i}`}
                      checked={res === "migrate"}
                      onChange={() => onChange(i, { action: "migrate", toUid: c.local.uid })}
                    />
                    显式迁移：包内公式改用本地“{localV.name} v{localV.version}”（保留迁移记录）
                  </label>
                </div>

                {c.incomingFormulas.length > 0 && (
                  <div className="affected-formulas">
                    <button
                      type="button"
                      className="link-btn small"
                      onClick={() => setShowFormulas(showFormulas === i ? null : i)}
                    >
                      {showFormulas === i ? "▾" : "▸"} 包内 {c.incomingFormulas.length} 处公式引用受影响
                    </button>
                    {showFormulas === i && (
                      <ul className="usage-list">
                        {c.incomingFormulas.map((f, j) => (
                          <li key={j} className="small">
                            公式“{f.note}”的{f.where === "target" ? "结果目标单位" : `变量 ${f.variable}`}
                            → {inV.name} v{f.version}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </fieldset>
            );
          })}
        </div>

        <div className="modal-actions">
          <button type="button" disabled={!allResolved} onClick={onConfirm}>
            按所选方式导入
          </button>
          <button type="button" className="ghost" onClick={onCancel}>取消</button>
          {!allResolved && <span className="muted small">还有冲突未做选择</span>}
        </div>
      </div>
    </div>
  );
}

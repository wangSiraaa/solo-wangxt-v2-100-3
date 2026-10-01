// 单条公式卡片：输入、变量赋值、原式/替换式/结果三段展示、问题定位
import { useMemo, useState } from "react";
import type { Formula, VariableDef } from "../engine/types";
import { analyzeFormula } from "../engine/math";
import { buildUnitContext, findVersion, latestVersion, type UnitLibrary, type UnitRef } from "../engine/courseUnits";
import MathInput from "./MathInput";
import Tex from "./Tex";
import VariableTable from "./VariableTable";

interface Props {
  formula: Formula;
  index: number;
  library: UnitLibrary;
  onChange: (patch: Partial<Formula>) => void;
  onDelete: () => void;
  onMigrateAll: (formulaId: string) => void;
}

const STATUS_META = {
  ok: { label: "已验证", cls: "ok" },
  unverified: { label: "未验证", cls: "warn" },
  error: { label: "有错误", cls: "err" },
  empty: { label: "空公式", cls: "empty" },
} as const;

export default function FormulaCard({ formula, index, library, onChange, onDelete, onMigrateAll }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  // 库快照编译为版本化解析上下文（新旧版本同名共存，旧公式解析旧定义）
  const ctx = useMemo(() => buildUnitContext(library), [library]);
  const result = useMemo(
    () => analyzeFormula(formula.latex, formula.variables, formula.targetUnit, {
      units: ctx, targetRef: formula.targetUnitRef,
    }),
    [formula.latex, formula.variables, formula.targetUnit, formula.targetUnitRef, ctx],
  );
  const meta = STATUS_META[result.status];

  const setVars = (variables: Record<string, VariableDef>) => onChange({ variables });

  // 该公式中所有“绑定到旧版本”的单位（变量 + 目标单位）
  const outdatedRefs = useMemo(() => {
    const out: { label: string; name: string; from: number; to: number }[] = [];
    for (const [name, v] of Object.entries(formula.variables)) {
      const r = v.unitRef;
      if (r) {
        const u = library.units.find((x) => x.uid === r.uid);
        if (u && r.version < latestVersion(u).version) {
          out.push({ label: `变量 ${name}`, name: latestVersion(u).name, from: r.version, to: latestVersion(u).version });
        }
      }
    }
    const t = formula.targetUnitRef;
    if (t) {
      const u = library.units.find((x) => x.uid === t.uid);
      if (u && t.version < latestVersion(u).version) {
        out.push({ label: "结果目标单位", name: latestVersion(u).name, from: t.version, to: latestVersion(u).version });
      }
    }
    return out;
  }, [formula.variables, formula.targetUnitRef, library]);

  const bindVar = (varName: string, ref: UnitRef | undefined) => {
    const prev = formula.variables[varName] ?? { value: "", unit: "" };
    if (!ref) {
      onChange({ variables: { ...formula.variables, [varName]: { ...prev, unitRef: undefined } } });
      return;
    }
    onChange({
      variables: {
        ...formula.variables,
        [varName]: { ...prev, unit: ref.name ?? prev.unit, unitRef: ref },
      },
    });
  };

  const targetStatus = (() => {
    const r = formula.targetUnitRef;
    if (!r) return null;
    const v = findVersion(library, r.uid, r.version);
    if (!v) return { text: `v${r.version} 定义缺失`, outdated: true };
    const lv = latestVersion(library.units.find((u) => u.uid === r.uid)!);
    return { text: `绑定 v${r.version}${r.version < lv.version ? `（最新 v${lv.version}）` : ""}`, outdated: r.version < lv.version };
  })();

  return (
    <section className={`card status-${meta.cls}`}>
      <header className="card-head">
        <button type="button" className="collapse-btn" onClick={() => setCollapsed((c) => !c)}>
          {collapsed ? "▸" : "▾"}
        </button>
        <strong>公式 {index + 1}</strong>
        <span className={`badge ${meta.cls}`}>{meta.label}</span>
        <span className="summary">{result.summary}</span>
        <button type="button" className="mini-btn danger" onClick={onDelete} title="删除此公式（不影响其他公式）">
          删除
        </button>
      </header>

      {!collapsed && (
        <div className="card-body">
          {outdatedRefs.length > 0 && (
            <div className="outdated-banner">
              本公式有 {outdatedRefs.length} 处仍绑定单位旧版本
              （{outdatedRefs.map((r) => `${r.label} ${r.name} v${r.from}→v${r.to}`).join("；")}）：
              旧计算保持原值，
              <button type="button" className="mini-btn" onClick={() => onMigrateAll(formula.id)}>
                显式迁移到最新版本
              </button>
            </div>
          )}

          <label className="field-label">
            输入表达式（支持 + − × ÷、幂、分数、括号；变量用字母或下标，如 <code>v</code>、<code>x_1</code>、<code>θ</code>）
            <MathInput
              value={formula.latex}
              onChange={(latex) => onChange({ latex })}
              placeholder="例如  v \cdot t + \frac{1}{2} a t^2"
            />
          </label>

          <div className="grid-2">
            <div>
              <div className="field-label">变量赋值</div>
              <VariableTable
                names={result.variables}
                value={formula.variables}
                onChange={setVars}
                library={library}
                onBindUnit={bindVar}
              />
            </div>
            <div>
              <label className="field-label">
                结果目标单位（可选；可用内置单位或课程单位，如 K、degF、cfs）
                <span className="target-unit-row">
                  <input
                    className="unit-result-input"
                    list="unit-suggestions"
                    value={formula.targetUnit}
                    placeholder="自动（保留计算单位）"
                    onChange={(e) => {
                      const text = e.target.value;
                      const match = library.units.find((u) => latestVersion(u).name === text.trim());
                      onChange({
                        targetUnit: text,
                        targetUnitRef: match
                          ? { uid: match.uid, version: latestVersion(match).version, name: latestVersion(match).name }
                          : undefined,
                      });
                    }}
                  />
                  <select
                    className="unit-version-select"
                    value={formula.targetUnitRef ? `${formula.targetUnitRef.uid}@${formula.targetUnitRef.version}` : ""}
                    onChange={(e) => {
                      const key = e.target.value;
                      if (!key) { onChange({ targetUnitRef: undefined }); return; }
                      const [uid, ver] = key.split("@");
                      const v = findVersion(library, uid, Number(ver));
                      if (v) onChange({ targetUnit: v.name, targetUnitRef: { uid, version: v.version, name: v.name } });
                    }}
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
                </span>
                {targetStatus && (
                  <span className={`bind-tag ${targetStatus.outdated ? "outdated" : "current"}`}>
                    {targetStatus.text}
                    {formula.targetUnitRef?.migratedFrom && <span title="显式迁移"> ⇄ 由 v{formula.targetUnitRef.migratedFrom.version} 迁移</span>}
                  </span>
                )}
              </label>
              <label className="field-label">
                备注
                <input
                  value={formula.note}
                  placeholder="例如：自由落体位移"
                  onChange={(e) => onChange({ note: e.target.value })}
                />
              </label>
            </div>
          </div>

          {result.source !== undefined && (
            <div className="display-area">
              <div className="display-row">
                <span className="row-tag">原式</span>
                <div className="tex-box">{result.originalTex ? <Tex tex={result.originalTex} /> : <span className="muted">—</span>}</div>
              </div>
              <div className="display-row">
                <span className="row-tag">代入后计算式</span>
                <div className="tex-box">
                  {result.substitutedTex ? (
                    <>
                      <Tex tex={result.substitutedTex} />
                      {result.status !== "ok" && (
                        <span className="muted small">（未赋值或出错处保留符号）</span>
                      )}
                    </>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </div>
              </div>
              <div className="display-row result-row">
                <span className="row-tag">结果</span>
                <div className="tex-box">
                  {result.status === "ok" || result.status === "unverified" ? (
                    <div>
                      {result.value !== undefined && (
                        <div className="result-line">
                          <Tex tex={`= ${fmt(result.value)}${result.resultUnit ? `~${toTexUnit(result.resultUnit)}` : ""}`} />
                        </div>
                      )}
                      {result.targetValue !== undefined && (
                        <div className="result-line converted">
                          <Tex tex={`= ${fmt(result.targetValue)}~${toTexUnit(result.targetUnit ?? "")}`} />
                          <span className="muted small">（按目标单位换算）</span>
                        </div>
                      )}
                      {result.status === "unverified" && <div className="warn-text">{result.summary}</div>}
                    </div>
                  ) : (
                    <span className="err-text">{result.summary}</span>
                  )}
                </div>
              </div>
            </div>
          )}

          {result.issues.length > 0 && (
            <ul className="issue-list">
              {result.issues.map((iss, i) => (
                <li key={i} className={`issue ${iss.kind}`}>
                  <span className={`dot ${iss.kind}`} />
                  <span className="issue-kind">{iss.kind === "error" ? "错误" : "未验证"}</span>
                  <span className="issue-msg">{iss.message}</span>
                  <span className="issue-snippet">
                    定位：<Tex tex={iss.snippet || "·"} block={false} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

function fmt(n: number | undefined): string {
  if (n === undefined) return "";
  if (!Number.isFinite(n)) return String(n);
  // 截断浮点尾零，科学计数法用 TeX 指数
  const abs = Math.abs(n);
  if (abs !== 0 && (abs >= 1e7 || abs < 1e-4)) {
    const [m, e] = n.toExponential(6).split("e");
    return `${m.replace(/\.?0+$/, "")}\\times10^{${Number(e)}}`;
  }
  return String(Number(n.toFixed(10)));
}

// mathjs 单位文本（m / s^2，可能含课程单位名）→ 简单 TeX
function toTexUnit(unit: string): string {
  if (!unit) return "";
  const parts = unit.split(/\s*\/\s*/);
  const encode = (seg: string) =>
    seg.split(/\s+/).map((factor) => {
      const pow = factor.split("^");
      const base = `\\mathrm{${pow[0]}}`;
      return pow.length > 1 ? `${base}^{${pow[1]}}` : base;
    }).join("\\,");
  if (parts.length === 1) return encode(parts[0]);
  return `${encode(parts[0])}/${parts.slice(1).map(encode).join("/")}`;
}

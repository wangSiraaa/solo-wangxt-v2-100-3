import { useMemo } from "react";
import { ALL_UNITS } from "../engine/units";
import type { CourseLibrary } from "../engine/courseUnits";

/** 全局单位自动补全列表（input[list="unit-suggestions"]）
 *  内置单位 + 当前课程单位库中的自定义单位（显示名 + 版本数提示） */
export default function UnitSuggestions({ library }: { library: CourseLibrary }) {
  const courseOptions = useMemo(
    () => library.units
      .filter((u) => !u.deprecated)
      .map((u) => {
        const vCount = u.versions.length;
        const latest = u.versions[vCount - 1];
        return {
          name: u.name,
          hint: `${u.label}（课程单位 v${vCount}${u.scope ? "·导入" : ""} = ${latest.factor} ${latest.baseUnit}）`,
        };
      }),
    [library],
  );
  return (
    <datalist id="unit-suggestions">
      {ALL_UNITS.map((u) => (
        <option key={u.name} value={u.name}>{u.hint}</option>
      ))}
      {courseOptions.map((u) => (
        <option key={`cu-${u.name}`} value={u.name}>{u.hint}</option>
      ))}
    </datalist>
  );
}

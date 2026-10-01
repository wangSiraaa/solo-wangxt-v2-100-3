import { ALL_UNITS } from "../engine/units";
import type { UnitLibrary } from "../engine/courseUnits";
import { latestVersion } from "../engine/courseUnits";

interface Props {
  library: UnitLibrary;
}

/** 全局单位自动补全列表（input[list="unit-suggestions"]）：内置单位 + 课程单位最新版本 */
export default function UnitSuggestions({ library }: Props) {
  const custom = library.units.map((u) => {
    const v = latestVersion(u);
    return { name: v.name, hint: `课程单位 v${v.version}${v.hint ? `：${v.hint}` : ""}` };
  });
  const seen = new Set<string>();
  const options = [...ALL_UNITS, ...custom].filter((u) => {
    if (seen.has(u.name)) return false;
    seen.add(u.name);
    return true;
  });
  return (
    <datalist id="unit-suggestions">
      {options.map((u) => (
        <option key={u.name} value={u.name}>{u.hint}</option>
      ))}
    </datalist>
  );
}

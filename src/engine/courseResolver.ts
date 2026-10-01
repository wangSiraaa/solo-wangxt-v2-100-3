// 课程单位 → mathjs 解析桥：
// 每个课程单位版本注册成 mathjs 内部别名（显示名与版本无关），
// 解析单位文本时把课程单位裸名替换为「该公式字段钉住版本」对应的别名。
// 旧公式继续解析旧版本；同名新定义不会重解释历史绑定。

import {
  type CourseLibrary, type CourseUnit, type CourseUnitVersion,
  getUnit, isBuiltinName, UNIT_NAME_RE,
} from "./courseUnits";
import type { UnitRef } from "./types";
import { math as sharedMath } from "./mathInstance";

/** 解析失败（未知单位等） */
export class UnitResolveError extends Error {}

/** 已注册的 mathjs 内部别名 */
interface Registered {
  alias: string;
  unit: CourseUnit;
  version: CourseUnitVersion;
}

// 全局注册表：mathjs 实例在整个会话内共享，别名必须全局唯一、跨 resolver 复用。
// 键是「单位 id@版本」——即使两个版本因子相同也各自独立，杜绝同名异义串味。
const globalRegistry = new Map<string, string>(); // id@version → alias
let aliasSeq = 0;
function makeAlias(): string {
  // mathjs 单位名只允许字母数字
  aliasSeq += 1;
  return `cualias${aliasSeq.toString(36)}`;
}

/**
 * 课程单位解析器。生命周期 = 一次库快照；库修订后用新库重建。
 */
export class CourseUnitResolver {
  private byRef = new Map<string, Registered>(); // id@version → 注册信息

  constructor(private lib: CourseLibrary) {}

  private refKey(id: string, version: number): string { return `${id}@${version}`; }

  /** 注册（或取全局缓存）某个钉住版本，返回 mathjs 内部别名 */
  register(ref: Pick<UnitRef, "id" | "version">): Registered {
    const key = this.refKey(ref.id, ref.version);
    const cached = this.byRef.get(key);
    if (cached) return cached;

    const unit = this.lib.units.find((u) => u.id === ref.id);
    const ver = getUnit(this.lib, ref);
    if (!unit || !ver) {
      throw new UnitResolveError(`单位定义版本缺失：${ref.id} v${ref.version}（可能来自已删除的单位包）`);
    }

    let alias = globalRegistry.get(key);
    if (!alias) {
      alias = makeAlias();
      try {
        sharedMath.createUnit(alias, { definition: `${ver.factor} ${ver.baseUnit}` });
      } catch (e) {
        throw new UnitResolveError(`课程单位 ${unit.name} v${ver.version} 无法注册：${(e as Error).message}`);
      }
      globalRegistry.set(key, alias);
    }
    const reg = { alias, unit, version: ver };
    this.byRef.set(key, reg);
    return reg;
  }

  /** 当前库快照 */
  get library(): CourseLibrary { return this.lib; }

  /**
   * 把求值结果规范化为「自洽的数值 + 用户可见单位」。
   * mathjs 的 toString 会保留输入数字前缀（如 "10 cfs"），对自定义单位显示不直观；
   * 这里在结果量纲与某个已注册课程单位版本量纲一致时，换算到该单位表示。
   * 输入：mathjs 原始 Unit；输出：SI 数值/规范单位（交由 prettify 改名）。
   */
  toCoherent(q: import("mathjs").Unit): { value: number; unit: string } {
    // 找量纲匹配的「首选单位」：优先结果单位中出现的自定义别名，其次直接 SI 规范表示
    const names = q.formatUnits();
    for (const reg of this.byRef.values()) {
      if (names.includes(reg.alias)) {
        try {
          const one = sharedMath.unit(`1 ${reg.alias}`);
          if (one.equalBase(q)) {
            const converted = q.to(reg.alias);
            return { value: converted.value / one.value, unit: reg.alias };
          }
        } catch { /* 忽略，尝试下一个 */ }
      }
    }
    // 无自定义单位：交给调用方用默认 splitQuantity
    return { value: Number.NaN, unit: "" };
  }

  /**
   * 解析一个单位输入文本（变量单位 / 结果目标单位）。
   * @param text       用户填写的裸文本，如 cfs、m/s、cfs/s
   * @param pinnedRefs 该字段已保存的版本绑定；其中名字匹配的继续钉住旧版
   * @param preferredScope 未钉住的裸名解析时，优先选择的隔离命名空间（默认本地优先）
   * @returns 供 math.unit() 使用的文本 + 本次实际绑定列表（课程单位才出现）
   */
  resolve(text: string, pinnedRefs?: UnitRef[], preferredScope?: string): { expression: string; refs: UnitRef[] } {
    const trimmed = text.trim();
    if (!trimmed) return { expression: trimmed, refs: [] };

    const names = trimmed.match(/[A-Za-z][A-Za-z0-9]*/g) ?? [];
    const customNames = [...new Set(names.filter((n) => !isBuiltinName(n)))];
    if (customNames.length === 0) {
      return { expression: trimmed, refs: [] };
    }

    let expression = trimmed;
    const refs: UnitRef[] = [];

    for (const name of customNames) {
      let picked: { unit: CourseUnit; ver: CourseUnitVersion } | undefined;

      const pinned = pinnedRefs?.find((r) => r.name === name);
      if (pinned) {
        // 钉住历史版本：旧公式必须继续解析旧定义
        const unit = this.lib.units.find((u) => u.id === pinned.id);
        const ver = unit?.versions.find((v) => v.version === pinned.version);
        if (unit && ver) picked = { unit, ver };
      }
      if (!picked) {
        // 未钉住：按裸名解析当前版本。优先级：
        //   1) 公式声明偏好的隔离包；2) 本地单位；3) 其他隔离包（取最新）
        const matches = this.lib.units.filter((u) => !u.deprecated && u.name === name);
        const preferred = preferredScope
          ? matches.find((u) => u.scope === preferredScope)
          : undefined;
        const local = matches.find((u) => !u.scope);
        const chosen = preferred ?? local ?? matches[matches.length - 1];
        if (chosen) picked = { unit: chosen, ver: chosen.versions[chosen.versions.length - 1] };
      }
      if (!picked) {
        throw new UnitResolveError(`单位“${name}”无法识别：不是内置单位，课程单位库中也没有该名称`);
      }

      const reg = this.register({ id: picked.unit.id, version: picked.ver.version });
      expression = expression.replace(new RegExp(`\\b${name}\\b`, "g"), reg.alias);
      refs.push({
        id: picked.unit.id,
        version: picked.ver.version,
        name: picked.unit.name,
        origin: picked.unit.origin,
        scope: picked.unit.scope,
      });
    }
    return { expression, refs };
  }

  /** 把 mathjs 输出中的内部别名还原成用户可见的单位名（普通字符串） */
  prettify(text: string): string {
    let out = text;
    for (const reg of this.byRef.values()) {
      out = out.split(reg.alias).join(reg.unit.name);
    }
    return out.replace(/\s+/g, " ").trim();
  }

  /** TeX 中别名还原（mathjs 会把单位名包进 \mathrm{}，直接整体替换别名即可） */
  prettifyTex(tex: string): string {
    let out = tex;
    for (const reg of this.byRef.values()) {
      out = out.split(reg.alias).join(reg.unit.name);
    }
    return out;
  }

  /** 校验裸名是否合法（给界面试探用） */
  static validName(name: string): boolean { return UNIT_NAME_RE.test(name); }
}

// 量纲检查引擎的公共类型定义

/** 变量：数值文本 + 单位文本（单位留空表示纯数） */
export interface VariableDef {
  value: string;
  unit: string;
  /** 当前单位文本实际解析到的「课程单位库」定义版本（内置单位为空）。
   *  保存后即钉住该版本：同名定义修订不会悄悄改变历史计算。
   *  通常只有一个；单位文本里组合多个课程单位（如 a b/s）时按名各钉一个。 */
  unitRefs?: UnitRef[];
}

/** 课程单位的稳定引用（钉住具体定义版本） */
export interface UnitRef {
  /** 课程单位稳定标识（库内主键） */
  id: string;
  /** 引用时的版本号（从 1 开始，定义修订只增不改） */
  version: number;
  /** 引用时的显示名快照，用于定义被删除/隔离后仍可展示原绑定 */
  name: string;
  /** 引用来源：本库 / 隔离命名空间（导入包） */
  origin: "local" | "import";
  /** origin=import 时的隔离命名空间 id */
  scope?: string;
}

/** 一条公式 */
export interface Formula {
  id: string;
  /** MathLive 编辑产出的 LaTeX，导出后仍可重新编辑 */
  latex: string;
  /** 备注 */
  note: string;
  variables: Record<string, VariableDef>;
  /** 期望换算到的结果单位；留空表示使用计算得到的单位 */
  targetUnit: string;
  /** 结果目标单位绑定的课程单位版本 */
  targetUnitRefs?: UnitRef[];
  /** 未绑定裸名解析时偏好的隔离单位包 scope（新公式想使用某个导入包时设置） */
  preferredScope?: string;
  createdAt: number;
}

/** 问题严重级别：error = 明确错误；warning = 超出首版支持范围，结果未验证 */
export type IssueKind = "error" | "warning";

export interface Issue {
  kind: IssueKind;
  /** 定位到的 AST 节点路径（根节点为 []，子节点为序号数组） */
  path: number[];
  /** 该节点对应的原式片段（LaTeX） */
  snippet: string;
  message: string;
}

export type AnalysisStatus = "ok" | "unverified" | "error" | "empty";

/** 分析过程中实际解析到的课程单位绑定，由界面持久化回公式 */
export interface ResolvedBindings {
  /** 变量名 → 绑定版本列表（仅含有课程单位的变量） */
  variables: Record<string, UnitRef[]>;
  /** 结果目标单位绑定版本（目标单位含课程单位时存在） */
  target: UnitRef[];
}

export interface AnalysisResult {
  status: AnalysisStatus;
  /** 原式中识别出的变量名（不含 pi、e 等内置常量） */
  variables: string[];
  /** 所有问题（错误 + 未验证警告） */
  issues: Issue[];
  /** 原式对应的 mathjs 表达式 */
  source?: string;
  /** 替换变量后的计算式（mathjs 表达式） */
  substituted?: string;
  /** 原式的 TeX（带问题节点高亮） */
  originalTex?: string;
  /** 替换后计算式的 TeX（带问题节点高亮） */
  substitutedTex?: string;
  /** 结果数值（原始单位） */
  value?: number;
  /** 结果单位字符串，无量纲时为 "" */
  resultUnit?: string;
  /** 换算后的结果数值 */
  targetValue?: number;
  /** 换算后的结果单位 */
  targetUnit?: string;
  /** 本次分析实际使用的课程单位版本绑定，待界面持久化 */
  bindings?: ResolvedBindings;
  /** 给 UI 用的简短状态说明 */
  summary?: string;
}

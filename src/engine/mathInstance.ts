// 全引擎共享的唯一 mathjs 实例。
// 课程单位别名（courseResolver）与公式求值（math）必须注册/运行在同一实例上，
// 否则一个实例 createUnit 的单位，另一个实例 unit() 解析不到。
import { create, all, type MathJsInstance } from "mathjs";

export const math: MathJsInstance = create(all);

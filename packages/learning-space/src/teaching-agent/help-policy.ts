import type { LearningActivity } from '@xunjie/contracts/learning-data';

/** Course contributions keep their output boundary out of the durable execution Driver. */
export function requiresExplanationReview(activity: LearningActivity): boolean {
  return !!activity.course?.components?.some(binding => binding.definition.manifest.formatVersion === 3
    && binding.definition.manifest.runtime.adapterId === 'icarus-alu');
}

const submissionCode = /```\s*(?:systemverilog|verilog|sv|diff|patch)\b|\bmodule\s+[a-z_$][\w$]*\s*[#(;]|\bendmodule\b|^\s*(?:>\s*)?(?:assign\s+\w|always(?:_comb|_ff|_latch|\s*@)|initial\s+begin)|\*\*\* (?:Begin Patch|Update File)|^@@\s/im;
const explanationOnly = '我可以帮你解释进位、位宽和运算选择，并根据固定代码与真实观察定位问题。请你自己修改 SystemVerilog；可以选一个边界输入，比较低 4 位与第 5 位，再运行验证。';

/** Review complete model text before publication; incomplete streaming prefixes cannot bypass it. */
export function teachingExplanationText(activity: LearningActivity, text: string): string {
  if (!requiresExplanationReview(activity)) return text;
  return submissionCode.test(text.normalize('NFKC')) ? explanationOnly : text;
}

/** Rejected model payloads are still visible tool records, so they need the same publication boundary. */
export function teachingPublicArguments(activity: LearningActivity, args: Record<string, unknown>): Record<string, unknown> {
  const violatesPolicy = (value: unknown): boolean => {
    if (typeof value === 'string') return teachingExplanationText(activity, value) !== value;
    if (Array.isArray(value)) return value.some(violatesPolicy);
    if (value && typeof value === 'object')
      return Object.entries(value).some(([key, child]) => violatesPolicy(key) || violatesPolicy(child));
    return false;
  };
  return violatesPolicy(args) ? { rejectedByHelpPolicy: true } : args;
}

export function teachingExplanationRules(activity: LearningActivity): string {
  if (!requiresExplanationReview(activity)) return '';
  return `ALU 帮助范围：只解释学生固定的 SystemVerilog、公开行为、实际观察、检查反例和波形范围。可以给概念示意和下一步验证方法，不能自写 testbench、提供补丁或整份可提交答案，也不能把答案藏进提问、摘要或工具参数。
课程验证只针对本次问题固定的原代码和一个获准输入，不启用学生的新作品，不产生学生预测、理由或解释。说明使用的是学生观察还是 Agent 验证；帮助后的预测不能声称独立理解。
区分真实编译诊断、行为不符、X/Z、没有运行、未完成与效果未知。单次仿真完成只证明取得该输入的观察，不代表全部 4096 组检查通过、学生掌握或教师已接收。发送后编辑属于另一个版本，不能把原结果用于新代码。`;
}

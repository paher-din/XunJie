import { z } from 'zod';
import { aluCaseDraftSchema, aluCaseFromAction, aluInputsSchema, aluReflectionSchema } from './alu-learning.js';
import type { AluCaseDraft, AluInputs } from './alu-learning.js';
import { ALU_VCD_LIMITS, AluVcdRangeError, describeAluVcdRange, parseAluVcd,
  type AluVcdChange, type AluWaveRange } from './alu-waveform.js';
import type { ExecutionActionV3 } from './execution.js';

const emptyTarget = z.object({}).strict();
const tick = z.string().min(1).max(ALU_VCD_LIMITS.tickDigits).regex(/^\d+$/);
const waveTarget = z.object({ signalIds: z.array(z.string().min(1).max(ALU_VCD_LIMITS.identifierLength)).min(1).max(ALU_VCD_LIMITS.signals),
  fromTick: tick, toTick: tick }).strict().refine(value => BigInt(value.fromTick) <= BigInt(value.toTick), 'invalid-range');
export const aluReferenceAdapters = {
  'alu-case': { version: 1, origin: 'state', target: emptyTarget },
  'alu-observation': { version: 1, origin: 'execution-result', target: emptyTarget },
  'alu-waveform': { version: 1, origin: 'execution-result', target: waveTarget },
  'alu-reflection': { version: 1, origin: 'state', target: emptyTarget },
} as const;
export type AluReferenceType = keyof typeof aluReferenceAdapters;

export function normalizeAluReferenceTarget(typeId: string, target: unknown): Record<string, unknown> {
  if (!Object.hasOwn(aluReferenceAdapters, typeId)) throw new Error('unsupported-version');
  if (typeId !== 'alu-waveform') return emptyTarget.parse(target);
  const range = waveTarget.parse(target);
  return { signalIds: [...new Set(range.signalIds)].sort(), fromTick: BigInt(range.fromTick).toString(), toTick: BigInt(range.toTick).toString() };
}

// A projection of the facts this adapter uses, not another execution admission schema.
// Keep the import of execution type-only: execution -> learning-data -> question-drafts
// would otherwise form an eager schema initialization cycle. The server owner parses V3.
const actionFacts = z.object({ protocolVersion: z.literal(3), kind: z.literal('execution'), requestId: z.uuid(),
  scope: z.object({ environmentId: z.uuid(), spaceId: z.uuid(), principalId: z.uuid(), activityId: z.uuid() }),
  execution: z.object({ instance: z.object({ instanceId: z.string(), key: z.string(), componentId: z.uuid(),
    componentVersion: z.number().int().positive(), definitionDigest: z.string(), hostApiVersion: z.literal(1), stateVersion: z.number().int().positive() }),
    operation: z.object({ operationId: z.enum(['run-single', 'observe-enabled']) }), parameters: aluInputsSchema,
    initiator: z.object({ kind: z.enum(['student', 'agent', 'self-check', 'teacher-preview']) }),
    basis: z.object({ runtime: z.object({ adapterId: z.literal('icarus-alu') }),
      expected: z.object({ stateContentId: z.uuid().nullable() }),
      enabledBy: z.object({ requestId: z.uuid(), inputDigest: z.string().regex(/^[a-f0-9]{64}$/), executionRef: z.uuid() }).optional(),
      works: z.array(z.object({ objectId: z.uuid(), contentId: z.uuid(), name: z.string().max(240), kind: z.string() })).max(512) }) }) });
const executionMaterial = z.object({ action: z.unknown(), output: z.unknown(), state: z.enum([
  'queued', 'running', 'paused', 'succeeded', 'failed', 'cancelled', 'unknown']), resources: z.array(z.unknown()).max(4) }).passthrough();
const actualOutput = z.object({ f: z.string().regex(/^[01xzXZ]{4}$/), cout: z.string().regex(/^[01xzXZ]$/),
  observationState: z.enum(['complete', 'complete-with-unknown']) });

function actionContext(value: unknown) {
  const action = actionFacts.parse(value), execution = action.execution;
  const capture = aluCaseFromAction(value as ExecutionActionV3);
  return { action, capture, context: { requestId: action.requestId, operationId: execution.operation.operationId,
    instance: execution.instance, inputs: execution.parameters, case: capture?.draft ?? null,
    origin: execution.initiator.kind, enabledBy: execution.basis.enabledBy ?? null,
    works: execution.basis.works.filter(file => file.kind === 'code').map(({ objectId, contentId, name }) => ({ objectId, contentId, name }))
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : a.contentId < b.contentId ? -1 : a.contentId > b.contentId ? 1 : 0) } };
}

const purposes = { unspecified: '未选择', boundary: '进位或边界', operation: '操作区别', custom: '自选用例' };
const origins = { student: '学生执行', agent: 'Agent 验证', 'self-check': '自检执行', 'teacher-preview': '教师预览' };
const states = { queued: '等待执行', running: '执行中', paused: '执行已暂停', succeeded: '执行成功', failed: '执行失败',
  cancelled: '执行已取消', unknown: '执行状态未知' };
const indented = (text: string) => text.replace(/\r\n|\r|\n/g, '\n  ');
const inputLine = (inputs: AluInputs) => `输入：A=${inputs.A}，B=${inputs.B}，M=${inputs.M}，S=${inputs.S}，Cin=${inputs.Cin}`;
function predictionLines(draft: AluCaseDraft | null, label = '预测'): string[] {
  const predicted = (name: string, text?: string) => text?.trim() ? `${name}=${indented(text)}` : `${name} 未填写`;
  const sources = draft ? [
    ['同输入观察', draft.priorSources.filter(item => item.kind === 'same-input-observation').length],
    ['作品全量检查', draft.priorSources.filter(item => item.kind === 'work-check').length],
  ].filter(([, count]) => count).map(([name, count]) => `${name} ×${count}`).join('；') : '';
  return [`目的：${draft ? purposes[draft.purpose] : '未选择'}`,
    `${label}：${predicted('F', draft?.predictedF)}，${predicted('Cout', draft?.predictedCout)}`,
    `理由：${draft?.reason.trim() ? indented(draft.reason) : '未填写'}`,
    `帮助自报：${draft ? draft.helpReported ? '已获得帮助' : '未报告获得帮助' : '未填写'}`,
    `记录来源：${sources || '未记录'}`];
}
function contextLines(context: ReturnType<typeof actionContext>['context']): string[] {
  return [inputLine(context.inputs), `作品：${context.works.length ? context.works.map(file => indented(file.name)).join('、') : '未提供代码文件'}`,
    `执行来源：${origins[context.origin]}`, ...predictionLines(context.case, '原预测')];
}
/** UTF-8 budget includes labels, student text, code filenames and every selected waveform event. */
function boundedText(lines: string[]): string {
  const text = lines.join('\n');
  let bytes = 0;
  for (const character of text) {
    const code = character.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes > ALU_VCD_LIMITS.rangeCopyBytes)
      throw new AluVcdRangeError('range-too-large', '引用副本超过 256 KiB，请缩小所选范围或减少信号。');
  }
  return text;
}

/** Generates a copy from owner material. It is not an ownership attestation. */
export function aluReferenceCopy(typeId: string, target: unknown, content: unknown): string {
  const normalized = normalizeAluReferenceTarget(typeId, target);
  if (typeId === 'alu-case') {
    const state = aluInputsSchema.extend({ caseDraft: z.string().max(16000).optional() }).passthrough().parse(content);
    const draft = state.caseDraft ? aluCaseDraftSchema.parse(JSON.parse(state.caseDraft)) : null;
    const inputs = aluInputsSchema.strip().parse(content);
    return boundedText(['ALU 用例', inputLine(inputs), ...predictionLines(draft)]);
  }
  if (typeId === 'alu-observation') {
    const material = executionMaterial.parse(content), { context } = actionContext(material.action);
    const output = actualOutput.safeParse(material.output);
    const actual = material.state === 'succeeded' && output.success
      ? { F: output.data.f.toUpperCase(), Cout: output.data.cout.toUpperCase(), observationState: output.data.observationState } : null;
    const missing = material.state === 'succeeded' ? '缺失或不完整' : material.state === 'unknown' ? '未确认' : `未取得（${states[material.state]}）`;
    return boundedText(['ALU 观察', ...contextLines(context), `状态：${states[material.state]}`,
      actual ? `实际：F=${actual.F}，Cout=${actual.Cout}` : `实际：${missing}`]);
  }
  if (typeId === 'alu-waveform') {
    const material = executionMaterial.parse(content), { context } = actionContext(material.action);
    const resources = z.array(z.object({ name: z.string().max(120), text: z.string().max(ALU_VCD_LIMITS.inputBytes) })).max(4).parse(material.resources);
    const traces = resources.filter(resource => resource.name === 'trace.vcd');
    if (traces.length !== 1) throw new Error('缺少唯一的原始 trace.vcd 保留资源。');
    const parsed = parseAluVcd(traces[0]!.text);
    const waveform = JSON.parse(describeAluVcdRange(parsed, normalized as AluWaveRange)) as {
      range: AluWaveRange; signals: { id: string; width: number; atFrom: AluVcdChange | null; changes: AluVcdChange[] }[] };
    const lines = ['ALU 波形', ...contextLines(context), `状态：${states[material.state]}`,
      `原始 tick 闭区间：${waveform.range.fromTick} 至 ${waveform.range.toTick}`,
      parsed.timescale ? `时间单位：${parsed.timescale.magnitude} ${parsed.timescale.unit}/tick` : '时间单位：未声明'];
    if (parsed.issues.some(issue => issue.code === 'recording-limited')) lines.push('波形记录不完整（已达到转储上限）');
    for (const signal of waveform.signals) {
      lines.push(`信号 ${signal.id}（${signal.width} 位）`, signal.atFrom
        ? `  起点：${signal.atFrom.value}（记录于 tick ${signal.atFrom.timeTick}）` : '  起点：未取得');
      for (const change of signal.changes) lines.push(`  tick ${change.timeTick}：${change.value}`);
      if (!signal.changes.length) lines.push('  区间内无变化记录');
    }
    return boundedText(lines);
  }
  if (typeId === 'alu-reflection') {
    const material = z.object({ note: aluReflectionSchema, action: z.unknown() }).parse(content);
    const { action, capture, context } = actionContext(material.action), note = material.note;
    if (note.requestId !== action.requestId || note.activityId !== action.scope.activityId
      || note.bindingKey !== action.execution.instance.key || note.instanceId !== action.execution.instance.instanceId
      || note.definitionDigest !== action.execution.instance.definitionDigest) throw new Error('invalid-source');
    return boundedText(['ALU 解释修订', ...contextLines(context),
      capture ? `原用例：${capture.draft.caseId.slice(0, 8)}；预测修订：${capture.draft.revisionId.slice(0, 8)}` : '原观察未固定预测；缺项保留。',
      `修订：${note.parentNoteId ? '接续已有解释' : '首次记录'}`, `解释：${note.text.trim() ? indented(note.text) : '未填写'}`]);
  }
  throw new Error('unsupported-content');
}

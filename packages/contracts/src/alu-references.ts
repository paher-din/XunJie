import { z } from 'zod';
import { aluCaseDraftSchema, aluCaseFromAction, aluInputsSchema, aluReflectionSchema, isAluCodeWork } from './alu-learning.js';
import type { AluCaseDraft, AluInputs } from './alu-learning.js';
import { ALU_VCD_LIMITS, AluVcdRangeError, describeAluVcdRange, parseAluVcd,
  type AluVcdChange, type AluWaveRange } from './alu-waveform.js';
import type { ExecutionActionV3 } from './execution.js';

const emptyTarget = z.object({}).strict();
const counterexampleTarget = z.object({ index: z.number().int().min(0).max(4095) }).strict();
const tick = z.string().min(1).max(ALU_VCD_LIMITS.tickDigits).regex(/^\d+$/);
const waveTarget = z.object({ signalIds: z.array(z.string().min(1).max(ALU_VCD_LIMITS.identifierLength)).min(1).max(ALU_VCD_LIMITS.signals),
  fromTick: tick, toTick: tick }).strict().refine(value => BigInt(value.fromTick) <= BigInt(value.toTick), 'invalid-range');
export const aluReferenceAdapters = {
  'alu-case': { version: 1, origin: 'state', target: emptyTarget },
  'alu-observation': { version: 1, origin: 'execution-result', target: emptyTarget },
  'alu-waveform': { version: 1, origin: 'execution-result', target: waveTarget },
  'alu-reflection': { version: 1, origin: 'state', target: emptyTarget },
  'alu-counterexample': { version: 1, origin: 'execution-result', target: counterexampleTarget },
} as const;
export type AluReferenceType = keyof typeof aluReferenceAdapters;

export function normalizeAluReferenceTarget(typeId: string, target: unknown): Record<string, unknown> {
  if (!Object.hasOwn(aluReferenceAdapters, typeId)) throw new Error('unsupported-version');
  if (typeId === 'alu-counterexample') return counterexampleTarget.parse(target);
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
const checkActionFacts = actionFacts.extend({ execution: actionFacts.shape.execution.extend({
  operation: z.object({ operationId: z.literal('check-all') }), parameters: emptyTarget,
  basis: actionFacts.shape.execution.shape.basis.extend({
    runtime: z.object({ adapterId: z.literal('icarus-alu'), adapterVersion: z.literal(1),
      bundleIdentity: z.string(), resources: z.array(z.object({ resourceId: z.uuid(), path: z.string(), sha256: z.string() })) }),
    observation: z.object({ scaffoldResourceId: z.uuid(), scaffoldVersion: z.number() }),
    course: z.object({ behaviorRuleDigest: z.string() }),
  }),
}) });
const checkReading = z.object({ round: z.number().int().min(0).max(3), precursor: z.enum(['P0', 'P1']),
  sampleTime: z.union([z.literal(1), z.literal(2)]), f: z.string().regex(/^[01xz]{4}$/).nullable(),
  cout: z.string().regex(/^[01xz]$/).nullable(), state: z.enum(['binary', 'unknown', 'missing', 'invalid']) })
  .refine(row => row.precursor === (row.round < 2 ? 'P0' : 'P1') && row.sampleTime === row.round % 2 + 1
    && (row.state === 'missing' ? row.f === null && row.cout === null
      : row.f !== null && row.cout !== null && (row.state === 'binary' ? /^[01]{5}$/.test(row.f + row.cout)
        : row.state === 'unknown' && /[xz]/.test(row.f + row.cout))), 'invalid-reading');
const checkCounterexample = z.object({ index: counterexampleTarget.shape.index, inputs: aluInputsSchema,
  expected: z.object({ f: z.string().regex(/^[01]{4}$/), cout: z.string().regex(/^[01]$/) }),
  rounds: z.array(checkReading).length(4),
  reasons: z.array(z.enum(['behaviour', 'unknown', 'inconsistent', 'missing'])).min(1).max(4) })
  .refine(item => item.index === item.inputs.M * 2048 + item.inputs.S * 512 + item.inputs.A * 32 + item.inputs.B * 2 + item.inputs.Cin
    && new Set(item.rounds.map(round => round.round)).size === 4 && new Set(item.reasons).size === item.reasons.length, 'invalid-counterexample');
const checkRound = z.object({ round: z.number().int().min(0).max(3), precursor: z.enum(['P0', 'P1']),
  sampleTime: z.union([z.literal(1), z.literal(2)]), status: z.enum(['completed', 'failed', 'stopped', 'budget-exceeded', 'missing']),
  observationState: z.string().max(80) });
const uniqueRounds = (rounds: z.infer<typeof checkRound>[]) => new Set(rounds.map(round => round.round)).size === 4
  && rounds.every(round => round.precursor === (round.round < 2 ? 'P0' : 'P1') && round.sampleTime === round.round % 2 + 1);
const checkDigest = z.string().regex(/^[a-f0-9]{64}$/);
const checkReport = z.object({ formatVersion: z.literal(1), kind: z.literal('alu-check'),
  totalInputs: z.literal(4096), plannedSamples: z.literal(16384),
  verdict: z.enum(['pass', 'fail', 'inconclusive']), counterexampleTotal: z.number().int().min(1).max(4096),
  counterexamples: z.array(checkCounterexample).min(1).max(20),
  rounds: z.array(checkRound).length(4).refine(uniqueRounds),
  source: z.object({ adapterId: z.literal('icarus-alu'), adapterVersion: z.literal(1), bundleIdentity: checkDigest,
    dependencyId: checkDigest, suiteVersion: z.literal(1),
    scaffold: z.object({ path: z.string().max(240), sha256: checkDigest, version: z.number().int().positive() }),
    rule: z.object({ version: z.literal(1), digest: checkDigest }),
    works: z.array(z.object({ name: z.string().max(240), contentId: z.uuid(), sha256: checkDigest })).max(512) }) });
const checkObservations = z.object({ formatVersion: z.literal(1), kind: z.literal('alu-check-observations'),
  totalInputs: z.literal(4096), plannedSamples: z.literal(16384), verdict: checkReport.shape.verdict,
  counterexamples: z.array(checkCounterexample).max(4096),
  rounds: z.array(checkRound.extend({ rows: z.array(z.tuple([counterexampleTarget.shape.index,
    z.string().regex(/^[01xz]{4}$/), z.string().regex(/^[01xz]$/)])).max(65536) })).length(4).refine(uniqueRounds) });
const checkReasonLabels = { behaviour: '行为错误', unknown: '含 X/Z', inconsistent: '跨轮不一致', missing: '缺行' };

function checkJson(text: string, limit: number): unknown {
  let bytes = 0;
  for (const character of text) {
    const code = character.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes > limit) throw new Error('invalid-source');
  }
  return JSON.parse(text);
}

/** Select retained facts only. This does not execute the ALU or grade a new result. */
function counterexampleFacts(content: unknown, index: number) {
  const material = executionMaterial.extend({ name: z.literal('check-report.json'), mediaType: z.literal('application/json'),
    text: z.string().max(1048576) }).parse(content);
  const action = checkActionFacts.parse(material.action), report = checkReport.parse(checkJson(material.text, 1048576));
  const source = report.source, basis = action.execution.basis;
  const works = basis.works.filter(isAluCodeWork);
  const scaffold = basis.runtime.resources.find(resource => resource.resourceId === basis.observation.scaffoldResourceId);
  if (report.verdict === 'pass' || report.counterexamples.length !== Math.min(20, report.counterexampleTotal)
    || source.bundleIdentity !== basis.runtime.bundleIdentity || source.rule.digest !== basis.course.behaviorRuleDigest
    || source.scaffold.version !== basis.observation.scaffoldVersion || !scaffold
    || source.scaffold.path !== scaffold.path || source.scaffold.sha256 !== scaffold.sha256
    || source.works.length !== works.length || new Set(source.works.map(work => work.contentId)).size !== works.length
    || source.works.some(work => !works.some(file => file.contentId === work.contentId && file.name === work.name)))
    throw new Error('invalid-source');
  const resources = z.array(z.object({ name: z.string(), text: z.string().max(8388608) })).max(4).parse(material.resources);
  const observations = resources.filter(resource => resource.name === 'check-observations.json');
  if (observations.length > 1) throw new Error('invalid-source');
  const full = observations.length ? checkObservations.parse(checkJson(observations[0]!.text, 8388608)) : null;
  const examples = full?.counterexamples ?? report.counterexamples;
  if (new Set(examples.map(item => item.index)).size !== examples.length
    || new Set(report.counterexamples.map(item => item.index)).size !== report.counterexamples.length
    || full && (full.verdict !== report.verdict || examples.length !== report.counterexampleTotal
      || JSON.stringify(examples.slice(0, 20)) !== JSON.stringify(report.counterexamples))) throw new Error('invalid-source');
  const selected = examples.filter(item => item.index === index);
  if (selected.length !== 1) throw new Error('invalid-target');
  const item = selected[0]!;
  if (full) for (const reading of item.rounds) {
    const round = full.rounds.find(round => round.round === reading.round)!;
    const meta = report.rounds.find(round => round.round === reading.round)!;
    const sample = round.rows.find(row => row[0] === index);
    if (round.status !== meta.status || round.observationState !== meta.observationState
      || (sample ? sample[1] !== reading.f || sample[2] !== reading.cout : reading.state !== 'missing'))
      throw new Error('invalid-source');
  }
  return { material, action, report, item, works };
}

function actionContext(value: unknown) {
  const action = actionFacts.parse(value), execution = action.execution;
  const capture = aluCaseFromAction(value as ExecutionActionV3);
  return { action, capture, context: { requestId: action.requestId, operationId: execution.operation.operationId,
    instance: execution.instance, inputs: execution.parameters, case: capture?.draft ?? null,
    origin: execution.initiator.kind, enabledBy: execution.basis.enabledBy ?? null,
    works: execution.basis.works.filter(isAluCodeWork).map(({ objectId, contentId, name }) => ({ objectId, contentId, name }))
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
  if (typeId === 'alu-counterexample') {
    const { material, action, report, item, works } = counterexampleFacts(content, normalized.index as number);
    return boundedText([`ALU 检查反例 #${item.index}`, `原执行：${action.requestId}`,
      `执行来源：${origins[action.execution.initiator.kind]}`,
      `固定作品：${works.map(file => `${indented(file.name)}（${file.contentId}）`).sort().join('、') || '未提供代码文件'}`,
      `状态：${states[material.state]}`, `检查结论：${report.verdict}`, inputLine(item.inputs),
      `预期：F=${item.expected.f}，Cout=${item.expected.cout}`, `反例原因：${item.reasons.map(reason => checkReasonLabels[reason]).join('、')}`,
      ...[...item.rounds].sort((a, b) => a.round - b.round).map(round => `第 ${round.round + 1} 轮（${round.precursor}/T${round.sampleTime}）：`
        + (round.f === null || round.cout === null ? '实际未取得' : `实际 F=${round.f.toUpperCase()}，Cout=${round.cout.toUpperCase()}`)
        + `；${round.state}`)]);
  }
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

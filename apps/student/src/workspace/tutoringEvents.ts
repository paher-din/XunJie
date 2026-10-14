import { record, requiredId, revision, textHash } from './confirmation'
import type { TutorPage, TutorPayload } from './tutoringContracts'
export const tutorActions = ['plan', 'clarify', 'hint', 'explain', 'compare', 'verify_suggestion', 'reflect', 'extend', 'handoff_teacher', 'no_action']
const statuses = ['ready', 'active', 'paused', 'submitted', 'reviewed']
export function verifyTutorPage(value: unknown, cursor: number): TutorPage {
  const page = record(value), c = record(page.control)
  for (const key of ['attemptRevision', 'decisionEpoch', 'captureRevision']) revision(c[key])
  requiredId(c.generation)
  if (!statuses.includes(String(c.status)) || typeof c.collecting !== 'boolean' || typeof c.reminders !== 'boolean'
    || typeof page.resyncRequired !== 'boolean' || typeof page.hasMore !== 'boolean' || !Array.isArray(page.events)) throw new Error('教学页控制不完整')
  const next = revision(page.nextServerSeq)
  if (next < cursor || page.events.length > 100) throw new Error('教学游标回退或超限')
  let seq = cursor
  const ids = new Set<string>()
  for (const event of page.events) {
    const e = record(event), n = revision(e.serverSeq, 1), id = requiredId(e.eventId)
    if (n <= seq || n > next || ids.has(id) || typeof e.type !== 'string' || !Number.isFinite(Date.parse(String(e.occurredAt)))) throw new Error('教学事件顺序不合法')
    seq = n; ids.add(id)
  }
  if (page.hasMore && next === cursor && !page.resyncRequired) throw new Error('教学分页没有推进')
  if(page.coverage!==undefined) {
    const coverage=record(page.coverage)
    requiredId(coverage.attemptId);revision(coverage.captureRevision);revision(coverage.cutoffServerSeq)
    if(coverage.captureRevision!==c.captureRevision || coverage.collecting!==c.collecting || !Array.isArray(coverage.intervals)) throw new Error('采集覆盖与控制状态不符')
    for(const value of coverage.intervals) {
      const row=record(value)
      if(row.attemptId!==coverage.attemptId || !['collecting','paused'].includes(String(row.state)) || typeof row.open!=='boolean'
        || !Number.isFinite(Date.parse(String(row.from))) || !Array.isArray(row.rejections)) throw new Error('采集覆盖区间不完整')
      revision(row.captureRevision);revision(row.fromServerSeq)
      if(row.to!==undefined&&!Number.isFinite(Date.parse(String(row.to))))throw new Error('采集覆盖结束时间不合法')
      if(row.toServerSeq!==undefined)revision(row.toServerSeq)
    }
  }
  return value as TutorPage
}
export async function verifyTutorContent(value: unknown): Promise<TutorPayload> {
  const p = record(value)
  requiredId(p.actionId); requiredId(p.deliveryId)
  if (p.disposition !== 'pending' || typeof p.basisRevised !== 'boolean' || !Number.isFinite(Date.parse(String(p.createdAt)))
    || !tutorActions.includes(String(p.actionType)) || typeof p.content !== 'string' || !p.content
    || p.contentHash !== await textHash(p.content)) throw new Error('教学正文缺失、类型非法或摘要不一致')
  for (const key of ['rationale', 'expectedStudentAction', 'assistanceContext']) if (p[key] !== undefined && typeof p[key] !== 'string') throw new Error('教学说明不合法')
  for (const key of ['evidenceIds', 'resourceRefs', 'unresolved']) if (p[key] !== undefined && (!Array.isArray(p[key]) || !(p[key] as unknown[]).every(x => typeof x === 'string'))) throw new Error('教学引用不合法')
  return value as TutorPayload
}

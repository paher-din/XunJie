import { teacherCommand, teacherGet } from './backend'
import type { BlueprintContent, BlueprintDraft, DesignResult } from './wire'

export type DesignMode = 'candidates' | 'blueprint' | 'patch' | 'rubric_trial'
export interface DesignRun {
  jobId: string; courseId: string; blueprintId: string | null; baseRevision: number
  generation: string; editor: string; fields: (keyof BlueprintContent)[]
}
export interface DesignJob {
  jobId: string; status: string; failure?: string; proposalId?: string; resultHash?: string
}
export interface DesignProposal {
  proposalId: string; jobId: string; courseId: string; blueprintId: string | null; baseRevision: number
  resultHash: string; applicable: boolean
  body: { kind: DesignMode; candidates?: Record<string, unknown>[]; [key: string]: unknown }
  diff: { path: string; before: unknown; after: unknown }[]
  rationale: string; affectedReferences: string[]
  modelResult: { calls: number; elapsedMs: number; usage: { status: string; inputTokens?: number; outputTokens?: number } }
}
export const designFields: (keyof BlueprintContent)[] = [
  'projectTitle', 'problem', 'audience', 'artifact', 'studentBackground', 'timeConstraints', 'routes',
  'goals', 'tasks', 'observations', 'rubricCriteria', 'milestones', 'resources', 'helpPolicyVersionId',
  'checkRuleVersionId', 'runtimeProfileVersionId', 'digitalLogicConfigVersionId',
]
const encoded = encodeURIComponent
export const runningDesignJob = (job: DesignJob) => ['queued', 'running', 'cancelling'].includes(job.status)
export async function readDesignRun(run: DesignRun): Promise<{ job: DesignJob; proposal?: DesignProposal }> {
  const job = await teacherGet<DesignJob>(`/jobs/${encoded(run.jobId)}`)
  if (!job || job.jobId !== run.jobId || typeof job.status !== 'string') throw new Error('任务回执不匹配。')
  if (job.status !== 'succeeded') return { job }
  if (!job.proposalId || !job.resultHash) throw new Error('任务成功但缺少原提案引用，请重新读取。')
  const proposal = await teacherGet<DesignProposal>(`/design-proposals/${encoded(job.proposalId)}`)
  if (!proposal || proposal.proposalId !== job.proposalId || proposal.jobId !== run.jobId ||
    proposal.courseId !== run.courseId || proposal.blueprintId !== run.blueprintId ||
    proposal.resultHash !== job.resultHash || !/^[a-f0-9]{64}$/.test(proposal.resultHash) ||
    typeof proposal.applicable !== 'boolean' || !Number.isSafeInteger(proposal.baseRevision) ||
    !proposal.body || !['candidates', 'blueprint', 'patch', 'rubric_trial'].includes(proposal.body.kind) ||
    !Array.isArray(proposal.diff) || proposal.diff.some(item => !item || typeof item.path !== 'string') ||
    !Array.isArray(proposal.affectedReferences) || proposal.affectedReferences.some(ref => typeof ref !== 'string') ||
    (proposal.body.kind === 'candidates' && (!Array.isArray(proposal.body.candidates) || !proposal.body.candidates.length))) {
    throw new Error('提案的课程、版本或原结果引用不匹配，未接纳。')
  }
  return { job, proposal }
}
export function proposalPatch(proposal: DesignProposal, fields: readonly (keyof BlueprintContent)[]): Partial<BlueprintContent> {
  if (!['patch', 'blueprint'].includes(proposal.body.kind)) return {}
  const basic = ['problem', 'audience', 'artifact', 'routes']
  return Object.fromEntries(proposal.diff.filter(item => fields.includes(item.path as keyof BlueprintContent)
    && designFields.includes(item.path as keyof BlueprintContent)
    && (proposal.body.kind === 'patch' || basic.includes(item.path)))
    .map(item => [item.path, item.after]))
}
export async function adoptDesignProposal(account: string, run: DesignRun, proposal: DesignProposal,
  editor: string, draft: BlueprintDraft | undefined, candidateIndex?: number, isCurrent: () => boolean = () => true,
  configuration: Partial<BlueprintContent> = {}): Promise<BlueprintDraft> {
  // Re-read applicability immediately before the explicit write. CAS remains authoritative on the server.
  const fresh = (await readDesignRun(run)).proposal
  if (!isCurrent() || !fresh || fresh.proposalId !== proposal.proposalId || fresh.resultHash !== proposal.resultHash || !fresh.applicable ||
    run.editor !== editor || fresh.baseRevision !== run.baseRevision ||
    (draft ? fresh.blueprintId !== draft.blueprintId || fresh.baseRevision !== draft.revision : fresh.blueprintId !== null)) {
    throw new Error('提案已过时或期间发生人工编辑。已保留候选，请根据当前保存版本重新生成。')
  }
  let result: DesignResult
  if (!draft) {
    if (fresh.body.kind !== 'candidates' && fresh.body.kind !== 'blueprint') throw new Error('该候选不能创建新草稿。')
    if (fresh.body.kind === 'candidates' && (candidateIndex === undefined || !fresh.body.candidates?.[candidateIndex])) throw new Error('请先选择一个项目候选。')
    const retained = Object.fromEntries(['projectTitle', 'studentBackground', 'timeConstraints', 'helpPolicyVersionId',
      'checkRuleVersionId', 'runtimeProfileVersionId', 'digitalLogicConfigVersionId'].flatMap(field => {
      const value = configuration[field as keyof BlueprintContent]
      return typeof value === 'string' && value ? [[field, value]] : []
    }))
    result = await teacherCommand<DesignResult>(account, 'POST', `/design-proposals/${encoded(fresh.proposalId)}/adopt`, {
      recoveryGeneration: run.generation, ...(fresh.body.kind === 'candidates' ? { candidateIndex } : {}), content: retained,
    })
  } else {
    const patch = proposalPatch(fresh, run.fields)
    if (!Object.keys(patch).length) throw new Error('没有可直接采用的字段。请对照建议手工修订并保存。')
    result = await teacherCommand<DesignResult>(account, 'PATCH', `/blueprints/${encoded(draft.blueprintId)}`, {
      recoveryGeneration: run.generation, expectedRevision: draft.revision, proposalId: fresh.proposalId, patch,
    })
  }
  if (result.kind !== 'draft' || result.draft.courseId !== run.courseId ||
    (draft ? result.draft.blueprintId !== draft.blueprintId || result.draft.revision !== draft.revision + 1
      : result.draft.revision !== 1 || !result.draft.blueprintId)) throw new Error('采纳回执不匹配，请核对原教师操作。')
  return result.draft
}

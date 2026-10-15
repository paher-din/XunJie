import { beforeEach, expect, it, vi } from 'vitest'
import { adoptDesignProposal, proposalPatch, readDesignRun } from './designAgent'
import type { DesignProposal, DesignRun } from './designAgent'
import type { BlueprintDraft } from './wire'
import { teacherCommand, teacherGet } from './backend'
vi.mock('./backend', () => ({ teacherCommand: vi.fn(), teacherGet: vi.fn() }))
const run: DesignRun = { jobId: 'j1', courseId: 'c1', blueprintId: 'b1', baseRevision: 4, generation: 'g1', editor: 'saved', fields: ['problem'] }
const proposal: DesignProposal = { proposalId: 'p1', jobId: 'j1', courseId: 'c1', blueprintId: 'b1', baseRevision: 4,
  resultHash: 'a'.repeat(64), applicable: true, body: { kind: 'patch' }, diff: [{ path: 'problem', before: 'old', after: 'new' }],
  rationale: 'reason', affectedReferences: [], modelResult: { calls: 1, elapsedMs: 1, usage: { status: 'unknown' } } }
const draft = { blueprintId: 'b1', courseId: 'c1', revision: 4 } as BlueprintDraft
function reads(value = proposal) {
  vi.mocked(teacherGet).mockImplementation(async path => path.startsWith('/jobs/')
    ? { jobId: 'j1', status: 'succeeded', proposalId: 'p1', resultHash: 'a'.repeat(64) } : value)
}
beforeEach(() => { vi.resetAllMocks(); reads() })
it.each([{ ...proposal, courseId: 'other' }, { ...proposal, blueprintId: 'other' }, { ...proposal, resultHash: 'b'.repeat(64) }])('rejects mismatched proposal scope/hash before adoption', async bad => {
  reads(bad); await expect(readDesignRun(run)).rejects.toThrow('不匹配'); expect(teacherCommand).not.toHaveBeenCalled()
})
it('uses the original proposal, CAS and field whitelist for patch adoption', async () => {
  reads({ ...proposal, diff: [...proposal.diff, { path: 'goals', before: [], after: ['not-allowed'] }] })
  vi.mocked(teacherCommand).mockResolvedValue({ kind: 'draft', draft: { ...draft, revision: 5 } })
  await adoptDesignProposal('t1', run, proposal, 'saved', draft)
  expect(teacherCommand).toHaveBeenCalledWith('t1', 'PATCH', '/blueprints/b1', {
    recoveryGeneration: 'g1', expectedRevision: 4, proposalId: 'p1', patch: { problem: 'new' },
  })
})
it.each(['edited', 'saved'])('rejects edited content or edits during applicability read', async editor => {
  await expect(adoptDesignProposal('t1', run, proposal, editor, draft, undefined, () => false)).rejects.toThrow('过时')
  expect(teacherCommand).not.toHaveBeenCalled()
})
it('rejects stale proposals and no longer current draft revisions', async () => {
  reads({ ...proposal, applicable: false })
  await expect(adoptDesignProposal('t1', run, proposal, 'saved', draft)).rejects.toThrow('过时')
  reads()
  await expect(adoptDesignProposal('t1', run, proposal, 'saved', { ...draft, revision: 5 })).rejects.toThrow('过时')
  expect(teacherCommand).not.toHaveBeenCalled()
})
it('root candidate adoption creates a new draft and never patches an existing one', async () => {
  const root = { ...proposal, blueprintId: null, baseRevision: 0, body: { kind: 'candidates' as const, candidates: [{ problem: 'x' }] } }
  reads(root)
  vi.mocked(teacherCommand).mockResolvedValue({ kind: 'draft', draft: { blueprintId: 'new', courseId: 'c1', revision: 1 } })
  await adoptDesignProposal('t1', { ...run, blueprintId: null, baseRevision: 0 }, root, 'saved', undefined, 0)
  expect(teacherCommand).toHaveBeenCalledWith('t1', 'POST', '/design-proposals/p1/adopt', { recoveryGeneration: 'g1', candidateIndex: 0, content: {} })
})
it('rubric trials are advisory and blueprint text suggestions cannot become structured goal links', () => {
  expect(proposalPatch({ ...proposal, body: { kind: 'rubric_trial' } }, ['problem'])).toEqual({})
  expect(proposalPatch({ ...proposal, body: { kind: 'blueprint' }, diff: [{ path: 'suggestions.goals', before: [], after: ['x'] }] }, ['goals'])).toEqual({})
})
it('root adoption retains chosen course configuration without overriding generated problem/resources', async () => {
  const root = { ...proposal, blueprintId: null, baseRevision: 0, body: { kind: 'blueprint' as const } }
  reads(root)
  vi.mocked(teacherCommand).mockResolvedValue({ kind: 'draft', draft: { blueprintId: 'new', courseId: 'c1', revision: 1 } })
  await adoptDesignProposal('t1', { ...run, blueprintId: null, baseRevision: 0 }, root, 'saved', undefined, undefined, () => true,
    { projectTitle: 'Teacher title', helpPolicyVersionId: 'policy', runtimeProfileVersionId: 'runtime', problem: 'do not override', resources: [] })
  expect(teacherCommand).toHaveBeenCalledWith('t1', 'POST', '/design-proposals/p1/adopt', {
    recoveryGeneration: 'g1', content: { projectTitle: 'Teacher title', helpPolicyVersionId: 'policy', runtimeProfileVersionId: 'runtime' },
  })
})

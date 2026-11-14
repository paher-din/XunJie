// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { expect, it, vi } from 'vitest'
import { AgentSessionsClient, createSessionActionReceiver } from './agent-sessions'
import { ReliableWorkspace } from '../reliable-workspace'
import { ReliableQuestionDraft } from '../reliable-workspace/draft'
import type { WorkFile } from '@xunjie/contracts/learning-data'
import type { AgentSession } from '@xunjie/contracts/agent-sessions'
it('the protected workspace question reaches v2 directly with original works and draft, without legacy capabilities or intent dispatch', async () => {
  const id = () => crypto.randomUUID(), identity = { kind: 'personal' as const, environmentId: id(), spaceId: id(), principalId: id(), name: '个人' }, activityId = id(), now = new Date().toISOString()
  const scope = JSON.stringify(['session-queue', identity.environmentId, identity.spaceId, identity.principalId, activityId])
  const session: AgentSession = { sessionId: id(), requestId: id(), identity, scenario: 'workspace-assistant', title: '作品讨论', state: 'ready', pinned: false, archived: false, deleted: false, createdAt: now, updatedAt: now, readyAt: now,
    workspace: { activityId, target: { environmentId: identity.environmentId, serviceId: id(), version: 1 } },
    owner: { version: 1, connectionId: id(), installationId: id(), target: { environmentId: identity.environmentId, serviceId: id(), unit: 'teaching-agent', endpoint: 'https://agent.example.test', protocolVersion: 1, capabilities: ['agent.sessions.v2'] } } }
  const file = { objectId: id(), contentId: id(), name: 'main.py', value: 'print(42)', encoding: 'utf8' as const, kind: 'code' as const, mediaType: 'text/x-python' }
  let work = { revision: 0, files: [] as WorkFile[] }, accepted: any
  const legacy = vi.fn(async () => { throw new Error('legacy question endpoint must not be called') })
  const client = new AgentSessionsClient({ identity, spaceKey: 'personal', namespace: 'session-queue' })
  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit = {}) => {
    expect(url).toContain('/agent-sessions/' + session.sessionId + '/')
    expect(new Headers(options.headers).get('x-xj-agent-contract')).toBe('2')
    if (options.body) {
      const input = JSON.parse(String(options.body))
      expect(input.context.action.works).toEqual(work.files)
      accepted = { input, receipt: { sessionId: session.sessionId, requestId: input.requestId, inputId: id(), runId: id(), inputDigest: 'a'.repeat(64) } }
      return new Response(JSON.stringify(accepted.receipt))
    }
    return new Response(JSON.stringify(accepted ?? null))
  }))
  const workspace = new ReliableWorkspace(scope, { read: async () => work, receipt: async () => null, sync: async input => work = { revision: input.baseRevision + 1, files: input.files } })
  const draft = new ReliableQuestionDraft(scope, { read: async () => ({ draftId: id(), revision: 0, revisionId: null, question: '', references: [] }), receipt: async () => null,
    sync: async input => ({ draftId: input.draftId, revision: input.baseRevision + 1, revisionId: id(), question: input.question, references: [] }) })
  const actions = workspace.actions(draft, { prepare: legacy, dispatch: legacy, read: async () => null, cancel: legacy, capabilities: async () => [], list: async () => [] })
  const receiver = createSessionActionReceiver(client, session, async () => { await workspace.flush(); await draft.leave() })
  const unregister = actions.registerLocal(receiver)
  try {
    await Promise.all([workspace.open(), draft.open()]); await actions.open()
    workspace.change([file]); draft.change('检查这份作品', [])
    await actions.create({ requestId: id(), receiver: receiver.identity })
    await vi.waitFor(() => expect(actions.snapshot().items[0]?.phase).toBe('accepted'))
    expect(accepted.input.context.action).toMatchObject({ scope: { activityId, principalId: identity.principalId }, works: [file], draft: { question: '检查这份作品', references: [], bases: [] }, receiver: { receiverId: 'teaching-agent:' + session.owner.target.serviceId, kind: 'question', location: 'local' } })
    expect(draft.snapshot().question).toBe(''); expect(legacy).not.toHaveBeenCalled()
  } finally { unregister(); await actions.drain(); actions.dispose(); workspace.dispose(); draft.dispose(); vi.unstubAllGlobals() }
})

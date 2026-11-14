// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { activitySchema, workFileSchema } from '@xunjie/contracts/learning-data'
import { executionQuerySchema } from '@xunjie/contracts/execution'
import { agentConversationSchema } from '@xunjie/contracts/agent-service'
import { teachingArtifactRevisionSchema, teachingArtifactSchema } from '@xunjie/contracts/teaching-artifacts'
import type { TeachingArtifactsController } from '../teaching-artifacts/useTeachingArtifacts'
import { ReliableWorkspace } from '../reliable-workspace'
import { ActivitySessionContext } from './ActivitySession'
import type { TeachingToolRecordView } from './TeachingToolRecords'
import { ActivityConversation } from './ActivityConversation'
import { AgentSessionsClient } from './agent-sessions'
import { useAgentSession } from './useAgentSession'
const id = () => crypto.randomUUID(), now = () => new Date().toISOString()
let host: HTMLDivElement, root: Root, workspace: ReliableWorkspace
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }))
  Object.defineProperty(document, 'hidden', { configurable: true, value: false }); localStorage.clear()
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => { root.unmount(); await settle() }); workspace?.dispose(); host.remove(); vi.unstubAllGlobals() })
async function fixture() {
  const identity = { environmentId: id(), spaceId: id(), principalId: id(), kind: 'personal', name: '个人' }
  const activity = activitySchema.parse({ activityId: id(), identity, target: { environmentId: identity.environmentId, serviceId: id(), version: 1 },
    goal: '比较实验结果', question: '', references: [], status: 'open', createdAt: now() })
  const sessionId = id(), runId = id(), commandId = id(), client = new AgentSessionsClient({ identity: activity.identity, spaceKey: 'personal', namespace: 'workspace-card' })
  const conversation = agentConversationSchema.parse({ sessionId, lastSeq: 1, messages: [], inputs: [], waits: [], workspaces: [], tools: [],
    runs: [{ sessionId, runId, inputId: id(), requestId: id(), state: 'completed', reason: '', generation: 1, stopRequested: false,
      needsContinue: false, previousRunId: null, createdAt: now(), updatedAt: now(), completedAt: now() }] })
  workspace = new ReliableWorkspace(JSON.stringify(['workspace-card', identity.environmentId, identity.spaceId, identity.principalId, activity.activityId]), {
    read: async () => ({ revision: 0, files: [] }), receipt: async () => null, sync: async () => { throw new Error('Unexpected work write') },
  })
  await workspace.open()
  const artifactId = id(), revisionId = id(), resourceId = id()
  const payload = { formatVersion: 1, title: '互动解释页', display: 'page', html: '<p>原来的学习说明</p>', css: '', javascript: '', hostApiVersion: 1,
    stateVersion: 1, stateShape: { type: 'object', properties: {} }, initialState: {}, semanticFields: [], semanticObjects: [], requiredCapabilities: [] }
  const revision = teachingArtifactRevisionSchema.parse({ artifactId, activityId: activity.activityId, revisionId, version: 1, parentRevisionId: null, payload,
    resourceId, sha256: 'a'.repeat(64), byteLength: 30, origin: { runId, stepId: id(), snapshotId: id(), commandId }, createdAt: now(), mapping: [],
    binding: { key: 'artifact-' + artifactId, configuration: { title: payload.title }, materialIds: [], definition: { digest: 'b'.repeat(64), manifest: {
      formatVersion: 1, componentId: artifactId, version: 1, title: payload.title, hostApiVersion: 1, stateVersion: 1,
      stateShape: payload.stateShape, initialState: {}, requiredCapabilities: [], entry: { resourceId, sha256: 'a'.repeat(64), byteLength: 30, mediaType: 'text/html' } } } } })
  const entry = { artifact: teachingArtifactSchema.parse({ artifactId, activityId: activity.activityId, title: payload.title, display: 'page', activeRevisionId: revisionId,
    latestRevisionId: revisionId, latestCandidateId: id(), shelved: false, relatedArtifactId: null, createdAt: now() }), revision, issue: '原页面需要重新核对。' }
  const shelf = vi.fn(async () => { entry.artifact.shelved = !entry.artifact.shelved }), retry = vi.fn(async () => {}), open = vi.fn(async () => {})
  const artifacts = { entries: [entry], error: '', opened: artifactId, centerIds: [artifactId], readOnly: false, activity, shelf, retry } as unknown as TeachingArtifactsController
  const events: { seq: number; [key: string]: unknown }[] = [], locate = vi.fn(async (_record: TeachingToolRecordView) => ({ ok: true as const }))
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('/events?') ? events.filter(event => event.seq > Number(new URL(url, 'http://localhost').searchParams.get('after'))) : conversation))))
  let latestAgent: ReturnType<typeof useAgentSession>
  function View() {
    const agent = latestAgent = useAgentSession(client, sessionId, true)
    return <ActivitySessionContext.Provider value={{ workspace, agent } as never}>
      <ActivityConversation activity={activity} spaceKey="personal" namespace="workspace-card" artifacts={artifacts} onOpenArtifact={open} onLocateTool={locate} />
    </ActivitySessionContext.Provider>
  }
  const render = async () => act(async () => { root.render(<View />); await settle() })
  return { render, activity, artifacts, entry, shelf, retry, open, locate, conversation, events, sessionId, runId, commandId, refresh: async () => act(async () => { await latestAgent.refresh(); await settle() }) }
}
const click = async (label: string) => act(async () => {
  const button = [...host.querySelectorAll('button')].find(button => button.textContent === label)
  expect(button).toBeDefined(); button!.click(); await settle()
})
it('keeps an unshelved generated page accessible through its original card, tool-area open, retry and shelf actions', async () => {
  const f = await fixture(); await f.render()
  expect(host.querySelector('[data-artifact-id="' + f.entry.artifact.artifactId + '"]')?.textContent).toContain('互动解释页')
  await click('在工具区打开'); expect(f.open).toHaveBeenCalledExactlyOnceWith(f.entry.artifact.artifactId)
  await click('重试页面'); expect(f.retry).toHaveBeenCalledExactlyOnceWith(f.entry)
  await click('收纳'); expect(f.shelf).toHaveBeenCalledExactlyOnceWith(f.entry)
  await f.render(); expect(host.textContent).toContain('取消收纳')
})

it('uses v2 progress for inert page previews and locates the original material from the real tool result', async () => {
  const f = await fixture(), materialCommandId = id(), documentId = id(), modelOperationId = id()
  const source = { kind: 'personal-material', activityId: f.entry.artifact.activityId, materialId: documentId, version: 2, sha256: 'c'.repeat(64) }
  const material = { source, text: '原笔记中固定的说明', start: 4, end: 13 }
  f.artifacts.entries = []
  Object.assign(f.conversation.runs[0]!, { state: 'running', completedAt: null })
  f.conversation.lastSeq = 5
  f.conversation.tools = [{ operationId: materialCommandId, runId: f.runId, name: 'read_personal_material', state: 'completed',
    feedback: { outcome: 'success', text: JSON.stringify(material), images: [] } }]
  const event = (seq: number, kind: string, body: Record<string, unknown>) => ({ seq, kind, body: { runId: f.runId, ...body }, sessionId: f.sessionId, eventId: id(), version: 1, createdAt: now() })
  const previousRunId = id(), previousCommandId = id()
  f.conversation.runs.push({ ...f.conversation.runs[0]!, runId: previousRunId, state: 'completed', completedAt: now() })
  f.events.push(event(1, 'tool-prepared', { runId: previousRunId, commandId: previousCommandId, callId: 'page-call' }),
    event(2, 'tool-result', { runId: previousRunId, commandId: previousCommandId, callId: 'page-call', name: 'generate_teaching_artifact', outcome: { state: 'completed', feedback: { outcome: 'success', text: '原页面', images: [] }, result: {} } }),
    event(3, 'model-progress', { stepId: id(), operationId: modelOperationId, revision: 1, text: '', tools: [{ callId: 'page-call', name: 'generate_teaching_artifact', property: 'html', text: '<h2>正在形成的解释</h2><script>window.bad=1</script>' }] }),
    event(4, 'tool-result', { commandId: materialCommandId, callId: 'material-call', name: 'read_personal_material', outcome: { state: 'completed', feedback: f.conversation.tools[0]!.feedback, result: material } }))
  await f.render()
  const preview = host.querySelector<HTMLIFrameElement>('iframe[title="正在形成的学习页面"]')
  expect(preview).not.toBeNull(); expect(preview!.getAttribute('sandbox')).toBe('')
  expect(preview!.srcdoc).toContain('正在形成的解释'); expect(preview!.srcdoc).not.toContain('<script>')
  const record = host.querySelector<HTMLDetailsElement>('[data-command-id="' + materialCommandId + '"]')!
  expect(record).not.toBeNull(); record.open = true
  await click('定位来源')
  expect(f.locate).toHaveBeenCalledOnce()
  expect(f.locate.mock.calls[0]![0]).toMatchObject({ commandId: materialCommandId, runId: f.runId, name: 'read_personal_material', result: material })
  f.artifacts.entries = [f.entry]; f.conversation.runs[0]!.state = 'completed'; f.conversation.lastSeq++
  await f.refresh(); await f.render()
  expect(host.querySelector('iframe[title="正在形成的学习页面"]')).toBeNull()
  expect(host.querySelectorAll('[data-artifact-id="' + f.entry.artifact.artifactId + '"]')).toHaveLength(1)
  expect(host.querySelectorAll('[data-command-id="' + materialCommandId + '"]')).toHaveLength(1)
})

it('locates the fixed read_work file from its real result.file and host toolSource', async () => {
  const f = await fixture(), commandId = id()
  f.artifacts.entries = []
  const file = workFileSchema.parse({ objectId: id(), contentId: id(), name: 'alu.sv', kind: 'code', encoding: 'utf8',
    mediaType: 'text/x-systemverilog', value: 'module alu; endmodule' })
  const toolSource = { label: file.name, contentId: file.contentId }
  const result = { file, toolSource }, feedback = { outcome: 'success' as const, text: JSON.stringify({ state: 'completed', file }), images: [] }
  f.conversation.tools = [{ operationId: commandId, runId: f.runId, name: 'read_work', state: 'completed', feedback }]
  f.events.push({ seq: 1, sessionId: f.sessionId, eventId: id(), version: 1, kind: 'tool-result', createdAt: now(),
    body: { runId: f.runId, commandId, callId: 'read-work', name: 'read_work', outcome: { state: 'completed', feedback, result } } })
  await f.render()
  await click('定位来源')
  expect(f.locate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ commandId, runId: f.runId,
    arguments: { objectId: file.objectId, contentId: file.contentId }, source: toolSource, result }))
  expect(host.querySelector('[data-command-id="' + commandId + '"]')?.textContent).toContain('alu.sv')
})

it('locates the original execution by the host component and request identities in result.toolSource', async () => {
  const f = await fixture(), commandId = id(), requestId = id(), contentId = id()
  f.artifacts.entries = []
  Object.assign(f.conversation.runs[0]!, { state: 'waiting', completedAt: null })
  const { environmentId, spaceId, principalId } = f.activity.identity
  const query = executionQuerySchema.parse({ requestId, inputDigest: 'a'.repeat(64),
    scope: { environmentId, spaceId, principalId, activityId: f.activity.activityId }, executionRef: id(), state: 'queued',
    statusKnowledge: 'confirmed', stopRequested: false, confirmedSeq: 0, reason: null, output: null })
  const toolSource = { label: '原表格实验', componentKey: 'table-aggregation', requestId, contentId }
  const result = { query, toolSource }, feedback = { outcome: 'success' as const, text: JSON.stringify({ state: 'accepted', query }), images: [] }
  f.conversation.tools = [{ operationId: commandId, runId: f.runId, name: 'course_operation', state: 'accepted', feedback }]
  f.events.push({ seq: 1, sessionId: f.sessionId, eventId: id(), version: 1, kind: 'tool-result', createdAt: now(),
    body: { runId: f.runId, commandId, callId: 'original-execution', name: 'course_operation', outcome: { state: 'accepted', feedback, result } } })
  await f.render()
  await click('定位原结果')
  expect(f.locate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ commandId, runId: f.runId,
    name: 'course_operation', source: toolSource, result }))
  expect(host.querySelector('[data-command-id="' + commandId + '"]')?.textContent).toContain('原表格实验')
})

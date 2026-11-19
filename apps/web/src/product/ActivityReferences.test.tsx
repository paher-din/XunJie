import 'fake-indexeddb/auto'
import { webcrypto } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { LearningActivity, WorkSync, WorkView } from '@xunjie/contracts/learning-data'
import type { QuestionDraftSync, QuestionDraftView } from '@xunjie/contracts/question-drafts'
import type { AnyExecutionAction } from '@xunjie/contracts/execution'
import type { AdapterContext, AdapterResult } from '../tool-execution/adapter'
import { aluCoursePackage } from '../../../../components/alu-experiment/package.mjs'
import { runtimeAction } from '../tool-execution/runtime-action'
import { ActivityReferences } from './ActivityReferences'
import { useActivitySession } from './ActivitySession'

// Run the course package builder in Node (its assets are filesystem resources),
// with a DOM only for the React lifecycle under test.
const { JSDOM } = createRequire(import.meta.url)('jsdom')
let dom: InstanceType<typeof JSDOM>

// Keep the real provider lifecycle, durable draft/work/action stores, receiver,
// execution controller and transports. Only unrelated UI/Agent services and the
// simulation boundary are replaced; Chrome covers the actual ALU runtime.
vi.mock('../components/workspace/references', () => ({
  DraftReferencesProvider: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('./AgentInteraction', () => ({ useAgentInteraction: () => ({ ready: false }) }))
vi.mock('./skills', () => ({ useSkillCatalog: () => ({ data: null }), draftSkillOption: vi.fn() }))
vi.mock('../tool-execution/adapters', async () => {
  const { AdapterRegistry } = await import('../tool-execution/adapter')
  return { createAdapterRegistry: () => new AdapterRegistry([{
    ...adapterIdentity, protocolVersion: 3, handles: () => true, validateAndFreeze() {},
    run: (action: AnyExecutionAction, context: AdapterContext) => simulate(action, context),
  }]) }
})

let root: Root, host: HTMLDivElement, activity: LearningActivity
let session: ReturnType<typeof useActivitySession>
let adapterIdentity: { adapterId: string; adapterVersion: number }
let simulate: ReturnType<typeof vi.fn<(action: AnyExecutionAction, context: AdapterContext) => Promise<AdapterResult>>>
let work: WorkView, draft: QuestionDraftView
let namespace: string
const result: AdapterResult = { output: { completed: true }, diagnostics: [],
  resources: [{ name: 'result.json', mediaType: 'application/json', text: '{"completed":true}' }] }
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200 })
function CaptureSession() { session = useActivitySession(); return null }

async function render(status = activity.status, authorized = true) {
  // A status response is a fresh object, just like LearningApp.changeStatus.
  activity = structuredClone({ ...activity, status })
  await act(async () => {
    root.render(createElement(ActivityReferences, { activity, spaceKey: 'school', namespace, authorized,
      children: createElement(CaptureSession) }))
    await settle()
  })
}
async function action() {
  return runtimeAction(session.workspace, activity, activity.course!.components![0], 'browser-execution')
}
async function completed(requestId: string) {
  await vi.waitFor(async () => {
    expect((await session.execution.query(requestId))?.state).toBe('succeeded')
    expect((await session.actions.read(requestId))?.phase).toBe('accepted')
  }, { timeout: 1500, interval: 10 })
}

beforeEach(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
  vi.stubGlobal('window', dom.window)
  vi.stubGlobal('document', dom.window.document)
  vi.stubGlobal('localStorage', dom.window.localStorage)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('navigator', { locks: { request: async (...args: unknown[]) => (args.at(-1) as (lock: object) => unknown)({}) } })
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  localStorage.clear()
  const course = await aluCoursePackage(), manifest = course.release.components![0].definition.manifest
  if (manifest.formatVersion !== 3) throw new Error('Expected current ALU runtime')
  adapterIdentity = { adapterId: manifest.runtime.adapterId, adapterVersion: manifest.runtime.adapterVersion }
  simulate = vi.fn(async (_action, context) => { await context.checkpoint(); return result })
  namespace = crypto.randomUUID()
  const identity = { environmentId: crypto.randomUUID(), spaceId: crypto.randomUUID(), principalId: crypto.randomUUID(),
    kind: 'school' as const, name: 'Lifecycle test' }
  activity = { activityId: crypto.randomUUID(), identity, goal: 'ALU', question: '', references: [],
    status: 'open', createdAt: new Date().toISOString(), target: { environmentId: identity.environmentId, serviceId: crypto.randomUUID(), version: 1 },
    course: { ...course.release, associationId: crypto.randomUUID(), courseId: course.course.courseId,
      taskId: course.task.taskId, courseName: course.course.name, taskTitle: course.task.title, contentDigest: 'a'.repeat(64) } }
  work = { revision: 1, files: [{ objectId: crypto.randomUUID(), contentId: crypto.randomUUID(),
    name: 'alu.sv', kind: 'code', encoding: 'utf8', mediaType: 'text/plain', value: 'module alu; endmodule' }] }
  draft = { draftId: crypto.randomUUID(), revision: 0, revisionId: null, question: '', references: [] }
  const workReceipts = new Map<string, WorkView>(), draftReceipts = new Map<string, QuestionDraftView>()
  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit = {}) => {
    const route = url.replace('/api/learning/', ''), input = options.body ? JSON.parse(options.body as string) : undefined
    if (route === `workspaces/${activity.activityId}`) {
      if (input) {
        const change = input as WorkSync
        work = { revision: work.revision + 1, files: change.files }; workReceipts.set(change.requestId, work)
      }
      return response(work)
    }
    if (route.startsWith(`workspaces/${activity.activityId}/receipts/`)) return response(workReceipts.get(route.split('/').at(-1)!) ?? null)
    if (route === `drafts/${activity.activityId}`) {
      if (input) {
        const change = input as QuestionDraftSync
        draft = { draftId: change.draftId, revision: draft.revision + 1, revisionId: crypto.randomUUID(), question: change.question, references: [] }
        draftReceipts.set(change.requestId, draft)
      }
      return response(draft)
    }
    if (route.startsWith(`drafts/${activity.activityId}/receipts/`)) return response(draftReceipts.get(route.split('/').at(-1)!) ?? null)
    if (route === `intents/${activity.activityId}` || route === `intents/${activity.activityId}/capabilities`) return response([])
    const executionPath = `executions/${activity.activityId}`
    if (route === `${executionPath}/history`) return response({ entries: [], nextCursor: null })
    if (route === `${executionPath}/checkpoints`) return response({ items: [], nextCursor: null })
    if (route === `${executionPath}/sessions` || route === `${executionPath}/agent-pending` || route.startsWith(`${executionPath}/agent-stops/`)) return response([])
    if (route.startsWith(executionPath)) {
      const requestId = input?.action?.requestId ?? route.slice(executionPath.length + 1).split('/')[0]
      return response((await session.execution.receiver.store.read(session.workspace.key, requestId))?.query ?? null)
    }
    throw new Error('Unexpected route ' + route)
  }))
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await render()
  await vi.waitFor(() => {
    expect(session.workspace.snapshot().ready).toBe(true)
    expect(session.draft.snapshot().ready).toBe(true)
    expect(session.actions.snapshot().ready).toBe(true)
    expect(session.sessions.snapshot().ready).toBe(true)
  })
})
afterEach(async () => {
  await act(async () => { root?.unmount(); await settle() })
  host?.remove(); dom.window.close(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals()
})

it('runs after closing and reopening without reloading or losing edits and question drafts', async () => {
  const file = session.workspace.snapshot().files[0]
  session.workspace.edit(file.objectId, '// kept across status changes\nmodule alu; endmodule')
  session.draft.change('Keep this unsent question', [])
  await Promise.all([session.workspace.protect(), session.draft.protect()])
  for (let cycle = 0; cycle < 2; cycle++) {
    await render('closed'); await render('open')
    expect(session.workspace.snapshot().files[0].value).toContain('kept across status changes')
    expect(session.draft.snapshot().question).toBe('Keep this unsent question')
    const next = await action()
    await session.execution.submit(next)
    await completed(next.requestId)
    expect(simulate.mock.calls.filter(([fixed]) => fixed.requestId === next.requestId)).toHaveLength(1)
  }
  // Keeping controllers alive must still honor current authorization.
  await render('open', false)
  const denied = await action()
  await expect(session.execution.submit(denied)).rejects.toThrow('forbidden')
  await render('open', true)
  const resumed = await action()
  await session.execution.submit(resumed); await completed(resumed.requestId)
  expect(simulate).toHaveBeenCalledTimes(3)
})

it('keeps an already accepted execution on its original identity across close and reopen', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  simulate.mockImplementation(async (_action, context) => { await gate; await context.checkpoint(); return result })
  const original = await action()
  try {
    await session.execution.submit(original)
    await vi.waitFor(() => expect(simulate).toHaveBeenCalledTimes(1))
    const accepted = await session.execution.query(original.requestId)
    await render('closed'); await render('open')
    release(); await completed(original.requestId)
    expect((await session.execution.query(original.requestId))?.executionRef).toBe(accepted?.executionRef)
    expect(simulate).toHaveBeenCalledTimes(1)
  } finally { release() }
})

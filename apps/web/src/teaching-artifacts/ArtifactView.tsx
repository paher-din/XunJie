import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { z } from 'zod'
import { componentChangeSchema, componentStateName, componentReply, matchesComponentState } from '@xunjie/contracts/components'
import { actionInputSchema } from '@xunjie/contracts/action-intents'
import { teachingConversationSchema, teachingStudentResponseInputSchema, teachingStudentResponseReceiptSchema } from '@xunjie/contracts/teaching-agent'
import { teachingArtifactReferenceCopy } from '@xunjie/contracts/teaching-artifacts-reference'
import { questionWorkBasisSchema } from '@xunjie/contracts/question-drafts'
import { personalMaterialVersionContentSchema } from '@xunjie/contracts/personal-materials'
import { teachingArtifactExecutionInputSchema, type TeachingArtifactRevision } from '@xunjie/contracts/teaching-artifacts'
import { useActivitySession } from '../product/ActivitySession'
import { learningRequest } from '../product/learningTransport'
import { createComponentBridge, componentError } from '../component-host/bridge'
import { useSemanticSource, componentSource } from '../components/workspace/references/SemanticSource'
import { artifactExecutionAction } from './execution'
import { ArtifactExecutions } from './ArtifactExecutions'
import { actionScopeFromWorkspaceKey } from '../reliable-workspace/actions'
import { agentControlStore, protectAgentOperation, deliverAgentOperation, confirmAgentOperation } from '../reliable-workspace/agent-controls'
import { frameTheme, hashBytes, artifactViewUrl, bootstrapMessage } from './frame'
import type { TeachingArtifactsController } from './useTeachingArtifacts'

const responseInput = z.object({ requestId: z.uuid(), text: z.string().min(1).max(4000), questionId: z.uuid().optional(), optionId: z.string().max(64).optional() }).strict()

export function ArtifactView({ revision, controller }: { revision: TeachingArtifactRevision; controller: TeachingArtifactsController }) {
  const session = useActivitySession(), { workspace, execution, actions } = session
  const sessionLatest = useRef(session); sessionLatest.current = session
  const frame = useRef<HTMLIFrameElement>(null), active = useRef(controller)
  active.current = controller
  const work = useSyncExternalStore(workspace.subscribe, workspace.snapshot)
  const stateFile = work.files.find(file => file.name === componentStateName(revision.binding.key))
  const [issue, setIssue] = useState('')
  const [ready, setReady] = useState(false)
  const selected = useSemanticSource({ source: stateFile ? componentSource(controller.activity, revision.binding, stateFile.objectId, stateFile.contentId) : null,
    title: revision.payload.title, content: revision.payload, ...(stateFile ? { basis: questionWorkBasisSchema.parse(stateFile) } : {}),
    locate: () => { frame.current?.focus(); frame.current?.scrollIntoView({ block: 'nearest' }); return { ok: true } } })
  const select = useRef(selected); select.current = selected
  const loaded = useRef<() => void>(() => {})
  useEffect(() => {
    let live = true
    let bridge: ReturnType<typeof createComponentBridge> | undefined, port: MessagePort | undefined
    let endComposition: (() => void) | undefined
    const allowed = () => live && active.current.authorized && !workspace.accessDenied()
    const writable = () => allowed() && !workspace.isReadOnly() && active.current.activity.status === 'open'
    const request = (route: string, body?: unknown) => {
      if (!allowed()) throw new Error('forbidden')
      const { activity, spaceKey, namespace } = active.current
      return learningRequest(activity, spaceKey, namespace, route, body)
    }
    const requireCapability = (capability: typeof revision.payload.requiredCapabilities[number]) => {
      if (!allowed() || !revision.payload.requiredCapabilities.includes(capability)) throw new Error('capability-unavailable')
    }
    const retire = () => { bridge?.close(); port?.close(); endComposition?.(); endComposition = undefined }
    loaded.current = () => {
      retire()
      setReady(false)
      const channel = new MessageChannel()
      const mount = createComponentBridge(workspace, revision.activityId, revision.binding, allowed, undefined, () => {}, undefined, undefined, workspace.isReadOnly())
      bridge = mount; port = channel.port1
      const assert = () => { if (!allowed() || bridge !== mount) throw new Error('stale-connection') }
      channel.port1.onmessage = async event => {
        const raw = event.data
        if (!raw || raw.connectionId !== mount.connectionId || raw.instanceId !== mount.instanceId || !live) return
        if (JSON.stringify(raw).length > 2100000) return
        if (raw.method === 'artifact.interaction') {
          active.current.guards.set(revision.artifactId, { composing: raw.payload?.composing === true, focused: raw.payload?.focused === true })
          if (raw.payload?.composing === true && !endComposition && !workspace.isReadOnly())
            void workspace.trackInput(new Promise<void>(resolve => { endComposition = resolve }))
          else if (raw.payload?.composing !== true) { endComposition?.(); endComposition = undefined }
          return
        }
        const userGesture = navigator.userActivation.isActive && raw.gesture === true
        try {
          assert()
          let payload: unknown
          if (raw.method === 'workspace.change') {
            if (!writable()) throw new Error('forbidden')
            componentChangeSchema.parse(raw.payload)
            const key = `${mount.instanceId}:${raw.payload.operationId}`
            // All input reaches the shared leave guard before its first async protection attempt.
            await workspace.retainInput(key, raw, value => mount.handle(value))
            payload = await mount.handle(raw)
            setIssue('')
          } else if (raw.method === 'artifact.capabilities') {
            payload = { capabilities: revision.payload.requiredCapabilities.filter(capability => !workspace.isReadOnly()
              || ['workspace.read', 'materials.read', 'observations.read'].includes(capability)), readOnly: !writable(),
              execution: active.current.activity.course?.components?.filter(binding => binding.definition.manifest.requiredCapabilities.includes('execution.submit' as never))
                .map(binding => ({ componentKey: binding.key, operations: binding.definition.manifest.formatVersion === 3
                  ? binding.definition.manifest.runtime.operations.map(operation => operation.operationId) : [] })) ?? [] }
          } else if (raw.method === 'artifact.reference') {
            requireCapability('reference.select'); if (!writable()) throw new Error('forbidden')
            const input = z.union([z.object({ text: z.string().min(1).max(20000) }).strict(), z.object({ objectId: z.string().max(48) }).strict()]).parse(raw.payload)
            const typeId = 'text' in input ? 'teaching-artifact-text' : 'teaching-artifact-objects'
            const target = 'text' in input ? { text: input.text } : { objectIds: [input.objectId] }
            teachingArtifactReferenceCopy(typeId, target, revision.payload)
            await workspace.leave(); assert()
            payload = select.current({ kind: 'semantic', formatVersion: 1, typeId, version: 1, target, start: 0, end: 1 }, () => frame.current?.getBoundingClientRect() ?? null)
          } else if (raw.method === 'artifact.respond') {
            requireCapability('student.respond'); if (!writable()) throw new Error('forbidden')
            const input = responseInput.parse(raw.payload)
            await workspace.leave(); assert()
            const key = JSON.stringify([workspace.key, 'artifact-response', input.requestId])
            let existing = await agentControlStore.read(key)
            if (existing?.draft && existing.draft.text !== JSON.stringify(input)) throw new Error('conflict')
            if (!existing && userGesture) existing = await agentControlStore.change(key, saved => saved ?? {
              key, scope: workspace.key, draft: { text: JSON.stringify(input), expectedVersion: 1, editing: false } })
            if (existing?.receipt) payload = existing.receipt
            else {
              let pending = existing?.pending
              if (!pending) {
                const queued = actions.snapshot().items.find(item => item.input.requestId === input.requestId)
                if (queued) {
                  if (!('draft' in queued.input) || queued.input.draft.question !== input.text) throw new Error('conflict')
                  payload = { requestId: input.requestId }
                  channel.port1.postMessage({ hostApiVersion: 1, connectionId: mount.connectionId, instanceId: mount.instanceId,
                    messageId: crypto.randomUUID(), replyTo: raw.messageId, method: raw.method, payload })
                  return
                }
                if (!userGesture) throw new Error('forbidden')
                const conversation = teachingConversationSchema.parse(await request(`agent/${revision.activityId}/conversation`)); assert()
                const question = input.questionId ? conversation.questions.find(question => question.questionId === input.questionId) : undefined
                if (question) {
                  const fixed = teachingStudentResponseInputSchema.parse({ requestId: input.requestId, questionVersion: question.version, waitVersion: question.waitVersion,
                    answer: input.optionId ? { kind: 'choice', optionId: input.optionId } : { kind: 'text', text: input.text } })
                  pending = { requestId: input.requestId, route: `agent/${revision.activityId}/questions/${question.questionId}/responses`,
                    queryRoute: `agent/${revision.activityId}/responses/${input.requestId}`, input: fixed }
                  await protectAgentOperation(key, workspace.key, pending)
                } else {
                  if (input.questionId) throw new Error('resource-unavailable')
                  const receiver = actions.snapshot().receivers.find(receiver => receiver.kind === 'question')
                  if (!receiver || !sessionLatest.current.inputInteraction.ready) throw new Error('capability-unavailable')
                  const file = workspace.snapshot().files.find(file => file.name === componentStateName(revision.binding.key))
                  const fixed = actionInputSchema.parse({ requestId: input.requestId, scope: actionScopeFromWorkspaceKey(workspace.key), receiver,
                    draft: { token: input.requestId, question: input.text, references: [], bases: [] }, works: file ? [file] : [], evidence: [],
                    ...(sessionLatest.current.inputInteraction.delivery ? { delivery: sessionLatest.current.inputInteraction.delivery } : {}) })
                  await actions.createFixedQuestion(fixed); payload = { requestId: input.requestId }
                }
              }
              if (pending) {
                payload = await deliverAgentOperation(pending, request, value => teachingStudentResponseReceiptSchema.parse(value))
                await confirmAgentOperation(key, pending, payload)
              }
            }
          } else if (raw.method === 'artifact.material') {
            requireCapability('materials.read')
            const { materialId, version } = z.object({ materialId: z.uuid(), version: z.number().int().positive().optional() }).strict().parse(raw.payload)
            const course = active.current.activity.course, material = course?.materials.find(item => item.materialId === materialId)
            if (course && material) {
              const saved = await request(`releases/${course.releaseId}/materials/${materialId}`) as { contentBase64: string }
              const bytes = Uint8Array.from(atob(saved.contentBase64), char => char.charCodeAt(0))
              if (bytes.length !== material.byteLength || await hashBytes(bytes) !== material.sha256) throw new Error('resource-unavailable')
              payload = { materialId, title: material.title, sha256: material.sha256, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
            } else {
              if (!version) throw new Error('invalid-input')
              const saved = personalMaterialVersionContentSchema.parse(await request(`materials/${revision.activityId}/${materialId}/versions/${version}`))
              const bytes = new TextEncoder().encode(saved.text)
              if (saved.material.activityId !== revision.activityId || saved.material.materialId !== materialId || saved.version.materialId !== materialId
                || saved.version.version !== version || bytes.length !== saved.version.byteLength || await hashBytes(bytes) !== saved.version.sha256)
                throw new Error('resource-unavailable')
              payload = { materialId, version, title: saved.version.name, sha256: saved.version.sha256, byteLength: saved.version.byteLength, text: saved.text }
            }
          } else if (raw.method === 'artifact.observation') {
            if (!revision.payload.requiredCapabilities.some(capability => ['observations.read', 'execution.submit'].includes(capability))) throw new Error('capability-unavailable')
            const { requestId } = z.object({ requestId: z.uuid() }).strict().parse(raw.payload)
            payload = await execution.query(requestId)
          } else if (raw.method === 'artifact.execute') {
            requireCapability('execution.submit'); if (!writable()) throw new Error('forbidden')
            const input = teachingArtifactExecutionInputSchema.parse(raw.payload)
            const binding = active.current.activity.course?.components?.find(binding => binding.key === input.componentKey)
            if (!binding || !binding.definition.manifest.requiredCapabilities.includes('execution.submit' as never)) throw new Error('forbidden')
            const operationKey = JSON.stringify([workspace.key, 'artifact-execution', input.requestId])
            const savedOperation = (await agentControlStore.read(operationKey))?.pending
            if (savedOperation && JSON.stringify(savedOperation.input.request) !== JSON.stringify(input)) throw new Error('conflict')
            const existing = await execution.query(input.requestId)
            if (!existing) {
              const key = operationKey
              let fixed = savedOperation
              if (fixed && JSON.stringify(fixed.input.request) !== JSON.stringify(input)) throw new Error('conflict')
              if (!fixed) {
                if (!userGesture) throw new Error('forbidden')
                const action = await artifactExecutionAction(workspace, active.current.activity, revision, execution, input)
                fixed = { requestId: input.requestId, route: 'execution.submit', queryRoute: 'execution.query', input: { request: input, action } }
                await protectAgentOperation(key, workspace.key, fixed)
              }
              assert(); await execution.submit(fixed.input.action as Parameters<typeof execution.submit>[0])
            }
            payload = { requestId: input.requestId }
          } else if (raw.method === 'artifact.error') { setIssue('页面脚本未能继续；已有输入和原内容仍保留。'); payload = {} }
          else { payload = await mount.handle(raw); if (raw.method === 'component.ready') setReady(true) }
          assert()
          channel.port1.postMessage(raw.method.startsWith('artifact.')
            ? { hostApiVersion: 1, connectionId: mount.connectionId, instanceId: mount.instanceId, messageId: crypto.randomUUID(),
              replyTo: raw.messageId, method: raw.method, payload }
            : componentReply(mount, raw, { payload }, crypto.randomUUID()))
        } catch (cause) {
          if (!live || bridge !== mount) return
          setIssue('当前操作尚未确认，输入仍保留；连接恢复后会按原身份核对。')
          channel.port1.postMessage({ hostApiVersion: 1, connectionId: mount.connectionId, instanceId: mount.instanceId,
            messageId: crypto.randomUUID(), replyTo: raw.messageId, method: raw.method, payload: {}, error: componentError(cause) })
        }
      }
      frame.current?.contentWindow?.postMessage(bootstrapMessage(revision, mount.connectionId, mount.instanceId, !writable()), '*', [channel.port2])
    }
    const updateTheme = new MutationObserver(() => {
      // A theme change never remounts the student's focused input.
      port?.postMessage({ method: 'host.theme', connectionId: bridge?.connectionId, instanceId: bridge?.instanceId, payload: frameTheme() })
    })
    updateTheme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => { live = false; retire(); updateTheme.disconnect(); active.current.guards.delete(revision.artifactId); loaded.current = () => {} }
  }, [revision, workspace, execution, actions])
  if (!work.ready || !stateFile || !matchesComponentState(revision.binding, revision.activityId, stateFile))
    return <p className="teaching-artifact-note" role="status">正在核对页面与原输入；确认后继续。</p>
  return <div className="teaching-artifact-view">
    {issue && <p className="learning-error" role="alert">{issue}</p>}
    {!ready && <p className="teaching-artifact-note" role="status">正在恢复页面中的原输入…</p>}
    <iframe ref={frame} title={revision.payload.title} sandbox="allow-scripts" referrerPolicy="no-referrer"
      aria-hidden={!ready} style={ready ? undefined : { visibility: 'hidden' }}
      allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"
      onLoad={() => loaded.current()} src={artifactViewUrl(revision, controller.activity, controller.spaceKey, controller.namespace)} />
    <ArtifactExecutions revision={revision} activity={controller.activity} authorized={controller.authorized} />
  </div>
}

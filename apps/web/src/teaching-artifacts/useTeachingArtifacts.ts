import { useCallback, useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { acceptsState, componentStateName, componentStateSchema } from '@xunjie/contracts/components'
import type { LearningActivity, WorkFile } from '@xunjie/contracts/learning-data'
import { teachingConversationSchema } from '@xunjie/contracts/teaching-agent'
import { teachingArtifactSchema, teachingArtifactRevisionSchema, teachingArtifactCandidateSchema, teachingArtifactReceiptSchema,
  type TeachingArtifact, type TeachingArtifactRevision, type TeachingArtifactReceipt } from '@xunjie/contracts/teaching-artifacts'
import { useActivitySession } from '../product/ActivitySession'
import { learningRequest, workspaceScope } from '../product/learningTransport'
import { checkRevision, hashBytes, artifactViewUrl } from './frame'
import { agentControlStore, protectAgentOperation, confirmAgentOperation, type PendingAgentOperation } from '../reliable-workspace/agent-controls'
import { useViewPolling } from '../product/useViewPolling'

export interface ArtifactEntry { artifact: TeachingArtifact; revision: TeachingArtifactRevision | null; issue: string }
export interface ArtifactViewGuard { composing: boolean; focused: boolean }
export function useTeachingArtifacts(activity: LearningActivity, spaceKey: string, namespace: string, authorized: boolean) {
  const { workspace, viewActive = true } = useActivitySession()
  const [entries, setEntries] = useState<ArtifactEntry[]>([]), [error, setError] = useState('')
  const displayed = useRef(entries); displayed.current = entries
  const [opened, setOpened] = useState<string | null>(null)
  const [centerIds, setCenterIds] = useState<string[]>([])
  const guards = useRef(new Map<string, ArtifactViewGuard>())
  const revisions = useRef(new Map<string, TeachingArtifactRevision>())
  const issues = useRef(new Map<string, string>())
  const retries = useRef(new Set<string>())
  const scope = workspaceScope(namespace, activity), generation = useRef(0)
  const request = useCallback((route: string, body?: unknown) => learningRequest(activity, spaceKey, namespace,
    `artifacts/${activity.activityId}${route ? '/' + route : ''}`, body), [activity, spaceKey, namespace])
  const readRevision = useCallback(async (artifactId: string, revisionId: string) => {
    const cached = revisions.current.get(revisionId)
    if (cached) return cached
    const value = teachingArtifactRevisionSchema.parse(await request(`${artifactId}/revisions/${revisionId}`))
    const resource = z.object({ resourceId: z.uuid(), sha256: z.string(), byteLength: z.number(), contentBase64: z.string(), mediaType: z.literal('text/html') })
      .parse(await request(`${artifactId}/revisions/${revisionId}/resource`))
    const bytes = Uint8Array.from(atob(resource.contentBase64), char => char.charCodeAt(0))
    if (resource.resourceId !== value.resourceId || resource.sha256 !== value.sha256 || bytes.length !== value.byteLength
      || await hashBytes(bytes) !== value.sha256) throw new Error('页面固定资源校验未通过。')
    revisions.current.set(revisionId, value)
    workspace.registerActivityBinding(value.binding)
    return value
  }, [request, workspace])
  const receipt = useCallback(async (pending: PendingAgentOperation) => {
    const known = await request(pending.queryRoute)
    if (known) return teachingArtifactReceiptSchema.parse(known)
    try { return teachingArtifactReceiptSchema.parse(await request(pending.route, pending.input)) }
    catch (cause) { const saved = await request(pending.queryRoute).catch(() => null)
      if (saved) return teachingArtifactReceiptSchema.parse(saved)
      throw cause
    }
  }, [request])
  const safeToAdopt = (artifactId: string) => !document.hidden && !guards.current.get(artifactId)?.composing && !guards.current.get(artifactId)?.focused
  const refresh = useCallback(async (autoAdopt = true): Promise<void> => {
    const epoch = generation.current
    const current = () => epoch === generation.current
    if (!authorized) return
    const list = z.array(teachingArtifactSchema).parse(await request(''))
    const shown: ArtifactEntry[] = []
    for (const artifact of list) {
      if (!current()) return
      if (list.some(item => item.relatedArtifactId === artifact.artifactId)) issues.current.set(artifact.artifactId, '新版无法保留这页的输入，已另开一页；这页和原输入继续保留。')
      let revision: TeachingArtifactRevision | null = null
      try {
        if (!workspace.isReadOnly()) {
          const shelfKey = JSON.stringify([workspace.key, 'artifact-shelf', artifact.artifactId])
          const shelf = (await agentControlStore.read(shelfKey))?.pending
          if (shelf) {
            try {
              const confirmed = await receipt(shelf); await confirmAgentOperation(shelfKey, shelf, confirmed); artifact.shelved = shelf.input.shelved === true
              if (issues.current.get(artifact.artifactId)?.startsWith('收纳结果尚未确认')) issues.current.delete(artifact.artifactId)
            }
            catch { issues.current.set(artifact.artifactId, '收纳结果尚未确认；原页面和输入仍保留，连接恢复后会核对原操作。') }
          }
        }
        let candidateId = artifact.latestCandidateId
        const recoveringKey = workspace.pendingRemoteOperation()
        if (recoveringKey) {
          const recovering = (await agentControlStore.read(recoveringKey))?.pending
          if (recovering) {
            const candidate = teachingArtifactCandidateSchema.parse(await request('candidates/' + recovering.input.candidateId))
            if (candidate.artifactId === artifact.artifactId) candidateId = candidate.candidateId
          }
        }
        const operationKey = JSON.stringify([workspace.key, 'artifact-adopt', candidateId])
        const saved = !workspace.isReadOnly() && candidateId ? await agentControlStore.read(operationKey) : undefined
        const pending = saved?.pending
        const activeRevision = pending ? pending.input.expectedRevisionId as string | null : artifact.activeRevisionId
        if (activeRevision) revision = await readRevision(artifact.artifactId, activeRevision)
        if (candidateId && (artifact.activeRevisionId !== artifact.latestRevisionId || pending) && autoAdopt && workspace.snapshot().ready && !workspace.isReadOnly() && activity.status === 'open') {
          let candidate = teachingArtifactCandidateSchema.parse(await request('candidates/' + candidateId))
          const proposed = await readRevision(artifact.artifactId, candidate.revisionId)
          if (proposed.origin && !pending) {
            const conversation = teachingConversationSchema.parse(await learningRequest(activity, spaceKey, namespace, `agent/${activity.activityId}/conversation`))
            const run = conversation.runs.find(run => run.runId === proposed.origin!.runId)
            const tool = conversation.tools.find(tool => tool.commandId === proposed.origin!.commandId)
            const published = teachingArtifactReceiptSchema.safeParse(tool?.result?.artifact)
            if (!run || run.stopRequested || !['running', 'dispatching', 'waiting', 'completed'].includes(run.state)
              || tool?.outcome !== 'completed' || !published.success || published.data.candidateId !== candidateId) {
              if (run?.stopRequested || run?.state === 'stopped') issues.current.set(artifact.artifactId, '生成已停止；原页面和输入仍保留。')
              shown.push({ artifact, revision, issue: issues.current.get(artifact.artifactId) ?? '' })
              continue
            }
          }
          if (candidate.status === 'check-failed') issues.current.set(artifact.artifactId, candidate.checks.filter(check => !check.passed).map(check => check.reason).join('；'))
          const checkKey = JSON.stringify([workspace.key, 'artifact-check', candidateId])
          let checkPending = (await agentControlStore.read(checkKey))?.pending
          if (candidate.status === 'candidate' || checkPending || retries.current.delete(candidateId)) {
            if (!checkPending) {
              const check = await checkRevision(proposed, artifactViewUrl(proposed, activity, spaceKey, namespace))
              if (!current()) return
              const requestId = crypto.randomUUID()
              checkPending = { requestId, route: 'check', queryRoute: 'checks/' + requestId, input: { requestId, candidateId,
                revisionId: proposed.revisionId, resourceSha256: proposed.sha256, ...check } }
              await protectAgentOperation(checkKey, scope, checkPending)
            }
            let original = await request(checkPending.queryRoute)
            if (!original) {
              try { original = await request(checkPending.route, checkPending.input) }
              catch (cause) { original = await request(checkPending.queryRoute).catch(() => null); if (!original) throw cause }
            }
            candidate = teachingArtifactCandidateSchema.parse(original)
            await confirmAgentOperation(checkKey, checkPending, candidate)
            if (candidate.status === 'check-failed') issues.current.set(artifact.artifactId, '新版未能完成装载与状态检查，原页面和输入仍保留。')
          }
          if ((candidate.status === 'adoptable' || pending) && safeToAdopt(artifact.artifactId)) {
            let adopted: TeachingArtifactReceipt | undefined
            let fixed = pending
            await workspace.adoptRemote(operationKey, async head => {
              if (!current()) throw new Error('stale-connection')
              if (!fixed) {
                const requestId = crypto.randomUUID()
                fixed = { requestId, route: 'adopt', queryRoute: 'receipts/' + requestId, input: { requestId, candidateId,
                  expectedRevisionId: artifact.activeRevisionId, expectedWorkRevision: head.revision,
                  expectedContentId: head.files.find(file => file.name === componentStateName(proposed.binding.key))?.contentId ?? null } }
                await protectAgentOperation(operationKey, scope, fixed)
              }
              adopted = await receipt(fixed)
              return adopted
            }, (local, remote) => rebaseArtifactInput(local, remote, proposed), async () => {
              while (!safeToAdopt(artifact.artifactId)) {
                if (!current()) throw new Error('stale-connection')
                await new Promise(resolve => setTimeout(resolve, 50))
              }
              if (!current()) throw new Error('stale-connection')
            })
            if (fixed) await confirmAgentOperation(operationKey, fixed, adopted)
            if (!current()) return
            issues.current.delete(artifact.artifactId)
            if (adopted?.outcome === 'forked') issues.current.set(artifact.artifactId, '新版无法保留这页的输入，已另开一页；这页和原输入继续保留。')
            // Re-read fixed identities: an incompatible revision has a new artifact and state instance.
            return refresh(false)
          }
        }
      } catch (cause) {
        revision ??= displayed.current.find(entry => entry.artifact.artifactId === artifact.artifactId)?.revision ?? null
        const code = (cause as { code?: string }).code
        if (code === 'conflict' || code === 'identity-conflict') {
          const key = workspace.pendingRemoteOperation()
          if (key) {
            const original = (await agentControlStore.read(key))?.pending
            if (original) await confirmAgentOperation(key, original, { rejected: true })
            await workspace.rejectRemoteOperation(key)
          }
        }
        if (code !== 'conflict' && !(cause instanceof Error && cause.message === 'conflict'))
          issues.current.set(artifact.artifactId, cause instanceof Error ? cause.message : '页面暂时无法启用，原内容仍保留。')
      }
      shown.push({ artifact, revision, issue: issues.current.get(artifact.artifactId) ?? '' })
    }
    if (current()) {
      setEntries(previous => JSON.stringify(previous) === JSON.stringify(shown) ? previous : shown)
      setError('')
    }
  }, [authorized, request, readRevision, workspace, activity.status, receipt, scope])
  useEffect(() => {
    ++generation.current; setEntries([]); setOpened(null); setCenterIds([]); revisions.current.clear(); issues.current.clear(); guards.current.clear()
    return () => { ++generation.current }
  }, [scope])
  useViewPolling(async () => {
    const epoch = generation.current
    try { await refresh() } catch { if (epoch === generation.current) setError('学习页面暂时无法读取，原页面与输入仍保留。') }
  }, scope, 1500, viewActive)
  const shelf = async (entry: ArtifactEntry) => {
    if (workspace.isReadOnly()) return
    await workspace.leave()
    const key = JSON.stringify([workspace.key, 'artifact-shelf', entry.artifact.artifactId])
    let fixed = (await agentControlStore.read(key))?.pending
    if (!fixed) {
      const requestId = crypto.randomUUID()
      fixed = { requestId, route: 'shelf', queryRoute: 'receipts/' + requestId,
        input: { requestId, artifactId: entry.artifact.artifactId, shelved: !entry.artifact.shelved } }
      await protectAgentOperation(key, scope, fixed)
    }
    const confirmed = await receipt(fixed)
    await confirmAgentOperation(key, fixed, confirmed)
    await refresh(false)
  }
  const retry = async (entry: ArtifactEntry) => {
    if (workspace.isReadOnly()) return
    await workspace.leave()
    retries.current.add(entry.artifact.latestCandidateId)
    await refresh()
  }
  return { entries, error, opened, setOpened, centerIds, setCenterIds, guards: guards.current, shelf, readOnly: workspace.isReadOnly(),
    retry, refresh: () => refresh(false), activity, spaceKey, namespace, authorized }
}
export type TeachingArtifactsController = ReturnType<typeof useTeachingArtifacts>

/** Apply the same declared field mapping to input that arrived after adoption's fixed baseline. */
function rebaseArtifactInput(local: WorkFile, remote: WorkFile, revision: TeachingArtifactRevision): WorkFile {
  if (remote.name !== componentStateName(revision.binding.key)) throw new Error('conflict')
  const old = componentStateSchema.parse(JSON.parse(local.value)), next = componentStateSchema.parse(JSON.parse(remote.value))
  const state = structuredClone(revision.payload.initialState) as Record<string, unknown>
  const original = old.content as Record<string, unknown>
  for (const field of Object.keys(original)) {
    const target = revision.mapping.find(mapping => mapping.from === field)?.to ?? field
    state[target] = original[field]
  }
  if (!acceptsState(revision.payload.stateShape, state)) throw new Error('conflict')
  return { ...remote, contentId: crypto.randomUUID(), value: JSON.stringify({ ...next, operationId: crypto.randomUUID(), content: state }) }
}

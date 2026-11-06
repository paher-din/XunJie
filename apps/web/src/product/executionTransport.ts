import { executionAcceptanceSchema, executionQuerySchema, executionControlReceiptSchema, checkpointPageSchema, type CheckpointPage, type ExecutionControlReceipt, type ExecutionAction, type ExecutionAcceptance,
  type ExecutionControl, type ExecutionQuery } from '@xunjie/contracts/execution'
import { z } from 'zod'
import type { LearningActivity } from '@xunjie/contracts/learning-data'
import { learningRequest } from './learningTransport'
import type { ExecutionTransport } from '../tool-execution/retention'
import { executionHistoryPageSchema, executionArtifactSchema, type ExecutionHistoryEntry } from '@xunjie/contracts/execution'

/** Same execution facts over the owner's HTTP boundary; no second verb set for another location. */
export function createExecutionTransport(activity: LearningActivity, spaceKey: string, namespace: string): ExecutionTransport {
  const path = 'executions/' + activity.activityId
  const request = (suffix: string, body?: unknown) => learningRequest(activity, spaceKey, namespace, path + suffix, body)
  return {
    history: async () => {
      const entries: ExecutionHistoryEntry[] = [], cursors = new Set<string>()
      let cursor: string | null = null
      do {
        const page = executionHistoryPageSchema.parse(await request('/history' + (cursor ? '/' + cursor : '')))
        for (const entry of page.entries) {
          if (entry.query.scope.activityId !== activity.activityId
            || entry.query.scope.environmentId !== activity.identity.environmentId
            || entry.query.scope.spaceId !== activity.identity.spaceId
            || entry.query.scope.principalId !== activity.identity.principalId) throw new Error('forbidden')
          entries.push(entry)
        }
        cursor = page.nextCursor
        if (cursor && cursors.has(cursor)) throw new Error('corrupt')
        if (cursor) cursors.add(cursor)
      } while (cursor)
      return entries
    },
    artifact: async (requestId: string) => {
      const value = await request('/' + requestId + '/artifact')
      if (value === null) return null
      const artifact = executionArtifactSchema.parse(value)
      if (artifact.requestId !== requestId || artifact.scope.activityId !== activity.activityId
        || artifact.scope.environmentId !== activity.identity.environmentId || artifact.scope.spaceId !== activity.identity.spaceId
        || artifact.scope.principalId !== activity.identity.principalId) throw new Error('forbidden')
      const bytes = new TextEncoder().encode(artifact.text)
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('')
      if (hash !== artifact.sha256 || bytes.length !== artifact.byteLength) throw new Error('corrupt')
      for(const resource of artifact.resources??[]) {
        const data=new TextEncoder().encode(resource.text)
        const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',data))].map(byte=>byte.toString(16).padStart(2,'0')).join('')
        if(data.length!==resource.byteLength||digest!==resource.sha256)throw new Error('corrupt')
      }
      return artifact
    },
    accept: async (action: ExecutionAction, acceptance: ExecutionAcceptance) => executionQuerySchema.parse(
      await request('', { action, acceptance: executionAcceptanceSchema.parse(acceptance) })),
    read: async (requestId: string) => {
      const value = await request('/' + requestId)
      return value === null ? null : executionQuerySchema.parse(value)
    },
    report: async (requestId: string, query: ExecutionQuery) => executionQuerySchema.parse(
      await request('/' + requestId + '/report', executionQuerySchema.parse(query))),
    stop: async (requestId: string, stopId: string, reason: string) => executionQuerySchema.parse(
      await request('/' + requestId + '/stop', { stopId, reason })),
    result: async (requestId: string, value: { contentId: string; output: unknown; text: string; name: string
      mediaType: string; sha256: string; byteLength: number; resources?:import('@xunjie/contracts/execution').ExecutionRetainedResource[] }) => {
      const known = await request('/' + requestId + '/result', value)
      return known === null ? null : executionQuerySchema.parse(known)
    },
  }
}

export interface SessionTransport {
  list(): Promise<ExecutionQuery[]>
  checkpoints?(cursor?: string): Promise<CheckpointPage>
  create(action: ExecutionAction): Promise<ExecutionQuery>
  read(requestId: string): Promise<ExecutionQuery | null>
  control(requestId: string, control: ExecutionControl): Promise<ExecutionQuery>
  controlReceipt?(requestId: string, controlId: string): Promise<ExecutionControlReceipt | null>
  stop(requestId: string, stopId: string, reason: string): Promise<ExecutionQuery>
}

/** A native session reuses accept, control, query and stop; no second execution owner exists. */
export function createSessionTransport(activity: LearningActivity, spaceKey: string, namespace: string): SessionTransport {
  const path = 'executions/' + activity.activityId
  const request = (suffix: string, body?: unknown) => learningRequest(activity, spaceKey, namespace, path + suffix, body)
  return {
    list: async () => z.array(executionQuerySchema).parse(await request('/sessions')),
    checkpoints: async (cursor?: string) => checkpointPageSchema.parse(await request('/checkpoints' + (cursor ? '/' + cursor : ''))),
    create: async (action: ExecutionAction) => executionQuerySchema.parse(await request('', { action })),
    read: async (requestId: string) => {
      const value = await request('/' + requestId)
      return value === null ? null : executionQuerySchema.parse(value)
    },
    control: async (requestId: string, control: ExecutionControl) => executionQuerySchema.parse(
      await request('/' + requestId + '/control', control)),
    controlReceipt: async (requestId: string, controlId: string) => {
      const value = await request('/' + requestId + '/controls/' + controlId)
      return value === null ? null : executionControlReceiptSchema.parse(value)
    },
    stop: async (requestId: string, stopId: string, reason: string) => executionQuerySchema.parse(
      await request('/' + requestId + '/stop', { stopId, reason })),
  }
}

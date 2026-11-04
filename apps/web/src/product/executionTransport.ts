import { executionAcceptanceSchema, executionQuerySchema, executionControlReceiptSchema, checkpointPageSchema, type CheckpointPage, type ExecutionControlReceipt, type ExecutionAction, type ExecutionAcceptance,
  type ExecutionControl, type ExecutionQuery } from '@xunjie/contracts/execution'
import { z } from 'zod'
import type { LearningActivity } from '@xunjie/contracts/learning-data'
import { learningRequest } from './learningTransport'
import type { ExecutionTransport } from '../tool-execution/retention'

/** Same execution facts over the owner's HTTP boundary; no second verb set for another location. */
export function createExecutionTransport(activity: LearningActivity, spaceKey: string, namespace: string): ExecutionTransport {
  const path = 'executions/' + activity.activityId
  const request = (suffix: string, body?: unknown) => learningRequest(activity, spaceKey, namespace, path + suffix, body)
  return {
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
      mediaType: string; sha256: string; byteLength: number }) => {
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

import { executionAcceptanceSchema, executionQuerySchema, type ExecutionAction, type ExecutionAcceptance,
  type ExecutionQuery } from '@xunjie/contracts/execution'
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

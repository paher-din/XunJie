import { z } from 'zod'
import { actionInputSchema } from '@xunjie/contracts/action-intents'
import { createActivitySchema } from '@xunjie/contracts/learning-data'

export const firstQuestionToken = (requestId: string) => 'first-question:' + requestId
export const firstQuestionKey = (activityId: string) => 'xj:first-question:' + activityId
const firstQuestionSchema = z.object({
  requestId: z.uuid(), question: createActivitySchema.shape.question.refine(value => !!value.trim()),
  input: actionInputSchema.optional(),
}).strict().refine(value => !value.input || value.input.requestId === value.requestId
  && value.input.draft.question === value.question && value.input.draft.token === firstQuestionToken(value.requestId)
  && value.input.receiver.kind === 'question', { message: '首问与固定请求不匹配。' })
export type FirstQuestion = z.infer<typeof firstQuestionSchema>

const pendingActivityRequestSchema = z.object({ version: z.literal(1), input: createActivitySchema,
  firstQuestion: firstQuestionSchema.nullable(),
}).strict().refine(value => !value.firstQuestion || value.firstQuestion.question === value.input.question,
  { message: '首问与活动创建内容不匹配。' })
export type PendingActivityRequest = z.infer<typeof pendingActivityRequestSchema>

export function parsePendingActivityRequest(value: unknown): PendingActivityRequest {
  // Older creation records did not retain the send intent. Keep their original
  // activity identity without inferring permission to submit an Agent question.
  const legacy = createActivitySchema.safeParse(value)
  return legacy.success ? { version: 1, input: legacy.data, firstQuestion: null } : pendingActivityRequestSchema.parse(value)
}

export function readFirstQuestion(activityId: string): FirstQuestion | null {
  const raw = localStorage.getItem(firstQuestionKey(activityId))
  return raw ? firstQuestionSchema.parse(JSON.parse(raw)) : null
}

/** Creation retries and action retries must retain the same identity and bytes. */
export function rememberFirstQuestion(activityId: string, value: FirstQuestion): FirstQuestion {
  const next = firstQuestionSchema.parse(value), previous = readFirstQuestion(activityId)
  if (previous && (previous.requestId !== next.requestId || previous.question !== next.question
    || previous.input && next.input && JSON.stringify(previous.input) !== JSON.stringify(next.input)))
    throw new Error('不能用新的内容或身份替换原首问。')
  const saved = previous?.input ? previous : next
  localStorage.setItem(firstQuestionKey(activityId), JSON.stringify(saved))
  return saved
}

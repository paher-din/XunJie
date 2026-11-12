import { replaceEqualDeep } from '@tanstack/react-query'
import type { LearningActivity } from '@xunjie/contracts/learning-data'
import { teachingConversationSchema, type TeachingConversation } from '@xunjie/contracts/teaching-agent'
import type { LearningReadCache } from './learning-read-cache'
import { learningSubjectRequest, workspaceScope } from './learningTransport'

export function readConversation(activity: Pick<LearningActivity, 'identity' | 'activityId'>,
  spaceKey: string, namespace: string, cache?: LearningReadCache, maxAgeMs = 0) {
  const cacheKey = 'conversation:' + workspaceScope(namespace, activity)
  const load = async () => {
    const value = teachingConversationSchema.parse(await learningSubjectRequest(activity.identity, spaceKey, namespace,
      `agent/${activity.activityId}/conversation`))
    const cached = cache?.peek<TeachingConversation>(spaceKey, cacheKey)
    return cached && cached.cursor > value.cursor ? cached : replaceEqualDeep(cached, value)
  }
  return cache ? cache.read(spaceKey, cacheKey, load, { maxAgeMs, preferPending: true }) : load()
}

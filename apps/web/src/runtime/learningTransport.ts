import type { LearningActivity } from '@xunjie/contracts/learning-data'

export function workspaceScope(namespace: string, activity: LearningActivity) {
  const { environmentId, spaceId, principalId } = activity.identity
  return JSON.stringify([namespace, environmentId, spaceId, principalId, activity.activityId])
}

/** Same-origin production endpoint; the server derives identity and checks the expected subject. */
export async function learningRequest(activity: LearningActivity, spaceKey: string, namespace: string,
  route: string, body?: unknown): Promise<unknown> {
  const response = await fetch('/api/learning/' + route, { method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin', redirect: 'error', cache: 'no-store',
    headers: { 'content-type': 'application/json', 'x-xj-space': spaceKey, 'x-xj-namespace': namespace,
      'x-xj-expected-subject': [activity.identity.environmentId, activity.identity.spaceId, activity.identity.principalId].join('.') },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) })
  let value: unknown
  try { value = await response.json() }
  catch { throw Object.assign(new Error('原服务返回了不完整响应。'), { code: response.ok ? 'corrupt' : 'unavailable' }) }
  if (!response.ok) {
    const failure = value as { error?: string }
    throw Object.assign(new Error(failure?.error ?? 'unavailable'), { code: failure?.error ?? 'unavailable' })
  }
  return value
}

// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { LearningActivity } from '@xunjie/contracts/learning-data'
import { PersonalProjectPlan, usePersonalProject } from './PersonalProjectPlan'
it('loads a personal activity plan from its actual owner and refuses a plan for another activity', async () => {
  const id = () => crypto.randomUUID(), identity = { kind: 'personal' as const, name: '学生', environmentId: id(), spaceId: id(), principalId: id() }
  const activity: LearningActivity = { activityId: id(), identity, target: { environmentId: identity.environmentId, serviceId: id(), version: 1 }, status: 'open', question: '', goal: '学习递归', references: [], createdAt: new Date().toISOString() }
  const project = { activityId: activity.activityId, identity, target: activity.target, projectId: id(), workspaceSessionId: id(), operationId: id(), sourceSessionId: id(), inputId: id(), createdAt: activity.createdAt,
    content: { title: '递归练习', goal: '理解基例', stages: [{ title: '找出基例', goal: '写出最小输入的结果' }], materialRefs: [] } }
  let wrongOwner = false
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
    expect(url).toBe('/api/learning/activities/' + activity.activityId + '/project')
    expect(new Headers(options.headers).get('x-xj-expected-subject')).toBe([identity.environmentId, identity.spaceId, identity.principalId].join('.'))
    return new Response(JSON.stringify(wrongOwner ? { ...project, activityId: id() } : project))
  }))
  function Plan({ namespace }: { namespace: string }) { const value = usePersonalProject(activity, 'personal', namespace, true); return value.project ? <PersonalProjectPlan project={value.project} /> : <p>{value.error}</p> }
  const host = document.createElement('div'), root = createRoot(host)
  try {
    await act(async () => { root.render(<Plan namespace="first" />); await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(host.textContent).toContain('写出最小输入的结果'); expect(host.querySelector('input')).toBeNull()
    wrongOwner = true
    await act(async () => { root.render(<Plan namespace="second" />); await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(host.textContent).toContain('不属于当前工作区'); expect(host.textContent).not.toContain('写出最小输入的结果')
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals() }
})

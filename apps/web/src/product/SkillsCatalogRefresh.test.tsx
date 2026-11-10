// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { TeachingSkillCatalogEntry } from '@xunjie/contracts/agent-skills'
import type { SpaceIdentity } from '@xunjie/contracts/spaces'
import { DraftReferencesProvider } from '../components/workspace/references/DraftReferences'
import { WorkspaceReferenceComposer } from '../components/workspace/references/WorkspaceReferences'
import { ReliableQuestionDraft } from '../reliable-workspace/draft'
import type { ReliableActions } from '../reliable-workspace/actions'
import { PersonalSkillsSettings } from './PersonalSkillsSettings'
import { useSkillCatalog, draftSkillOption } from './skills'

let root: Root, host: HTMLDivElement
const disposals: (() => void)[] = []
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0)) }
const response = (value: unknown) => new Response(JSON.stringify(value))
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => { root.unmount(); disposals.splice(0).forEach(dispose => dispose()); await settle() })
  host.remove(); vi.useRealTimers(); vi.unstubAllGlobals()
})

it.each([false, true])('refreshes defaults after confirmed settings while retaining explicit original pins (explicit=%s)', async explicit => {
  const identity: SpaceIdentity = { environmentId: crypto.randomUUID(), spaceId: crypto.randomUUID(), principalId: crypto.randomUUID(), kind: 'personal', name: '学生' }
  const activityId = crypto.randomUUID(), namespace = crypto.randomUUID(), key = JSON.stringify([namespace, identity.environmentId, identity.spaceId, identity.principalId, activityId])
  const sourceId = crypto.randomUUID(), extraId = crypto.randomUUID()
  const entry = (skillId: string, version: number, name: string): TeachingSkillCatalogEntry => ({ skillId, version, name, description: '固定学习指导',
    source: 'test-package', packageVersion: `${version}.0`, digest: 'a'.repeat(64), attachments: [], origin: 'personal', selected: false, disabled: false, required: false,
    metadata: { name: skillId === sourceId ? 'source-skill' : 'extra-skill', description: '固定学习指导', dependencies: [], conflicts: [], 'allowed-tools': [] } })
  const sourceV1 = entry(sourceId, 1, '默认 Skill'), sourceV2 = entry(sourceId, 2, '默认 Skill'), extra = entry(extraId, 1, '补充 Skill')
  const pin = (skill: TeachingSkillCatalogEntry) => ({ skillId: skill.skillId, version: skill.version })
  let defaultVersion = 1, holdNextRead = false, releaseActivity: (() => void) | undefined
  const catalog = () => ({ skills: defaultVersion === 1 ? [{ ...sourceV1, selected: true }, sourceV2, extra] : [{ ...sourceV2, selected: true }, extra],
    selections: [{ range: { kind: 'all' }, skills: [{ skillId: sourceId, version: defaultVersion }] }] })
  const writes: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (route: string, options: RequestInit) => {
    const bound = `/api/learning/agent/${activityId}/skills`
    if (options.method === 'POST') {
      expect(route).toBe(bound + '/select')
      writes.push(JSON.parse(options.body as string)); defaultVersion = 2; holdNextRead = true
      return response(catalog())
    }
    expect(route).toBe(bound)
    const value = catalog()
    if (holdNextRead) {
      holdNextRead = false
      return new Promise<Response>(resolve => { releaseActivity = () => resolve(response(value)) })
    }
    return response(value)
  }))
  const draft = new ReliableQuestionDraft(key, { read: async () => ({ draftId: crypto.randomUUID(), revision: 0, revisionId: null, question: '', references: [] }),
    receipt: async () => null, sync: vi.fn() })
  await draft.open(); draft.suspend(); disposals.push(() => draft.dispose())
  draft.change('保留原问题和选择位置', [])
  if (explicit) draft.selectSkills([pin(sourceV1)])
  const queue = { receivers: [], ready: true, active: true, items: [] }
  const actions = { subscribe: () => () => {}, snapshot: () => queue } as unknown as ReliableActions
  function Activity({ visible }: { visible: boolean }) {
    const skills = useSkillCatalog(identity, 'personal', namespace, activityId)
    return createElement('div', { hidden: !visible, inert: !visible }, createElement(DraftReferencesProvider, { workspaceKey: key, draft, actions, viewActive: visible,
      skillCatalog: { options: (skills.data?.skills ?? []).map(draftSkillOption),
        defaults: (skills.data?.skills ?? []).filter(skill => skill.selected && skill.origin === 'personal').map(pin),
        loading: skills.loading, error: skills.error, isCurrent: skills.isCurrent, reload: () => { void skills.reload() } },
      children: createElement(WorkspaceReferenceComposer) }))
  }
  function Flow() {
    const [settings, setSettings] = useState(false)
    return createElement('div', null,
      createElement('button', { onClick: () => setSettings(true) }, '打开设置'),
      settings && createElement('div', null, createElement(PersonalSkillsSettings, { identity, spaceKey: 'personal', namespace, activityId }),
        createElement('button', { onClick: () => setSettings(false) }, '返回活动')),
      createElement(Activity, { visible: !settings }))
  }
  const click = async (text: string) => act(async () => {
    Array.from(host.querySelectorAll('button')).find(button => button.textContent === text)!.click(); await settle()
  })
  await act(async () => { root.render(createElement(Flow)); await settle() })
  await click('打开对话')
  const textarea = host.querySelector('textarea')!
  textarea.focus(); textarea.setSelectionRange(3, 7)
  await click('打开设置')
  const updated = Array.from(host.querySelectorAll<HTMLElement>('.personal-skills .skill-entry')).find(item => item.textContent!.includes('版本 2'))!
  await act(async () => { updated.querySelector<HTMLInputElement>('input')!.click(); await settle() })
  expect(writes).toEqual([expect.objectContaining({ skills: [pin(sourceV2)] })])
  expect(releaseActivity).toBeTypeOf('function')
  await click('返回活动')
  const extraCheckbox = () => Array.from(host.querySelectorAll<HTMLLabelElement>('.wr-skills label')).find(label => label.textContent!.includes('补充 Skill'))!.querySelector<HTMLInputElement>('input')!
  // The visible old catalog cannot be turned into a new explicit snapshot while its refresh is pending.
  expect(extraCheckbox().disabled).toBe(true)
  await act(async () => { extraCheckbox().click(); await settle() })
  expect(draft.capture().skills).toEqual(explicit ? [pin(sourceV1)] : undefined)
  await act(async () => { releaseActivity!(); await settle() })
  expect(extraCheckbox().disabled).toBe(false)
  expect(draft.capture().skills).toEqual(explicit ? [pin(sourceV1)] : undefined)
  await act(async () => { extraCheckbox().click(); await settle() })
  expect(draft.capture().skills).toEqual([pin(explicit ? sourceV1 : sourceV2), pin(extra)])
  expect(host.querySelector('textarea')).toBe(textarea)
  expect(draft.snapshot().question).toBe('保留原问题和选择位置')
})

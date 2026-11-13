// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SpaceIdentity } from '@xunjie/contracts/spaces'
import type { TeachingSkillCatalogEntry } from '@xunjie/contracts/agent-skills'
import { PersonalSkillsSettings } from './PersonalSkillsSettings'

const identity: SpaceIdentity = {
  environmentId: crypto.randomUUID(), spaceId: crypto.randomUUID(), principalId: crypto.randomUUID(),
  name: '测试者', kind: 'personal',
}
const skill: TeachingSkillCatalogEntry = {
  skillId: crypto.randomUUID(), version: 1, name: '分析思路', description: '核对依据后再解释',
  metadata: { name: 'evidence-analysis', description: '核对依据后再解释', dependencies: [], conflicts: [], 'allowed-tools': [] },
  source: 'local-package', packageVersion: '1.0', digest: 'a'.repeat(64), attachments: [],
  origin: 'personal', selected: true, disabled: false, required: false,
}
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0)) }

let root: Root, host: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})
const mount = async (readOnly = false) => act(async () => {
  root.render(createElement(PersonalSkillsSettings, { identity, spaceKey: 'personal', namespace: 'test', readOnly }))
  await settle()
})

it('shows initial loading before distinguishing an empty library', async () => {
  let finish!: (value: Response) => void
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve })))
  await mount()
  expect(host.textContent).toContain('正在读取技能')
  expect(host.textContent).not.toContain('还没有技能')
  await act(async () => { finish(response({ skills: [], selections: [] })); await settle() })
  expect(host.textContent).toContain('还没有技能')
  expect(host.querySelector('.skill-toolbar')).toBeNull()
  expect(host.querySelector('.product-settings-heading')).toBeNull()
  await act(async () => host.querySelector<HTMLButtonElement>('.primary')!.click())
  expect(document.querySelector('[role="menu"]')?.textContent).toContain('本地导入')
})

it('provides search recovery and a read-only explanation without removing the library', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response({ skills: [skill], selections: [] })))
  await mount(true)
  expect(host.textContent).toContain('当前学习空间为只读')
  expect(host.textContent).toContain('分析思路')
  const search = host.querySelector<HTMLInputElement>('[aria-label="搜索技能"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, '不存在')
    search.dispatchEvent(new Event('input', { bubbles: true })); await settle()
  })
  expect(host.textContent).toContain('没有找到匹配的技能')
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === '清除搜索')!.click())
  expect(search.value).toBe('')
  expect(host.textContent).toContain('分析思路')
})

it('keeps the current library visible while a background refresh is named', async () => {
  let reads = 0, finish!: (value: Response) => void
  vi.stubGlobal('fetch', vi.fn(() => {
    reads++
    return reads === 1 ? Promise.resolve(response({ skills: [skill], selections: [] }))
      : new Promise<Response>(resolve => { finish = resolve })
  }))
  await mount()
  await act(async () => { window.dispatchEvent(new Event('focus')); await settle() })
  expect(host.textContent).toContain('分析思路')
  expect(host.querySelector('.settings-inline-status')?.textContent).toContain('正在刷新技能列表')
  await act(async () => { finish(response({ skills: [{ ...skill, name: '更新后的技能' }], selections: [] })); await settle() })
  expect(host.textContent).toContain('更新后的技能')
  expect(host.querySelector('.settings-inline-status')).toBeNull()
})

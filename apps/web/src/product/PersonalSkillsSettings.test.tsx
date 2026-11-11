// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SpaceIdentity } from '@xunjie/contracts/spaces'
import type { TeachingSkillCatalogEntry } from '@xunjie/contracts/agent-skills'
import { PersonalSkillsSettings } from './PersonalSkillsSettings'
import { Toaster, toast } from '@xunjie/ui/feedback'

let root: Root, host: HTMLDivElement
const identity: SpaceIdentity = { environmentId: crypto.randomUUID(), spaceId: crypto.randomUUID(), principalId: crypto.randomUUID(), name: '测试者', kind: 'personal' }
const skill: TeachingSkillCatalogEntry = { skillId: crypto.randomUUID(), version: 1, name: '分析思路', description: '核对依据后再解释',
  metadata: { name: 'evidence-analysis', description: '核对依据后再解释', dependencies: [], conflicts: [], 'allowed-tools': [] },
  source: 'local-package', packageVersion: '1.0', digest: 'a'.repeat(64), attachments: [], origin: 'personal', selected: true, disabled: false, required: false }
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0)) }
const expectToast = async (text: string, kind: 'error' | 'success') => {
  await act(async () => { await settle() })
  expect([...host.querySelectorAll(`[data-sonner-toast][data-type="${kind}"]`)].map(item => item.textContent).join('\n')).toContain(text)
}
const button = (label: string) => Array.from(host.querySelectorAll('button')).find(item => item.textContent === label)!
const click = async (label: string) => act(async () => { button(label).click(); await settle() })
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => { toast.dismiss(); root.unmount(); await settle() }); host.remove(); vi.unstubAllGlobals() })
const activityScopes = [undefined, crypto.randomUUID()]
const skillsRoute = (_activityId?: string) => '/api/learning/skills'
const mount = async (activityId?: string) => act(async () => {
  root.render(createElement('div', null, createElement(Toaster), createElement(PersonalSkillsSettings, { identity, spaceKey: 'personal', namespace: 'test', activityId }))); await settle()
})

it('allows retrying a failed catalog read and restores the skills', async () => {
  let failed = false
  vi.stubGlobal('fetch', vi.fn(async () => {
    if (!failed) { failed = true; throw new TypeError('network unavailable') }
    return response({ skills: [skill], selections: [] })
  }))
  await mount()
  await expectToast('Skills 暂时无法读取', 'error')
  await click('重新读取')
  expect(host.textContent).toContain(skill.name)
  expect(Array.from(host.querySelectorAll('button')).some(item => item.textContent === '重新读取')).toBe(false)
})

it.each(activityScopes)('uses the checkbox as a global enable switch without range configuration (activity=%s)', async activityId => {
  const writes: unknown[] = []
  let disabled = false
  vi.stubGlobal('fetch', vi.fn(async (route: string, options: RequestInit) => {
    expect(route).toBe(skillsRoute(activityId) + (options.method === 'POST' ? '/disable' : ''))
    if (options.method === 'POST') {
      const input = JSON.parse(options.body as string)
      writes.push(input); disabled = input.disabled
      return response({ ...skill, disabled, selected: !disabled })
    }
    return response({ skills: [{ ...skill, disabled, selected: !disabled }], selections: [] })
  }))
  await mount(activityId)
  const checkbox = () => host.querySelector<HTMLInputElement>('.skill-check input')!
  expect(checkbox().checked).toBe(true)
  expect(host.querySelector('[aria-label="使用范围"]')).toBeNull()
  await act(async () => { checkbox().click(); await settle() })
  expect(checkbox().checked).toBe(false)
  expect(checkbox().disabled).toBe(false)
  await act(async () => { checkbox().click(); await settle() })
  expect(writes).toEqual([
    expect.objectContaining({ skillId: skill.skillId, disabled: true }),
    expect.objectContaining({ skillId: skill.skillId, disabled: false }),
  ])
  expect(checkbox().checked).toBe(true)
})

it.each(activityScopes)('updates and retries identical bytes in the global library, including from an activity (activity=%s)', async activityId => {
  const writes: Record<string, unknown>[] = []
  let lost = true
  vi.stubGlobal('fetch', vi.fn(async (route: string, options: RequestInit) => {
    if (options.method !== 'POST') { expect(route).toBe(skillsRoute(activityId)); return response({ skills: [skill], selections: [] }) }
    expect(route).toBe(skillsRoute(activityId) + '/import')
    writes.push(JSON.parse(options.body as string))
    if (lost) { lost = false; throw new TypeError('synthetic ACK loss') }
    return response({ ...skill, version: 2 })
  }))
  await mount(activityId); await click('更新版本')
  const version = host.querySelectorAll<HTMLInputElement>('.skill-fields input')[1]
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(version, '2.0')
    version.dispatchEvent(new Event('input', { bubbles: true })); await settle()
  })
  const content = '---\nname: evidence-analysis\ndescription: 核对依据后再解释\n---\n先阅读原证据。\n'
  const file = new File([content], 'SKILL.md', { type: 'text/markdown' })
  Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode(content).buffer })
  await act(async () => {
    const input = host.querySelector<HTMLInputElement>('[aria-label="选择 Skill 包文件"]')!
    Object.defineProperty(input, 'files', { value: [file] })
    input.dispatchEvent(new Event('change', { bubbles: true })); await settle()
  })
  await click('导入新版本')
  expect(writes[0]).toMatchObject({ skillId: skill.skillId, source: skill.source, packageVersion: '2.0',
    files: [{ path: 'SKILL.md', encoding: 'utf8', content, mediaType: 'text/markdown' }] })
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(version, 'later')
    version.dispatchEvent(new Event('input', { bubbles: true })); await settle()
  })
  await click('核对原操作')
  expect(writes[1]).toEqual(writes[0]); expect(version.value).toBe('later')
  await expectToast('更新 Skill已确认', 'success')
})

it.each(activityScopes)('restores a disabled skill directly from its checkbox (activity=%s)', async activityId => {
  const writes: { route: string; input: unknown }[] = []
  let disabled = true
  vi.stubGlobal('fetch', vi.fn(async (route: string, options: RequestInit) => {
    if (options.method === 'POST') {
      writes.push({ route, input: JSON.parse(options.body as string) })
      disabled = JSON.parse(options.body as string).disabled
      return response({ ...skill, disabled, selected: !disabled })
    }
    expect(route).toBe(skillsRoute(activityId))
    return response({ skills: [{ ...skill, disabled, selected: !disabled }], selections: [] })
  }))
  await mount(activityId)
  const checkbox = host.querySelector<HTMLInputElement>('.skill-check input')!
  expect(checkbox.checked).toBe(false); expect(checkbox.disabled).toBe(false)
  await act(async () => { checkbox.click(); await settle() })
  expect(writes[0]).toEqual({ route: skillsRoute(activityId) + '/disable', input: expect.objectContaining({ skillId: skill.skillId, disabled: false }) })
  expect(checkbox.checked).toBe(true)
})

it('filters the list without changing selections and keeps import available', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response({ skills: [skill], selections: [] })))
  await mount()
  const search = host.querySelector<HTMLInputElement>('[aria-label="搜索技能"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, '不存在')
    search.dispatchEvent(new Event('input', { bubbles: true })); await settle()
  })
  expect(host.textContent).toContain('没有找到匹配的技能')
  expect(host.querySelector('.skill-entry')).toBeNull()
  await click('导入 Skill')
  expect(host.querySelector('[role="menu"]')?.textContent).toContain('本地导入')
  expect(host.querySelector('[role="menu"]')?.textContent).toContain('GitHub 导入')
})

it('opens the local picker and imports the selected skill', async () => {
  const writes: Record<string, unknown>[] = []
  let imported = false
  vi.stubGlobal('fetch', vi.fn(async (_route: string, options: RequestInit) => {
    if (options.method === 'POST') { writes.push(JSON.parse(options.body as string)); imported = true; return response(skill) }
    return response({ skills: imported ? [skill] : [], selections: [] })
  }))
  await mount()
  const input = host.querySelector<HTMLInputElement>('[aria-label="选择 Skill 包文件"]')!
  const picker = vi.spyOn(input, 'click').mockImplementation(() => {})
  await click('导入 Skill'); await click('本地导入')
  expect(picker).toHaveBeenCalledOnce()
  const content = '---\nname: evidence-analysis\ndescription: 依据\n---\n正文'
  const file = new File([content], 'SKILL.md', { type: 'text/markdown' })
  Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode(content).buffer })
  await act(async () => {
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    input.dispatchEvent(new Event('change', { bubbles: true })); await settle()
  })
  expect(host.textContent).toContain('已选择 1 个文件')
  const extra = new File(['依据'], 'notes.md', { type: 'text/markdown' })
  Object.defineProperty(file, 'webkitRelativePath', { value: 'example/SKILL.md' })
  Object.defineProperty(extra, 'webkitRelativePath', { value: 'example/references/notes.md' })
  Object.defineProperty(extra, 'arrayBuffer', { value: async () => new TextEncoder().encode('依据').buffer })
  await act(async () => {
    const directory = host.querySelector<HTMLInputElement>('[aria-label="选择 Skill 包目录"]')!
    Object.defineProperty(directory, 'files', { value: [file, extra] })
    directory.dispatchEvent(new Event('change', { bubbles: true })); await settle()
  })
  expect(host.textContent).toContain('已选择 2 个文件')
  await click('导入')
  expect(writes[0]).toMatchObject({ source: '本地文件', files: [
    { path: 'SKILL.md', content, encoding: 'utf8' }, { path: 'references/notes.md', content: '依据', encoding: 'utf8' },
  ] })
  await expectToast('导入 Skill已确认', 'success')
  expect(host.querySelector<HTMLInputElement>('.skill-check input')!.checked).toBe(true)
  expect(writes).toHaveLength(1)
})

it('imports the package returned for a GitHub URL through the existing skill endpoint', async () => {
  const calls: { route: string; body: Record<string, unknown> }[] = []
  const source = 'https://github.com/example/skills/tree/main/example'
  const files = [{ path: 'SKILL.md', encoding: 'utf8', content: '---\nname: example\ndescription: 示例\n---\n正文' }]
  vi.stubGlobal('fetch', vi.fn(async (route: string, options: RequestInit) => {
    if (options.method !== 'POST') return response({ skills: [skill], selections: [] })
    calls.push({ route, body: JSON.parse(options.body as string) })
    return response(route.endsWith('/github-package') ? { source, packageVersion: 'abcdef123456', files } : skill)
  }))
  await mount(); await click('导入 Skill'); await click('GitHub 导入')
  const input = host.querySelector<HTMLInputElement>('[aria-label="GitHub 地址"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, source)
    input.dispatchEvent(new Event('input', { bubbles: true })); await settle()
  })
  await act(async () => { input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle() })
  expect(calls[0]).toEqual({ route: '/api/learning/skills/github-package', body: { url: source } })
  expect(calls[1]).toMatchObject({ route: '/api/learning/skills/import', body: { source, packageVersion: 'abcdef123456', files } })
})

it('retries an unconfirmed global toggle with the same request', async () => {
  const writes: Record<string, unknown>[] = []
  let disabled = false
  vi.stubGlobal('fetch', vi.fn(async (_route: string, options: RequestInit) => {
    if (options.method === 'POST') {
      const input = JSON.parse(options.body as string); writes.push(input)
      if (writes.length === 1) throw new TypeError('lost receipt')
      disabled = input.disabled
      return response({ ...skill, disabled, selected: !disabled })
    }
    return response({ skills: [{ ...skill, disabled, selected: !disabled }], selections: [] })
  }))
  await mount()
  await act(async () => { host.querySelector<HTMLInputElement>('.skill-check input')!.click(); await settle() })
  await expectToast('操作结果尚未确认', 'error')
  await click('核对原操作')
  expect(writes).toHaveLength(2)
  expect(writes[1]).toEqual(writes[0])
  expect(host.querySelector<HTMLInputElement>('.skill-check input')!.checked).toBe(false)
})

it('keeps a rejected global toggle available for a fresh retry after rereading', async () => {
  const writes: Record<string, unknown>[] = []
  let disabled = false
  vi.stubGlobal('fetch', vi.fn(async (_route: string, options: RequestInit) => {
    if (options.method === 'POST') {
      const input = JSON.parse(options.body as string); writes.push(input)
      if (writes.length === 1) return new Response(JSON.stringify({ error: 'conflict' }), { status: 409 })
      disabled = input.disabled
      return response({ ...skill, disabled, selected: !disabled })
    }
    return response({ skills: [{ ...skill, disabled, selected: !disabled }], selections: [] })
  }))
  await mount()
  await act(async () => { host.querySelector<HTMLInputElement>('.skill-check input')!.click(); await settle() })
  await expectToast('配置发生冲突', 'error')
  await click('重新读取')
  expect(host.querySelector<HTMLInputElement>('.skill-check input')!.checked).toBe(false)
  await click('重试保存')
  expect(writes).toHaveLength(2)
  expect(writes[1].requestId).not.toBe(writes[0].requestId)
  expect(writes[1].disabled).toEqual(writes[0].disabled)
  expect(host.querySelector<HTMLInputElement>('.skill-check input')!.checked).toBe(false)
})

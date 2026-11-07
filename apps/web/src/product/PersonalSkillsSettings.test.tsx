// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SpaceIdentity } from '@xunjie/contracts/spaces'
import type { TeachingSkillCatalogEntry } from '@xunjie/contracts/agent-skills'
import { PersonalSkillsSettings } from './PersonalSkillsSettings'

let root: Root, host: HTMLDivElement
const identity: SpaceIdentity = { environmentId: crypto.randomUUID(), spaceId: crypto.randomUUID(), principalId: crypto.randomUUID(), name: '测试者', kind: 'personal' }
const skill: TeachingSkillCatalogEntry = { skillId: crypto.randomUUID(), version: 1, name: '分析思路', description: '核对依据后再解释',
  metadata: { name: 'evidence-analysis', description: '核对依据后再解释', dependencies: [], conflicts: [], 'allowed-tools': [] },
  source: 'local-package', packageVersion: '1.0', digest: 'a'.repeat(64), attachments: [], origin: 'personal', selected: true, disabled: false, required: false }
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0)) }
const button = (label: string) => Array.from(host.querySelectorAll('button')).find(item => item.textContent === label)!
const click = async (label: string) => act(async () => { button(label).click(); await settle() })
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => { root.unmount(); await settle() }); host.remove(); vi.unstubAllGlobals() })
const activityScopes = [undefined, crypto.randomUUID()]
const skillsRoute = (activityId?: string) => activityId ? `/api/learning/agent/${activityId}/skills` : '/api/learning/skills'
const mount = async (activityId?: string) => act(async () => {
  root.render(createElement(PersonalSkillsSettings, { identity, spaceKey: 'personal', namespace: 'test', activityId })); await settle()
})

it.each(activityScopes)('restores configured ranges and writes selections to the original owner (activity=%s)', async activityId => {
  const writes: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (route: string, options: RequestInit) => {
    if (options.method === 'POST') writes.push(JSON.parse(options.body as string))
    expect(route).toBe(skillsRoute(activityId) + (options.method === 'POST' ? '/select' : ''))
    return response({ skills: [skill], selections: [{ range: { kind: 'self-study' }, skills: [{ skillId: skill.skillId, version: 1 }] }] })
  }))
  await mount(activityId)
  const checkbox = () => host.querySelector<HTMLInputElement>('.skill-check input')!
  expect(checkbox().checked).toBe(false)
  await act(async () => { checkbox().click(); await settle() })
  const select = host.querySelector('select')!
  await act(async () => { select.value = JSON.stringify({ kind: 'self-study' }); select.dispatchEvent(new Event('change', { bubbles: true })); await settle() })
  expect(checkbox().checked).toBe(true)
  await act(async () => { checkbox().click(); select.value = JSON.stringify({ kind: 'all' }); select.dispatchEvent(new Event('change', { bubbles: true })); await settle() })
  expect(checkbox().checked).toBe(true)
  await click('应用到所选范围')
  expect(writes).toEqual([expect.objectContaining({ range: { kind: 'all' }, skills: [{ skillId: skill.skillId, version: 1 }] })])
})

it.each(activityScopes)('updates a real package and retries identical bytes at the original owner (activity=%s)', async activityId => {
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
  expect(host.textContent).toContain('更新 Skill已确认')
})

it.each(activityScopes)('disables at the original owner and allows removing a disabled selection (activity=%s)', async activityId => {
  const writes: { route: string; input: unknown }[] = []
  let disabled = false
  vi.stubGlobal('fetch', vi.fn(async (route: string, options: RequestInit) => {
    if (options.method === 'POST') { writes.push({ route, input: JSON.parse(options.body as string) }); disabled = true; return response({ ...skill, disabled }) }
    expect(route).toBe(skillsRoute(activityId))
    return response({ skills: [{ ...skill, disabled }], selections: [{ range: { kind: 'all' }, skills: [{ skillId: skill.skillId, version: 1 }] }] })
  }))
  await mount(activityId); await click('停用')
  expect(writes[0]).toEqual({ route: skillsRoute(activityId) + '/disable', input: expect.objectContaining({ skillId: skill.skillId, disabled: true }) })
  const checkbox = host.querySelector<HTMLInputElement>('.skill-check input')!
  expect(checkbox.checked).toBe(true); expect(checkbox.disabled).toBe(false)
  await act(async () => { checkbox.click(); await settle() })
  expect(checkbox.checked).toBe(false)
})

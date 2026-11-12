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
const expectToast = async (text: string, kind: 'error' | 'success' | 'warning' | 'info') => {
  await act(async () => { await settle() })
  expect([...host.querySelectorAll(`[data-sonner-toast][data-type="${kind}"]`)].map(item => item.textContent).join('\n')).toContain(text)
}
const button = (label: string) => Array.from(document.querySelectorAll('button')).find(item => item.textContent === label)!
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
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('暂时无法加载技能')
  await click('刷新列表')
  expect(host.textContent).toContain(skill.name)
  expect(Array.from(host.querySelectorAll('button')).some(item => item.textContent === '刷新列表')).toBe(false)
})

it.each(activityScopes)('uses the switch as a global enable control without range configuration (activity=%s)', async activityId => {
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
  const checkbox = () => host.querySelector<HTMLButtonElement>('[role="switch"]')!
  expect(checkbox().getAttribute('aria-checked')).toBe('true')
  expect(host.querySelector('[aria-label="使用范围"]')).toBeNull()
  await act(async () => { checkbox().click(); await settle() })
  expect(checkbox().getAttribute('aria-checked')).toBe('false')
  expect(checkbox().disabled).toBe(false)
  await expectToast('技能已停用', 'success')
  expect(host.querySelector('[data-sonner-toast] svg[data-icon="minus-circle"]')).not.toBeNull()
  await act(async () => { checkbox().click(); await settle() })
  expect(writes).toEqual([
    expect.objectContaining({ skillId: skill.skillId, disabled: true }),
    expect.objectContaining({ skillId: skill.skillId, disabled: false }),
  ])
  expect(checkbox().getAttribute('aria-checked')).toBe('true')
  await expectToast('技能已启用', 'success')
  expect(host.querySelector('[data-sonner-toast] svg[data-icon="check-circle"]')).not.toBeNull()
  expect(host.querySelectorAll('[data-sonner-toast]')).toHaveLength(1)
})

it.each(activityScopes)('updates and retries identical bytes in the global library, including from an activity (activity=%s)', async activityId => {
  const writes: Record<string, unknown>[] = []
  let lost = true, version = 1
  vi.stubGlobal('fetch', vi.fn(async (route: string, options: RequestInit) => {
    if (route.endsWith('/document')) return response({ skillId: skill.skillId, version, content: version === 1 ? '# 原始 Skill' : '# 更新后的正文' })
    if (options.method !== 'POST') { expect(route).toBe(skillsRoute(activityId)); return response({ skills: [{ ...skill, version }], selections: [] }) }
    expect(route).toBe(skillsRoute(activityId) + '/import')
    writes.push(JSON.parse(options.body as string))
    if (lost) { lost = false; throw new TypeError('synthetic ACK loss') }
    version = 2; return response({ ...skill, version })
  }))
  await mount(activityId)
  const trigger = host.querySelector<HTMLButtonElement>('.st-skill-copy')!
  await act(async () => { trigger.click(); await settle() })
  const input = document.querySelector<HTMLInputElement>('[aria-label="选择更新技能文件夹"]')!
  const picker = vi.spyOn(input, 'click').mockImplementation(() => {})
  await click('更新技能')
  expect(picker).toHaveBeenCalledOnce()
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  expect(host.querySelector('.skill-import')).toBeNull()
  const content = '---\nname: evidence-analysis\ndescription: 核对依据后再解释\n---\n先阅读原证据。\n'
  const file = new File([content], 'SKILL.md', { type: 'text/markdown' })
  Object.defineProperty(file, 'webkitRelativePath', { value: 'example/SKILL.md' })
  Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode(content).buffer })
  await act(async () => {
    Object.defineProperty(input, 'files', { value: [file] })
    input.dispatchEvent(new Event('change', { bubbles: true })); await settle()
  })
  expect(writes[0]).toMatchObject({ skillId: skill.skillId, source: skill.source, packageVersion: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    files: [{ path: 'SKILL.md', encoding: 'utf8', content, mediaType: 'text/markdown' }] })
  expect(document.querySelector('.skill-update-error')?.textContent).toBe('暂时无法确认更新结果，请重试。')
  expect(document.querySelector('[role="document"]')?.textContent).toBe('原始 Skill')
  await click('重试更新')
  expect(writes[1]).toEqual(writes[0])
  await expectToast('已更新', 'success')
  expect(host.querySelector('[data-sonner-toast] svg[data-icon="check-circle"]')?.getAttribute('style')).toContain('--progress-fill-done')
  expect(document.querySelector('[role="document"]')?.textContent).toBe('更新后的正文')
  expect(document.querySelector('.skill-update-error')).toBeNull()
  await act(async () => { document.querySelector<HTMLButtonElement>('[aria-label="关闭技能"]')!.click(); await settle() })
  expect(document.activeElement).toBe(trigger)
})

it('keeps the local document on picker cancellation or a bad folder and replaces it immediately after reselection', async () => {
  let version = 1
  const writes: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (route: string, options: RequestInit) => {
    if (route.endsWith('/document')) return response({ skillId: skill.skillId, version,
      content: version === 1 ? '# 原始正文' : '# 替换后的正文' })
    if (options.method !== 'POST') return response({ skills: [{ ...skill, version }], selections: [] })
    writes.push(JSON.parse(options.body as string)); version++
    return response({ ...skill, version })
  }))
  await mount(); await act(async () => { host.querySelector<HTMLButtonElement>('.st-skill-copy')!.click(); await settle() })
  const input = document.querySelector<HTMLInputElement>('[aria-label="选择更新技能文件夹"]')!
  const picker = vi.spyOn(input, 'click').mockImplementation(() => {})
  const select = async (files: File[]) => act(async () => {
    Object.defineProperty(input, 'files', { value: files, configurable: true })
    input.dispatchEvent(new Event('change', { bubbles: true })); await settle()
  })
  await click('更新技能'); await select([])
  expect(document.querySelector('[role="document"]')?.textContent).toBe('原始正文')
  expect(document.querySelector('.skill-update-error')).toBeNull()
  expect(writes).toHaveLength(0)
  await click('更新技能'); await select([new File(['not a skill'], 'README.md')])
  expect(document.querySelector('.skill-update-error')?.textContent).toContain('SKILL.md')
  expect(document.querySelector('[role="document"]')?.textContent).toBe('原始正文')
  expect(writes).toHaveLength(0)
  await click('重新选择文件夹')
  const content = '---\nname: replacement\ndescription: 新说明\n---\n替换后的正文'
  const file = new File([content], 'SKILL.md')
  Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode(content).buffer })
  Object.defineProperty(file, 'webkitRelativePath', { value: 'replacement/SKILL.md' })
  await select([file])
  expect(picker).toHaveBeenCalledTimes(3)
  expect(writes).toHaveLength(1)
  await expectToast('已更新', 'success')
  expect(document.querySelector('[role="document"]')?.textContent).toBe('替换后的正文')
})

it.each(['success', 'read-failure', 'lost-receipt', 'format-failure'] as const)('updates a GitHub skill from the latest repository and handles %s in the document', async outcome => {
  const source = `https://github.com/example/skills/tree/${'a'.repeat(40)}/nested/example`
  const latestVersion = 'b'.repeat(40), githubReads: unknown[] = [], writes: Record<string, unknown>[] = []
  const files = [{ path: 'SKILL.md', encoding: 'utf8', content: '---\nname: example\ndescription: 最新说明\n---\n# 最新 GitHub 正文' },
    { path: 'references/guide.md', encoding: 'utf8', content: '最新附件' }]
  let version = 1
  vi.stubGlobal('fetch', vi.fn(async (route: string, options: RequestInit) => {
    if (options.method !== 'POST') return response({ skills: [{ ...skill, source, version }], selections: [] })
    const input = JSON.parse(options.body as string)
    if (route.endsWith('/document')) return response({ skillId: skill.skillId, version: input.version,
      content: input.version === 1 ? '# 原始正文' : '# 最新 GitHub 正文' })
    if (route.endsWith('/github-package')) {
      githubReads.push(input)
      if (outcome === 'read-failure' && githubReads.length === 1)
        return new Response(JSON.stringify({ error: 'github-timeout' }), { status: 504 })
      return response({ source: source.replace('a'.repeat(40), latestVersion), packageVersion: latestVersion, files })
    }
    writes.push(input)
    if (outcome === 'format-failure' && writes.length === 1)
      return new Response(JSON.stringify({ error: 'invalid-skill', reason: 'description' }), { status: 400 })
    version = 2
    if (outcome === 'lost-receipt' && writes.length === 1) throw new TypeError('lost update ACK')
    return response({ ...skill, source, version, packageVersion: latestVersion })
  }))
  await mount(); await act(async () => { host.querySelector<HTMLButtonElement>('.st-skill-copy')!.click(); await settle() })
  const picker = vi.spyOn(document.querySelector<HTMLInputElement>('[aria-label="选择更新技能文件夹"]')!, 'click')
  await click('更新技能')
  if (outcome !== 'success') {
    expect(document.querySelector('.skill-update-error')?.textContent).toContain(outcome === 'read-failure' ? '读取 GitHub 超时'
      : outcome === 'lost-receipt' ? '暂时无法确认更新结果' : 'description')
    expect(document.querySelector('[role="document"]')?.textContent).toBe('原始正文')
    await click('重试更新')
  }
  expect(picker).not.toHaveBeenCalled()
  expect(githubReads).toEqual(Array.from({ length: outcome === 'read-failure' || outcome === 'format-failure' ? 2 : 1 }, () => ({ url: source, latest: true })))
  expect(writes.at(-1)).toMatchObject({ skillId: skill.skillId, source, packageVersion: latestVersion, files })
  if (outcome === 'lost-receipt') expect(writes[1]).toEqual(writes[0])
  if (outcome === 'format-failure') expect(writes[1].requestId).not.toBe(writes[0].requestId)
  await expectToast('已更新', 'success')
  expect(document.querySelector('[role="document"]')?.textContent).toBe('最新 GitHub 正文')
  expect(document.querySelector('.skill-update-error')).toBeNull()
})

it('retains the current document while the updated body is being refreshed', async () => {
  let version = 1, release!: () => void
  const source = 'https://github.com/example/skills'
  vi.stubGlobal('fetch', vi.fn(async (route: string, options: RequestInit) => {
    if (options.method !== 'POST') return response({ skills: [{ ...skill, source, version }], selections: [] })
    if (route.endsWith('/document')) {
      if (version === 2) return new Promise<Response>(resolve => { release = () => resolve(response({ skillId: skill.skillId, version, content: '# 最新正文' })) })
      return response({ skillId: skill.skillId, version, content: '# 原始正文' })
    }
    if (route.endsWith('/github-package')) return response({ source, packageVersion: 'new',
      files: [{ path: 'SKILL.md', encoding: 'utf8', content: '---\nname: example\ndescription: 依据\n---\n最新正文' }] })
    version = 2; return response({ ...skill, source, version })
  }))
  await mount(); await act(async () => { host.querySelector<HTMLButtonElement>('.st-skill-copy')!.click(); await settle() })
  await click('更新技能')
  expect(document.querySelector('[role="document"]')?.textContent).toBe('原始正文')
  expect(document.querySelector('.st-skill-document-body')?.getAttribute('aria-busy')).toBe('true')
  expect(button('正在更新…').disabled).toBe(true)
  expect(document.querySelector('.st-skill-document-status')).toBeNull()
  await act(async () => { release(); await settle() })
  expect(document.querySelector('[role="document"]')?.textContent).toBe('最新正文')
  expect(button('更新技能').disabled).toBe(false)
})

it.each(activityScopes)('restores a disabled skill directly from its switch (activity=%s)', async activityId => {
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
  const checkbox = host.querySelector<HTMLButtonElement>('[role="switch"]')!
  expect(checkbox.getAttribute('aria-checked')).toBe('false'); expect(checkbox.disabled).toBe(false)
  await act(async () => { checkbox.click(); await settle() })
  expect(writes[0]).toEqual({ route: skillsRoute(activityId) + '/disable', input: expect.objectContaining({ skillId: skill.skillId, disabled: false }) })
  expect(checkbox.getAttribute('aria-checked')).toBe('true')
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
  expect(host.querySelector('.st-skill-item')).toBeNull()
  await click('导入技能')
  expect(host.querySelector('[role="menu"]')?.textContent).toContain('本地导入')
  expect(host.querySelector('[role="menu"]')?.textContent).not.toContain('从文件导入')
  expect(host.querySelector('[role="menu"]')?.textContent).toContain('从 GitHub 导入')
})

it.each(['success', 'rejected', 'unconfirmed'] as const)('imports a local folder immediately with attachments and handles %s', async outcome => {
  const writes: Record<string, unknown>[] = []
  let imported = false
  let complete: (() => void) | undefined
  vi.stubGlobal('fetch', vi.fn(async (_route: string, options: RequestInit) => {
    if (options.method === 'POST') {
      writes.push(JSON.parse(options.body as string))
      if (writes.length === 1) return new Promise<Response>((resolve, reject) => {
        complete = () => {
          if (outcome === 'rejected') resolve(new Response(JSON.stringify({ error: 'invalid-skill', reason: 'description' }), { status: 400 }))
          else if (outcome === 'unconfirmed') reject(new TypeError('synthetic ACK loss'))
          else { imported = true; resolve(response(skill)) }
        }
      })
      imported = true; return response(skill)
    }
    return response({ skills: imported ? [skill] : [], selections: [] })
  }))
  await mount()
  const input = host.querySelector<HTMLInputElement>('[aria-label="选择技能文件夹"]')!
  expect(input.hasAttribute('webkitdirectory')).toBe(true)
  expect(host.querySelector('[aria-label="选择技能文件"]')).toBeNull()
  const picker = vi.spyOn(input, 'click').mockImplementation(() => {})
  await click('导入第一个技能'); await click('本地导入')
  expect(picker).toHaveBeenCalledOnce()
  await act(async () => {
    Object.defineProperty(input, 'files', { value: [], configurable: true })
    input.dispatchEvent(new Event('change', { bubbles: true })); await settle()
  })
  expect(writes).toHaveLength(0)
  const content = '---\nname: evidence-analysis\ndescription: 依据\n---\n正文'
  const file = new File([content], 'SKILL.md', { type: 'text/markdown' })
  Object.defineProperty(file, 'webkitRelativePath', { value: 'example/SKILL.md' })
  Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode(content).buffer })
  const extra = new File(['依据'], 'notes.md', { type: 'text/markdown' })
  Object.defineProperty(extra, 'webkitRelativePath', { value: 'example/references/notes.md' })
  Object.defineProperty(extra, 'arrayBuffer', { value: async () => new TextEncoder().encode('依据').buffer })
  await act(async () => {
    Object.defineProperty(input, 'files', { value: [file, extra], configurable: true })
    input.dispatchEvent(new Event('change', { bubbles: true })); await settle()
  })
  expect(writes).toHaveLength(1)
  expect(host.textContent).toContain('正在导入技能')
  expect(host.textContent).toContain('读取并保存完成前请保留此页面。')
  expect(button('导入第一个技能').disabled).toBe(true)
  expect(host.querySelector('.skill-local-import')).toBeNull()
  expect(host.textContent).not.toContain('已选择')
  expect(button('导入')).toBeUndefined()
  expect(host.querySelector('.st-action-menu-trigger')?.getAttribute('aria-expanded')).toBe('false')
  expect(writes[0]).toMatchObject({ source: '本地文件', files: [
    { path: 'SKILL.md', content, encoding: 'utf8' }, { path: 'references/notes.md', content: '依据', encoding: 'utf8' },
  ] })
  await act(async () => { complete!(); await settle() })
  if (outcome === 'rejected') {
    await expectToast('请在 SKILL.md 开头填写 description', 'error')
    expect(button('导入第一个技能').disabled).toBe(false)
    await click('导入第一个技能'); await click('本地导入')
    expect(picker).toHaveBeenCalledTimes(2)
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); await settle() })
    expect(writes).toHaveLength(2)
    expect(writes[1].requestId).not.toBe(writes[0].requestId)
  } else if (outcome === 'unconfirmed') {
    await expectToast('暂时无法确认导入结果', 'error')
    expect(button('导入第一个技能').disabled).toBe(true)
    await click('重试')
    expect(writes).toHaveLength(2)
    expect(writes[1]).toEqual(writes[0])
  }
  await expectToast('技能已导入', 'success')
  expect(host.querySelector<HTMLButtonElement>('[role="switch"]')!.getAttribute('aria-checked')).toBe('true')
  expect(writes).toHaveLength(outcome === 'success' ? 1 : 2)
  expect(button('导入技能').disabled).toBe(false)
  expect(host.querySelector('.st-action-menu-trigger')?.getAttribute('aria-expanded')).toBe('false')
  expect(host.querySelector('.skill-import')).toBeNull()
})

it.each(['rejected', 'unconfirmed'] as const)('imports a skill collection and resumes only unfinished items after %s', async outcome => {
  const entries = Object.fromEntries(['alpha', 'beta', 'gamma'].map(name => [name, { ...skill, skillId: crypto.randomUUID(), name }]))
  const saved = new Set<string>(), writes: Record<string, unknown>[] = []
  let firstFailure = true
  vi.stubGlobal('fetch', vi.fn(async (_route: string, options: RequestInit) => {
    if (options.method !== 'POST') return response({ skills: [...saved].map(name => entries[name]), selections: [] })
    const input = JSON.parse(options.body as string)
    writes.push(input)
    const name = /^name: (.+)$/m.exec(input.files.find((file: { path: string }) => file.path === 'SKILL.md').content)![1]!
    if (name === 'beta' && firstFailure) {
      firstFailure = false
      if (outcome === 'unconfirmed') throw new TypeError('lost ACK')
      return new Response(JSON.stringify({ error: 'invalid-skill', reason: 'description' }), { status: 400 })
    }
    saved.add(name); return response(entries[name])
  }))
  await mount()
  const chosen = ['alpha', 'beta', 'gamma'].flatMap(name => [
    ['SKILL.md', `---\nname: ${name}\ndescription: 依据\n---\n正文`],
    ['references/notes.md', `${name} 附件`],
    ...(name === 'alpha' ? [['references/SKILL.md', '# 嵌套参考文档']] : []),
  ].map(([path, content]) => {
    const file = new File([content!], path!.split('/').at(-1)!)
    Object.defineProperty(file, 'webkitRelativePath', { value: `collection/${name}/${path}` })
    Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode(content).buffer })
    return file
  }))
  await act(async () => {
    const input = host.querySelector<HTMLInputElement>('[aria-label="选择技能文件夹"]')!
    Object.defineProperty(input, 'files', { value: chosen })
    input.dispatchEvent(new Event('change', { bubbles: true })); await settle()
  })
  const failed = outcome === 'rejected'
  await expectToast(failed ? '已导入 2 个技能，1 个未完成' : '已导入 1 个技能，2 个未完成', failed ? 'warning' : 'error')
  expect(host.querySelectorAll('.st-skill-item')).toHaveLength(failed ? 2 : 1)
  expect(host.querySelector('[aria-label="技能导入结果"]')?.textContent).toContain('beta')
  expect(button('导入技能').disabled).toBe(!failed)
  expect(writes[0]).toMatchObject({ files: expect.arrayContaining([
    { path: 'references/notes.md', content: 'alpha 附件', encoding: 'utf8' },
    { path: 'references/SKILL.md', content: '# 嵌套参考文档', encoding: 'utf8' },
  ]) })
  await click(failed ? '重试未完成' : '继续导入')
  await expectToast('已导入 3 个技能', 'success')
  expect(host.querySelectorAll('.st-skill-item')).toHaveLength(3)
  expect(host.querySelector('[aria-label="技能导入结果"]')).toBeNull()
  expect(writes).toHaveLength(4)
  expect(writes[failed ? 3 : 2].requestId === writes[1].requestId).toBe(!failed)
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
  await mount(); await click('导入技能'); await click('从 GitHub 导入')
  const input = host.querySelector<HTMLInputElement>('.skill-github input')!
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
  await act(async () => { host.querySelector<HTMLButtonElement>('[role="switch"]')!.click(); await settle() })
  await expectToast('暂时无法确认结果', 'error')
  await click('重试')
  expect(writes).toHaveLength(2)
  expect(writes[1]).toEqual(writes[0])
  expect(host.querySelector<HTMLButtonElement>('[role="switch"]')!.getAttribute('aria-checked')).toBe('false')
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
  await act(async () => { host.querySelector<HTMLButtonElement>('[role="switch"]')!.click(); await settle() })
  await expectToast('技能已在其他位置更新', 'error')
  await click('刷新列表')
  expect(host.querySelector<HTMLButtonElement>('[role="switch"]')!.getAttribute('aria-checked')).toBe('false')
  await click('重试')
  expect(writes).toHaveLength(2)
  expect(writes[1].requestId).not.toBe(writes[0].requestId)
  expect(writes[1].disabled).toEqual(writes[0].disabled)
  expect(host.querySelector<HTMLButtonElement>('[role="switch"]')!.getAttribute('aria-checked')).toBe('false')
})

it('opens the exact SKILL.md of a disabled skill without enabling it, and retries a failed read', async () => {
  const content = '---\nname: evidence-analysis\ndescription: 原始元信息\n---\n\n# 原始正文\n保留 <script> 与代码原文。'
  const reads: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (route: string, options: RequestInit) => {
    if (options.method !== 'POST') return response({ skills: [{ ...skill, disabled: true }], selections: [] })
    expect(route).toBe('/api/learning/skills/document')
    reads.push(JSON.parse(options.body as string))
    if (reads.length === 1) throw new TypeError('offline')
    return response({ skillId: skill.skillId, version: skill.version, content })
  }))
  await mount()
  const trigger = host.querySelector<HTMLButtonElement>('.st-skill-copy')!
  await act(async () => { trigger.click(); await settle() })
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('暂时无法打开')
  await click('重试')
  expect(document.querySelector('.st-skill-document [role="document"]')?.textContent).toContain('原始正文')
  expect(document.querySelector('.st-skill-document [role="document"] pre code')?.textContent).toContain('description: 原始元信息')
  expect(document.querySelector('.st-skill-document [role="document"] script')).toBeNull()
  expect(reads).toEqual([{ skillId: skill.skillId, version: skill.version }, { skillId: skill.skillId, version: skill.version }])
  await act(async () => { document.querySelector<HTMLButtonElement>('[aria-label="关闭技能"]')!.click(); await settle() })
  expect(document.activeElement).toBe(trigger)
  expect(host.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('false')
})

it('keeps a cancelled deletion intact and retries a lost deletion receipt with the same request', async () => {
  let removed = false
  const writes: Record<string, unknown>[] = []
  vi.stubGlobal('fetch', vi.fn(async (route: string, options: RequestInit) => {
    if (options.method !== 'POST') return response({ skills: removed ? [] : [skill], selections: [] })
    expect(route).toBe('/api/learning/skills/remove')
    writes.push(JSON.parse(options.body as string)); removed = true
    if (writes.length === 1) throw new TypeError('receipt lost')
    return response({ skillId: skill.skillId })
  }))
  await mount()
  const openRemove = async () => {
    await act(async () => { host.querySelector<HTMLButtonElement>('.st-skill-more')!.click(); await settle() })
    await act(async () => {
      Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(item => item.textContent === '删除')!.click()
      await settle()
    })
  }
  await openRemove(); await click('取消')
  expect(writes).toHaveLength(0)
  expect(host.querySelectorAll('.st-skill-item')).toHaveLength(1)
  await openRemove(); await click('删除')
  await expectToast('暂时无法确认结果', 'error')
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  await click('重试')
  expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0])
  expect(writes[0].skillId).toBe(skill.skillId)
  expect(host.querySelector('.st-skill-item')).toBeNull()
  await expectToast('技能已删除', 'success')
})

it('keeps focus on search before and after a delayed catalog refresh removes the deleted row', async () => {
  let removed = false, release: (() => void) | undefined
  vi.stubGlobal('fetch', vi.fn(async (_route: string, options: RequestInit) => {
    if (options.method === 'POST') { removed = true; return response({ skillId: skill.skillId }) }
    if (removed) return new Promise<Response>(resolve => { release = () => resolve(response({ skills: [], selections: [] })) })
    return response({ skills: [skill], selections: [] })
  }))
  await mount()
  await act(async () => { host.querySelector<HTMLButtonElement>('.st-skill-more')!.click(); await settle() })
  await act(async () => {
    Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(item => item.textContent === '删除')!.click()
    await settle()
  })
  await click('删除')
  // Radix returns focus in a task after the asynchronously closed dialog unmounts.
  await act(async () => { await settle() })
  const search = host.querySelector('[aria-label="搜索技能"]')!
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(host.querySelector('.st-skill-item')).not.toBeNull()
  expect(document.activeElement).toBe(search)
  expect(release).toBeTypeOf('function')
  await act(async () => { release!(); await settle() })
  expect(host.querySelector('.st-skill-item')).toBeNull()
  expect(document.activeElement).toBe(button('导入第一个技能'))
})

it('keeps the list layout stable while a toggle saves and rereads the catalog', async () => {
  let saved = false, releaseWrite: (() => void) | undefined, releaseRead: (() => void) | undefined
  vi.stubGlobal('fetch', vi.fn(async (_route: string, options: RequestInit) => {
    if (options.method === 'POST') return new Promise<Response>(resolve => {
      releaseWrite = () => { saved = true; resolve(response({ ...skill, disabled: true, selected: false })) }
    })
    if (saved) return new Promise<Response>(resolve => {
      releaseRead = () => resolve(response({ skills: [{ ...skill, disabled: true, selected: false }], selections: [] }))
    })
    return response({ skills: [skill], selections: [] })
  }))
  await mount()
  const content = host.querySelector('.personal-skills')!
  const visibleBlocks = () => Array.from(content.children).filter(item => !(item as HTMLElement).hidden).map(item => item.className)
  const before = visibleBlocks()
  await act(async () => { host.querySelector<HTMLButtonElement>('[role="switch"]')!.click(); await settle() })
  expect(visibleBlocks()).toEqual(before)
  expect(content.querySelector('[role="status"]')).toBeNull()
  expect(Array.from(content.querySelectorAll('button')).some(item => item.textContent === '重试')).toBe(false)
  await act(async () => { releaseWrite!(); await settle() })
  expect(releaseRead).toBeTypeOf('function')
  expect(visibleBlocks()).toEqual(before)
  expect(content.querySelector('[role="status"]')).toBeNull()
  await act(async () => { releaseRead!(); await settle() })
  expect(visibleBlocks()).toEqual(before)
  await expectToast('技能已停用', 'success')
})

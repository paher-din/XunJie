// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DraftReferencesProvider } from '../components/workspace/references/DraftReferences'
import { WorkspaceReferenceComposer, type DraftSkillsController } from '../components/workspace/references/WorkspaceReferences'
import { ReliableQuestionDraft } from '../reliable-workspace/draft'
import type { ReliableActions } from '../reliable-workspace/actions'
import type { SpaceIdentity } from '@xunjie/contracts/spaces'
import { useSkillCatalog, draftSkillOption, type SkillCatalogEntry } from './skills'
import { TeachingToolRecords } from './TeachingToolRecords'
import type { TeachingToolRecord } from '@xunjie/contracts/teaching-agent'
import { composerView, waitForComposerComposition } from '../components/workspace/references/composer-view'
import { DraftStore } from '../reliable-workspace/draft-store'

let root: Root, host: HTMLDivElement
const cleanup: (() => void)[] = []
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0)) }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => { root.unmount(); cleanup.splice(0).forEach(dispose => dispose()); await settle() })
  host.remove(); vi.useRealTimers(); vi.unstubAllGlobals()
})

it('keeps the same composing textarea, caret and focus while catalog changes, and edits pins without replacing the controller', async () => {
  const key = crypto.randomUUID(), skill = { skillId: crypto.randomUUID(), version: 1 }
  const draft = new ReliableQuestionDraft(key, { read: async () => ({ draftId: crypto.randomUUID(), revision: 0, revisionId: null, question: '', references: [] }),
    receipt: async () => null, sync: vi.fn() })
  await draft.open(); draft.suspend(); cleanup.push(() => draft.dispose())
  const create = vi.fn(async () => {})
  const actionState = { receivers: [{ receiverId: 'original', location: 'remote', kind: 'question' }], ready: true, active: true, items: [] }
  const actions = { subscribe: () => () => {}, snapshot: () => actionState, create } as unknown as ReliableActions
  const catalog: Omit<DraftSkillsController, 'choose' | 'selected'> = { options: [], loading: true, error: '', reload() {} }
  const render = async () => act(async () => {
    root.render(createElement(DraftReferencesProvider, { workspaceKey: key, draft, actions, skillCatalog: { ...catalog },
      children: createElement(WorkspaceReferenceComposer) })); await settle()
  })
  await render()
  await act(async () => { host.querySelector<HTMLButtonElement>('button')!.click(); await settle() })
  const textarea = host.querySelector('textarea')!
  await act(async () => { draft.change('中文输入中', []); await settle() })
  textarea.focus(); textarea.setSelectionRange(2, 4)
  await act(async () => { textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); await settle() })
  catalog.loading = false; catalog.options = [draftSkillOption({ ...skill, name: '分析思路', description: '先核对依据', selected: false, disabled: false,
    unavailable: { reason: 'not-selected', detail: '尚未在范围中选用' } } as SkillCatalogEntry)]
  await render()
  expect(host.querySelector('textarea')).toBe(textarea)
  expect(document.activeElement).toBe(textarea)
  expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([2, 4])
  expect(host.querySelector<HTMLInputElement>('.wr-skills input')!.disabled).toBe(false)
  await act(async () => { textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true })); await settle() })
  expect(create).not.toHaveBeenCalled()
  await act(async () => {
    textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    host.querySelector<HTMLInputElement>('.wr-skills input')!.click(); await settle()
  })
  expect(draft.capture().skills).toEqual([skill])
  expect(draft.snapshot().question).toBe('中文输入中')
  expect(host.querySelector('textarea')).toBe(textarea)
  await act(async () => { textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true })); await settle() })
  expect(create).toHaveBeenCalledTimes(1)
})

it('preserves textarea focus/caret only for pointer Skill activation and leaves keyboard focus on the checkbox', async () => {
  const key = crypto.randomUUID(), skill = { skillId: crypto.randomUUID(), version: 1 }
  const draft = new ReliableQuestionDraft(key, { read: async () => ({ draftId: crypto.randomUUID(), revision: 0, revisionId: null, question: '', references: [] }),
    receipt: async () => null, sync: vi.fn() })
  await draft.open(); draft.suspend(); cleanup.push(() => draft.dispose())
  const state = { receivers: [], ready: true, active: true, items: [] }
  const actions = { subscribe: () => () => {}, snapshot: () => state } as unknown as ReliableActions
  const catalog = { options: [{ ...skill, name: 'evidence-diagnosis', description: '原证据' }], loading: false, error: '', reload() {} }
  const render = async () => act(async () => {
    root.render(createElement(DraftReferencesProvider, { workspaceKey: key, draft, actions, skillCatalog: { ...catalog },
      children: createElement(WorkspaceReferenceComposer) })); await settle()
  })
  await render()
  await act(async () => { host.querySelector('button')!.click(); draft.change('用于保留原问题中的选区位置', []); await settle() })
  const textarea = host.querySelector('textarea')!, summary = host.querySelector<HTMLElement>('.wr-skills > summary')!
  const checkbox = host.querySelector<HTMLInputElement>('.wr-skills input')!
  // jsdom does not perform pointerdown's default focus action. Model that browser
  // action explicitly so this fails if pointer focus preservation is removed.
  const pointerActivate = async (target: HTMLElement, focusTarget = target) => act(async () => {
    const down = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 })
    target.dispatchEvent(down)
    if (!down.defaultPrevented) focusTarget.focus()
    target.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }))
    target.click(); await settle()
  })
  textarea.focus(); textarea.setSelectionRange(3, 7, 'backward')
  await pointerActivate(summary)
  expect(document.activeElement).toBe(textarea)
  await pointerActivate(checkbox)
  expect(checkbox.checked).toBe(true)
  expect(draft.capture().skills).toEqual([skill])
  expect(document.activeElement).toBe(textarea)
  expect([textarea.selectionStart, textarea.selectionEnd, textarea.selectionDirection]).toEqual([3, 7, 'backward'])
  // Keyboard Tab moves to the control, and Space activates it without a pointer.
  await act(async () => {
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    checkbox.focus()
    checkbox.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }))
    checkbox.click(); await settle()
  })
  expect(checkbox.checked).toBe(false)
  expect(document.activeElement).toBe(checkbox)
  await render()
  expect(document.activeElement).toBe(checkbox)
  // Starting a pointer gesture from another focused control keeps normal focus.
  await pointerActivate(summary)
  expect(document.activeElement).toBe(summary)
  await pointerActivate(checkbox)
  expect(document.activeElement).toBe(checkbox)
})

it.each([
  { disabled: true, reason: 'not-selected' },
  { disabled: false, reason: 'dependency-missing' },
  { disabled: false, reason: 'dependency-unavailable' },
  { disabled: false, reason: 'version-missing' },
] as const)('keeps $reason disabled=$disabled unavailable for explicit question selection', async ({ disabled, reason }) => {
  const option = draftSkillOption({ skillId: crypto.randomUUID(), version: 1, name: '原 Skill', description: '固定内容', selected: false, disabled,
    unavailable: { reason, detail: 'owner 判定不可用' } } as SkillCatalogEntry)
  expect(option.unavailable).toBeTruthy()
  // The same mapped options consumed by ActivityReferences remain disabled in the real composer.
  const key = crypto.randomUUID()
  const draft = new ReliableQuestionDraft(key, { read: async () => ({ draftId: crypto.randomUUID(), revision: 0, revisionId: null, question: '', references: [] }),
    receipt: async () => null, sync: vi.fn() })
  await draft.open(); draft.suspend(); cleanup.push(() => draft.dispose())
  const state = { receivers: [], ready: true, active: true, items: [] }
  const actions = { subscribe: () => () => {}, snapshot: () => state } as unknown as ReliableActions
  await act(async () => { root.render(createElement(DraftReferencesProvider, { workspaceKey: key, draft, actions,
    skillCatalog: { options: [option], loading: false, error: '', reload() {} }, children: createElement(WorkspaceReferenceComposer) })); await settle() })
  await act(async () => { host.querySelector('button')!.click(); await settle() })
  expect(host.querySelector<HTMLInputElement>('.wr-skills input')!.disabled).toBe(true)
})

it('ignores a late catalog from the previous identity and sends the new expected-subject headers', async () => {
  const identity: SpaceIdentity = { environmentId: crypto.randomUUID(), spaceId: crypto.randomUUID(), principalId: crypto.randomUUID(),
    name: '旧主体', kind: 'personal' }
  const next = { ...identity, principalId: crypto.randomUUID(), name: '新主体' }
  let release!: (value: Response) => void
  const oldRead = new Promise<Response>(resolve => { release = resolve })
  const fetch = vi.fn(async (_route: string, options: RequestInit) => {
    const subject = (options.headers as Record<string, string>)['x-xj-expected-subject']
    return subject.endsWith(identity.principalId) ? oldRead : new Response(JSON.stringify({ skills: [] }))
  })
  vi.stubGlobal('fetch', fetch)
  function Catalog({ identity: subject }: { identity: SpaceIdentity }) {
    const catalog = useSkillCatalog(subject, 'personal', 'test')
    return createElement('p', null, `${subject.name}:${catalog.error || (catalog.data ? '已读取' : '等待读取')}`)
  }
  await act(async () => { root.render(createElement(Catalog, { identity })); await settle() })
  await act(async () => { root.render(createElement(Catalog, { identity: next })); await settle() })
  expect(host.textContent).toBe('新主体:已读取')
  await act(async () => { release(new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 })); await settle() })
  expect(host.textContent).toBe('新主体:已读取')
  expect(fetch.mock.calls.at(-1)![1].headers).toMatchObject({ 'x-xj-namespace': 'test',
    'x-xj-expected-subject': [next.environmentId, next.spaceId, next.principalId].join('.') })
})

it.each(['skill_load', 'skill_read'])('opens %s fixed source bytes locally without treating the Skill as a work object', async name => {
  const onLocate = vi.fn()
  const loaded = { skillId: crypto.randomUUID(), version: 3, source: 'package-source', packageVersion: '2.0',
    packageDigest: 'a'.repeat(64), path: name === 'skill_load' ? 'SKILL.md' : 'references/example.md', encoding: 'utf8',
    mediaType: 'text/markdown', byteLength: 12, digest: 'b'.repeat(64), originalDigest: 'c'.repeat(64),
    content: '固定的原内容', offset: 6, totalByteLength: 40, complete: false }
  const record = { commandId: crypto.randomUUID(), runId: crypto.randomUUID(), name, arguments: {}, basis: {}, state: 'settled', outcome: 'completed',
    result: { loaded, sourceState: 'fixed-current' }, source: { label: 'package-source · v3', contentId: loaded.skillId } } as unknown as TeachingToolRecord
  await act(async () => { root.render(createElement(TeachingToolRecords, { records: [record], onLocate })); await settle() })
  expect(host.textContent).toContain(name === 'skill_load' ? '加载 Skill' : '读取 Skill 文件')
  const original = host.querySelector<HTMLDetailsElement>('.teaching-skill-source')!
  original.scrollIntoView = vi.fn()
  await act(async () => { Array.from(host.querySelectorAll('button')).find(item => item.textContent === '查看固定 Skill 来源')!.click(); await settle() })
  expect(original.open).toBe(true)
  expect(original.textContent).toContain('固定的原内容')
  expect(original.textContent).toContain('6–18 / 40')
  expect(document.activeElement).toBe(original.querySelector('summary'))
  expect(onLocate).not.toHaveBeenCalled()
})

it('restores the caret/open/focus at the visible-view boundary and never steals focus on later responses', async () => {
  const key = crypto.randomUUID()
  const draft = new ReliableQuestionDraft(key, { read: async () => ({ draftId: crypto.randomUUID(), revision: 0, revisionId: null, question: '', references: [] }),
    receipt: async () => null, sync: vi.fn() })
  await draft.open(); draft.suspend(); cleanup.push(() => draft.dispose())
  const state = { receivers: [], ready: true, active: true, items: [] }
  const actions = { subscribe: () => () => {}, snapshot: () => state } as unknown as ReliableActions
  let visible = true
  const render = async () => act(async () => {
    root.render(createElement('div', null,
      createElement('input', { 'aria-label': '独立焦点' }),
      !visible && createElement('input', { 'aria-label': '设置字段' }),
      createElement('div', { hidden: !visible, inert: !visible }, createElement(DraftReferencesProvider, { workspaceKey: key, draft, actions, viewActive: visible,
        children: createElement(WorkspaceReferenceComposer) })))); await settle()
  })
  await render()
  await act(async () => { host.querySelector('button')!.click(); draft.change('原问题的光标位置', []); await settle() })
  const textarea = host.querySelector('textarea')!
  textarea.focus(); textarea.setSelectionRange(2, 5, 'backward')
  await act(async () => { textarea.dispatchEvent(new Event('select', { bubbles: true })); await settle() })
  visible = false; await render()
  host.querySelector<HTMLInputElement>('[aria-label="设置字段"]')!.focus()
  visible = true; await render()
  expect(host.querySelector('textarea')).toBe(textarea)
  expect([textarea.selectionStart, textarea.selectionEnd, textarea.selectionDirection]).toEqual([2, 5, 'backward'])
  expect(document.activeElement).toBe(textarea)
  const independent = host.querySelector<HTMLInputElement>('[aria-label="独立焦点"]')!
  independent.focus()
  await act(async () => { draft.change('响应期间修改的原问题', []); await settle() })
  expect(document.activeElement).toBe(independent)
  expect(composerView(key)).not.toHaveProperty('question')
  // A genuine remount uses the same UI-only cache; another workspace has no borrowed view.
  textarea.focus(); textarea.setSelectionRange(1, 3)
  await act(async () => { textarea.dispatchEvent(new Event('select', { bubbles: true })); root.render(null); await settle() })
  await render()
  expect(host.querySelector('textarea')).not.toBeNull()
  expect([host.querySelector('textarea')!.selectionStart, host.querySelector('textarea')!.selectionEnd]).toEqual([1, 3])
  expect(composerView(crypto.randomUUID())).toEqual({ open: false })
})

it('waits for composition end and protects the final Chinese text before allowing navigation', async () => {
  const key = crypto.randomUUID()
  const draft = new ReliableQuestionDraft(key, { read: async () => ({ draftId: crypto.randomUUID(), revision: 0, revisionId: null, question: '', references: [] }),
    receipt: async () => null, sync: vi.fn() })
  await draft.open(); draft.suspend(); cleanup.push(() => draft.dispose())
  const state = { receivers: [], ready: true, active: true, items: [] }
  const actions = { subscribe: () => () => {}, snapshot: () => state } as unknown as ReliableActions
  await act(async () => { root.render(createElement(DraftReferencesProvider, { workspaceKey: key, draft, actions,
    children: createElement(WorkspaceReferenceComposer) })); await settle() })
  await act(async () => { host.querySelector('button')!.click(); await settle() })
  const textarea = host.querySelector('textarea')!
  await act(async () => { textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); await settle() })
  let navigated = false
  const navigation = waitForComposerComposition(key).then(async () => { await draft.leave(); navigated = true })
  await settle(); expect(navigated).toBe(false); expect(textarea.isConnected).toBe(true)
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '最终输入的中文')
  await act(async () => { textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); await navigation; await settle() })
  expect(navigated).toBe(true)
  expect((await new DraftStore().read(key))!.question).toBe('最终输入的中文')
})

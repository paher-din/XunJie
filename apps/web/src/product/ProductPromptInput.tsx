import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ChatComposerDock, PromptInput, type PromptAttachment, type PromptAttachmentKind, type PromptInputProps, type PromptModelOption } from '@xunjie/ui/chat'
import { ContextRing } from '@xunjie/ui/foundation'
import { resolveModelProfile, type ModelReasoningEffort } from '@xunjie/contracts/model-connections'
import type { DraftSkillsController } from '../components/workspace/references/WorkspaceReferences'
import type { ModelSelectionController } from './ModelSelection'
import { useAgentModelPicker } from './AgentModelPicker'

export interface PromptFiles {
  items: { id: string; name: string; size?: number; progress?: number; attachmentKind?: PromptAttachmentKind; src?: string }[]
  busy: boolean; error: string
  add(files: File[]): void | Promise<void>
  remove(id: string): void
}
/** Only a whitespace-delimited command at the caret is a Skill query; URLs and paths remain plain text. */
export function skillCommandAt(value: string, caret = value.length) {
  if (caret < 0 || caret > value.length) return null
  const match = /(?:^|\s)\/([^/\s]{0,80})$/u.exec(value.slice(0, caret))
  return match ? { start: caret - match[1].length - 1, end: caret, query: match[1] } : null
}
function promptAttachmentKind(name: string): PromptAttachmentKind {
  if (/\.(?:c|h|cc|cpp|hpp|mjs|cjs|js|jsx|ts|tsx|py|java|go|rs|sh|bash|sql|xml|ya?ml|toml|html?|css)$/i.test(name)) return 'code'
  if (/\.(?:csv|tsv)$/i.test(name)) return 'spreadsheet'
  return 'document'
}

export function ProductComposerDock({ children, atBottom = true, onBackToBottom = () => {}, disclaimer = '对话自动保存在本机' }: {
  children: ReactNode; atBottom?: boolean; onBackToBottom?: () => void; disclaimer?: string
}) {
  const anchor = useRef<HTMLDivElement>(null)
  return <ChatComposerDock anchorRef={anchor} atBottom={atBottom}
    suggestions={{ items: [], show: false, onPick: () => {} }}
    followUps={{ items: [], show: false, onPick: () => {}, label: '' }}
    onBackToBottom={onBackToBottom} input={children}
    disclaimer={disclaimer} />
}

const effortLabels = { auto: '默认', none: '关闭', enabled: '开启', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '更高', max: '最高' } as const satisfies Record<ModelReasoningEffort, string>

export function ProductPromptInput({ selection, readOnly, onModelSettings, onModelSelected, applyingModel, modelLocked = false, contextUsage, files, skills, ...input }:
  Pick<PromptInputProps, 'value' | 'onChange' | 'onSend' | 'canSend' | 'autoFocus' | 'submitting' | 'inputRef' | 'textareaProps' | 'sendLabel'
    | 'busy' | 'onStop' | 'onResume' | 'resumeLabel' | 'actionDisabled' | 'pasteImages'> & {
  selection: ModelSelectionController; readOnly: boolean; onModelSettings?: () => void
  onModelSelected?: Parameters<ModelSelectionController['choose']>[1]; applyingModel?: boolean; contextUsage?: { model: { connectionId: string; version: number }; tokens: number; lowerBound: boolean }
  /** A Turn fixes its model; the next Turn adopts any later picker change. */
  modelLocked?: boolean
  files: PromptFiles; skills?: DraftSkillsController
}) {
  const picker = useAgentModelPicker(selection)
  const [menu, setMenu] = useState<'add' | 'skills' | 'slash' | null>(null)
  const fallbackInput = useRef<HTMLTextAreaElement>(null), editor = input.inputRef ?? fallbackInput
  const skillListId = useId()
  const command = useRef<ReturnType<typeof skillCommandAt>>(null), pendingCaret = useRef<number | null>(null), composing = useRef(false)
  const [activeSkill, setActiveSkill] = useState('')
  const disabled = readOnly || input.submitting || input.textareaProps?.disabled || files.busy
  const query = menu === 'slash' ? (command.current?.query ?? '').toLocaleLowerCase() : ''
  const visibleSkills = (skills?.options ?? []).filter(option => `${option.name} ${option.description}`.toLocaleLowerCase().includes(query))
  const enabledSkills = visibleSkills.filter(option => !option.fixed && !option.unavailable && !disabled && !skills?.loading && !skills?.error)
  const active = enabledSkills.find(option => option.skillId === activeSkill)?.skillId ?? enabledSkills[0]?.skillId
  const updateCommand = (value: string, caret: number) => {
    const next = !disabled && !composing.current ? skillCommandAt(value, caret) : null
    command.current = next; setActiveSkill('')
    if (next) setMenu('slash')
    else setMenu(current => current === 'slash' ? null : current)
  }
  useLayoutEffect(() => {
    if (pendingCaret.current === null || !editor.current) return
    editor.current.focus({ preventScroll: true })
    editor.current.setSelectionRange(pendingCaret.current, pendingCaret.current)
    pendingCaret.current = null
  }, [input.value, editor])
  const selectedSkills = skills?.selected ?? []
  const pickSkill = (id: string) => {
    const option = visibleSkills.find(item => item.skillId === id)
    if (!option || option.fixed || option.unavailable || disabled || skills?.loading || skills?.error || !skills) return
    const existing = selectedSkills.find(item => item.skillId === id)
    const next = selectedSkills.filter(item => item.skillId !== id)
    skills.choose(existing?.version === option.version ? menu === 'slash' ? selectedSkills : next : [...next, { skillId: id, version: option.version }])
    const range = menu === 'slash' ? command.current : null
    if (range) {
      pendingCaret.current = range.start
      input.onChange(input.value.slice(0, range.start) + input.value.slice(range.end))
    }
    command.current = null
    setMenu(null)
  }
  const choices = selection.selection?.options ?? []
  const byId = new Map<string, (typeof choices)[number]>()
  for (const choice of choices) {
    if (!choice.connection.enabled || !choice.connection.hasCredential || choice.connection.adapterState !== 'ready') continue
    const id = `${choice.kind}:${choice.connection.connectionId}`
    const previous = byId.get(id)
    if (!previous || previous.kind === 'personal' && previous.grantId && choice.kind === 'personal' && !choice.grantId) byId.set(id, choice)
  }
  const options: PromptModelOption[] = picker.models
  const selected = selection.selection?.selected
  const selectedId = selected ? `${selected.kind}:${selected.connection.connectionId}` : ''
  const model = picker.model
  const connection = selected?.connection
  const profile = connection ? resolveModelProfile(connection) : undefined
  const efforts = (profile?.efforts ?? ['auto']).map(level => effortLabels[level])
  const supportedEffort = !!profile && profile.efforts.some(level => level !== 'auto')
  const disabledEffort = '此模型连接采用默认思考设置'
  const effort = effortLabels[selected?.reasoningEffort ?? connection?.reasoningEffort ?? profile?.defaultEffort ?? 'auto']
  const measured = contextUsage && contextUsage.model.connectionId === connection?.connectionId
    && contextUsage.model.version === connection.version ? contextUsage : undefined
  const modelBusy = readOnly || input.submitting || selection.busy || applyingModel || modelLocked

  const skillStatus = skills?.loading ? '正在读取技能…' : skills?.error || (!visibleSkills.length
    ? query ? '没有匹配的技能' : '还没有可用技能，可在设置中导入。' : undefined)
  const contextItems: NonNullable<PromptInputProps['contextItems']> = skills?.explicit ? selectedSkills.map(skill => {
      const option = skills.options.find(item => item.skillId === skill.skillId && item.version === skill.version)
      return { id: skill.skillId, label: option?.name ?? `技能 · v${skill.version}`, kind: 'skill' as const,
        remove: disabled || option?.fixed || skills.loading || skills.error ? undefined : () => skills.choose(selectedSkills.filter(item => item.skillId !== skill.skillId)) }
    }) : []
  const attachments: PromptAttachment[] = files.items.map(file => ({ id: file.id, name: file.name,
    size: file.size ?? 0, kind: file.attachmentKind ?? promptAttachmentKind(file.name), ...(file.src ? { src: file.src } : {}),
    ...(file.progress !== undefined ? { progress: file.progress } : {}) }))
  return <PromptInput {...input} inputRef={editor} attachments={attachments} showAttachments
    onAddFiles={selected => { if (!disabled) void files.add(selected) }} onRemoveAttachment={files.remove}
    attachmentTitle={input.pasteImages ? '添加图片、UTF-8 文本、代码文件或 PDF' : '添加 UTF-8 文本、代码文件或 PDF'}
    canSend={input.canSend && !files.busy && !selection.busy && !skills?.loading && !skills?.error && menu !== 'slash'}
    onChange={value => { input.onChange(value); updateCommand(value, editor.current?.selectionStart ?? value.length) }}
    textareaProps={{ ...input.textareaProps,
      role: menu === 'slash' && !disabled ? 'combobox' : undefined,
      'aria-expanded': menu === 'slash' && !disabled ? true : undefined,
      'aria-controls': menu === 'slash' && !disabled ? skillListId : undefined,
      'aria-haspopup': menu === 'slash' && !disabled ? 'listbox' : undefined,
      'aria-activedescendant': menu === 'slash' && !disabled && active ? `${skillListId}-${active}` : undefined,
      onSelect: event => {
        input.textareaProps?.onSelect?.(event)
        if (menu === 'slash' && command.current && !composing.current) {
          const next = event.currentTarget.selectionStart === event.currentTarget.selectionEnd
            ? skillCommandAt(event.currentTarget.value, event.currentTarget.selectionStart) : null
          if (!next) { command.current = null; setMenu(null) }
          else if (next.start !== command.current?.start || next.end !== command.current?.end) updateCommand(event.currentTarget.value, event.currentTarget.selectionStart)
        }
      },
      onCompositionStart: event => { composing.current = true; setMenu(null); input.textareaProps?.onCompositionStart?.(event) },
      onCompositionEnd: event => { composing.current = false; input.textareaProps?.onCompositionEnd?.(event); updateCommand(event.currentTarget.value, event.currentTarget.selectionStart) },
      onKeyDown: event => {
        input.textareaProps?.onKeyDown?.(event)
        if (event.defaultPrevented || menu !== 'slash') return
        if (event.key === 'Escape') { event.preventDefault(); command.current = null; setMenu(null) }
        if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
          event.preventDefault()
          if (enabledSkills.length) {
            const index = enabledSkills.findIndex(option => option.skillId === active)
            setActiveSkill(enabledSkills[(index + (event.key === 'ArrowDown' ? 1 : -1) + enabledSkills.length) % enabledSkills.length].skillId)
          }
        }
        if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (active) pickSkill(active) }
      } }}
    additions={{ view: disabled ? null : menu === 'slash' ? 'skills' : menu, disabled, skills: visibleSkills.map(option => ({ id: option.skillId,
      label: option.name, description: option.unavailable || option.description, selected: option.fixed || selectedSkills.some(item => item.skillId === option.skillId && item.version === option.version),
      disabled: !!(option.fixed || option.unavailable || disabled || skills?.loading || skills?.error) })),
      skillStatus, listId: skillListId, activeSkillId: active, onActiveSkill: setActiveSkill, isSlash: menu === 'slash',
      onView: view => { command.current = null; setActiveSkill(''); setMenu(view) }, onSkill: pickSkill, focusSkills: menu === 'skills' }}
    contextItems={contextItems}
    contextIndicator={<ContextRing tokens={measured?.tokens} limit={connection?.contextWindow} lowerBound={measured?.lowerBound} usageLabel="上次调用" />}
    model={model} models={selection.stale ? [] : options} onModelSettings={onModelSettings}
    modelDisabled={modelBusy || (!onModelSettings && (selection.stale || !options.length))}
    onModelChange={id => { const choice = byId.get(id); if (choice && id !== selectedId) void selection.choose(choice, onModelSelected) }}
    effort={effort} efforts={efforts} showEffort={!!connection}
    effortDisabled={modelBusy || selection.stale || !supportedEffort || !byId.has(selectedId)} effortTitle={supportedEffort ? undefined : disabledEffort}
    onEffortChange={(_id, level) => {
      const next = (Object.keys(effortLabels) as ModelReasoningEffort[]).find(key => effortLabels[key] === level) ?? 'auto'
      if (selected && supportedEffort && level !== effort) void selection.choose(selected, undefined, next)
    }}
    status={files.error ? { role: 'alert', text: files.error } : files.busy ? { role: 'status', text: '正在准备附件…' }
      : selection.error ? { role: 'status', text: selection.error } : undefined} />
}

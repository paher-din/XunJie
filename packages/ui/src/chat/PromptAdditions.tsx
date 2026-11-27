import { useEffect, useId, useRef, useState } from 'react'
import { ChatComposerTokenElement } from '@astryxdesign/core/Chat'
import { Icon } from '../icons'

export interface PromptContextItem {
  id: string
  label: string
  kind: 'attachment' | 'skill'
  remove?: () => void
}

export interface PromptAdditionsProps {
  view: 'add' | 'skills' | null
  allowFiles?: boolean
  singleSkill?: boolean
  disabled?: boolean
  skills: readonly { id: string; label: string; description: string; disabled?: boolean; selected?: boolean }[]
  skillStatus?: string
  onView: (view: PromptAdditionsProps['view']) => void
  onFiles: () => void
  onSkill: (id: string) => void
  focusSkills?: boolean
  listId?: string
  activeSkillId?: string
  onActiveSkill?: (id: string) => void
  isSlash?: boolean
  restoreFocus: () => void
}

export function PromptAdditions({ view, disabled, allowFiles = true, singleSkill = false, skills, skillStatus, onView, onFiles, onSkill, focusSkills, restoreFocus,
  listId: suppliedId, activeSkillId, onActiveSkill, isSlash }: PromptAdditionsProps) {
  const fallbackId = useId(), listId = suppliedId ?? fallbackId
  const [localActive, setLocalActive] = useState('')
  const active = skills.find(skill => skill.id === (activeSkillId ?? localActive) && !skill.disabled)?.id ?? skills.find(skill => !skill.disabled)?.id
  const highlight = (id: string) => { setLocalActive(id); onActiveSkill?.(id) }
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!view) return
    const closeOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) onView(null)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [view, onView])
  useEffect(() => {
    if (view === 'add' || view === 'skills' && focusSkills) menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [view, focusSkills])
  useEffect(() => {
    if (view === 'skills' && active) document.getElementById(`${listId}-${active}`)?.scrollIntoView?.({ block: 'nearest' })
  }, [view, active, listId])

  return <div className="prompt-add" ref={root} onKeyDown={event => {
    if (event.key === 'Escape' && view) { event.preventDefault(); onView(null); if (view === 'skills') restoreFocus(); else trigger.current?.focus(); return }
    if (!view || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
    if (!items.length) return
    event.preventDefault()
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
    items[next]?.focus()
  }}>
    <button ref={trigger} type="button" className="prompt-attach" aria-label={allowFiles ? '添加' : '选择技能'} aria-haspopup={!allowFiles || view === 'skills' ? 'listbox' : 'menu'}
      aria-expanded={!!view} aria-controls={view ? listId : undefined} disabled={disabled}
      onClick={() => onView((allowFiles ? view === 'add' : !!view) ? null : allowFiles ? 'add' : 'skills')}><Icon name="add" size={18} /></button>
    {view && <div ref={menu} id={listId} className="prompt-model-menu prompt-add-menu" data-view={view}
      role={view === 'add' ? 'menu' : 'listbox'} aria-multiselectable={view === 'skills' && !singleSkill ? true : undefined} aria-label={view === 'add' ? '添加' : '选择技能'}>
      <header className="prompt-add-title"><strong>{view === 'add' ? '添加' : '技能'}</strong>
        {view === 'skills' && <span>输入 / 快速调用</span>}</header>
      {view === 'add' ? <>
        <button type="button" className="prompt-add-item" role="menuitem" onClick={() => { onView(null); trigger.current?.focus(); onFiles() }}>
          <Icon name="paperclip" size={18} />
          <span className="prompt-add-copy"><strong>附件</strong><small>添加文本、代码文件或 PDF</small></span>
        </button>
        <button type="button" className="prompt-add-item" role="menuitem" onClick={() => onView('skills')}>
          <Icon name="skill" size={18} />
          <span className="prompt-add-copy"><strong>技能</strong><small>为这条消息调用固定技能</small></span>
          <span className="prompt-menu-key">/</span>
        </button>
      </> : <>
        {skills.map(skill => <button key={skill.id} id={`${listId}-${skill.id}`} type="button" className="prompt-add-item prompt-skill-item" role="option"
          aria-selected={!!skill.selected} data-active={active === skill.id} disabled={skill.disabled} title={skill.description}
          onFocus={() => highlight(skill.id)} onPointerMove={() => { if (!skill.disabled) highlight(skill.id) }}
          onClick={() => { onSkill(skill.id); restoreFocus() }}>
          <Icon name="skill" size={18} />
          <span className="prompt-add-copy"><strong>{skill.label}</strong>{skill.description && <small>{skill.description}</small>}</span>
          {skill.selected && <Icon name="check" size={14} />}
        </button>)}
        {skillStatus && <p className="prompt-add-status" role="status">{skillStatus}</p>}
        {isSlash && <footer className="prompt-skill-footer">↑↓ 选择 · Enter 确认 · Esc 关闭</footer>}
      </>}
    </div>}
  </div>
}

export function PromptContextChips({ items, restoreFocus }: { items: readonly PromptContextItem[]; restoreFocus?: () => void }) {
  if (!items.length) return null
  return <ul className="prompt-context-chips" aria-label="本条消息的附件和技能">
    {items.map(item => <li key={item.id} data-kind={item.kind} title={item.label}>
      {item.kind === 'skill' ? <ChatComposerTokenElement token={{ value: `/${item.label}`, label: item.label, variant: 'blue',
        icon: <Icon name="skill" size={13} /> }} />
        : <><Icon name="paperclip" size={14} /><span>{item.label}</span></>}
      {item.kind === 'attachment' && item.remove && <button type="button" aria-label={`移除附件 ${item.label}`}
        onClick={() => { item.remove?.(); restoreFocus?.() }}><Icon name="close" size={12} /></button>}
    </li>)}
  </ul>
}

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConversationHistoryItem, LearningActivity } from '@xunjie/contracts/learning-data'
import { ConversationPane } from '@xunjie/ui/foundation'
import { Icon } from '@xunjie/ui/icons'
import { useToastFeedback } from '@xunjie/ui/feedback'

export { useConversationHistory } from './useConversationHistory'

const PAGE_SIZE = 8
const FOLDABLE_GROUPS = new Set(['置顶', '更早'])
const CLOSED_MENU = { id: null as string | null, up: false, closing: false }

export function conversationTitle(activity: LearningActivity, labels: readonly ConversationHistoryItem[]) {
  return labels.find(item => item.activityId === activity.activityId)?.title || activity.goal || activity.question || '资料学习'
}

export function ProductConversationHistory({ activities, activeId, labels, archiveOpen, query, error, ready, busy,
  scopeKey, visible = true, readOnly = false, onNew, onOpen, onArchiveOpenChange, onQueryChange,
  onArchive, onRestore, onRename, onPin, onDelete, onRetry }: {
  activities: LearningActivity[] | null
  activeId?: string
  labels: readonly ConversationHistoryItem[]
  archiveOpen: boolean
  query: string
  error: string
  ready: boolean
  busy: boolean
  scopeKey: string
  visible?: boolean
  readOnly?: boolean
  onNew: () => void
  onOpen: (id: string) => void
  onArchiveOpenChange: (open: boolean) => void
  onQueryChange: (query: string) => void
  onArchive: (id: string) => Promise<boolean>
  onRestore: (id: string) => Promise<boolean>
  onRename: (id: string, title: string) => Promise<boolean>
  onPin: (id: string, pinned: boolean) => Promise<boolean>
  onDelete: (id: string) => Promise<boolean>
  onRetry: () => void
}) {
  // The controller also reports background read/import failures; those stay beside Retry.
  const operationError = error === '对话操作未确认，请检查连接后再次操作。' ? error : ''
  useToastFeedback(visible ? operationError : '')
  const [menu, setMenu] = useState(CLOSED_MENU)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const renaming = useRef<string | null>(null)
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const [shown, setShown] = useState(PAGE_SIZE)
  const [archivedShown, setArchivedShown] = useState(PAGE_SIZE)
  const [foldedGroups, setFoldedGroups] = useState<string[]>([])
  const [foldingGroup, setFoldingGroup] = useState<string | null>(null)
  const closeTimer = useRef<number | undefined>(undefined)
  const foldTimer = useRef<number | undefined>(undefined)
  const anchor = useRef<HTMLElement | null>(null)
  const search = useRef<HTMLInputElement>(null)
  const currentScope = useRef(scopeKey); currentScope.current = scopeKey
  const clearMenu = useCallback(() => { window.clearTimeout(closeTimer.current); setMenu(CLOSED_MENU) }, [])
  const closeMenu = useCallback((restoreFocus = false) => {
    window.clearTimeout(closeTimer.current)
    setMenu(previous => previous.id ? { ...previous, closing: true } : previous)
    closeTimer.current = window.setTimeout(() => setMenu(CLOSED_MENU), 140)
    if (restoreFocus && anchor.current?.isConnected && !anchor.current.closest('[inert]')) anchor.current.focus({ preventScroll: true })
  }, [])
  const clearModes = useCallback(() => {
    clearMenu(); renaming.current = null; setRenamingId(null); setConfirmingId(null)
  }, [clearMenu])
  useEffect(() => {
    clearModes(); setShown(PAGE_SIZE); setArchivedShown(PAGE_SIZE)
  }, [scopeKey, visible, archiveOpen, clearModes])
  useEffect(() => { setFoldedGroups([]); setFoldingGroup(null) }, [scopeKey])
  useEffect(() => () => { window.clearTimeout(closeTimer.current); window.clearTimeout(foldTimer.current) }, [])
  useEffect(() => {
    if (!menu.id || !visible) return
    const outside = (event: PointerEvent) => {
      if (!anchor.current?.closest('.agent-conv-row')?.contains(event.target as Node)) closeMenu()
    }
    const scroll = (event: Event) => {
      if (event.target === document || event.target instanceof Element && anchor.current && event.target.contains(anchor.current)) closeMenu()
    }
    const resize = () => closeMenu()
    document.addEventListener('pointerdown', outside)
    document.addEventListener('scroll', scroll, true)
    window.addEventListener('resize', resize)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('scroll', scroll, true); window.removeEventListener('resize', resize) }
  }, [menu.id, visible, closeMenu])

  const states = new Map(labels.map(item => [item.activityId, item]))
  const conversations = (activities ?? []).filter(activity => !activity.course && !states.get(activity.activityId)?.deleted)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.activityId.localeCompare(b.activityId))
    .map(activity => ({ id: activity.activityId, title: conversationTitle(activity, labels),
      pinned: states.get(activity.activityId)?.pinned ?? false, archived: states.get(activity.activityId)?.archived ?? false,
      createdAt: activity.createdAt }))
  const archived = conversations.filter(item => item.archived)
  const term = query.trim().toLowerCase()
  const matches = (item: { title: string }) => item.title.toLowerCase().includes(term)
  const active = conversations.filter(item => !item.archived && matches(item))
  const pinned = active.filter(item => item.pinned)
  const rest = active.filter(item => !item.pinned)
  const visibleItems = term ? rest : rest.slice(0, shown)
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime()
  const groups = [
    { label: '今天', items: visibleItems.filter(item => Date.parse(item.createdAt) >= today) },
    { label: '昨天', items: visibleItems.filter(item => Date.parse(item.createdAt) >= yesterday && Date.parse(item.createdAt) < today) },
    { label: '更早', items: visibleItems.filter(item => !(Date.parse(item.createdAt) >= yesterday)) },
  ].filter(group => group.items.length)
  useEffect(() => {
    if (ready && activities !== null && archiveOpen && archived.length === 0) onArchiveOpenChange(false)
  }, [ready, activities, archiveOpen, archived.length, onArchiveOpenChange])
  const focusSearch = () => requestAnimationFrame(() => { if (search.current?.isConnected && !search.current.closest('[inert]')) search.current.focus({ preventScroll: true }) })
  const focusPin = (id: string) => requestAnimationFrame(() => {
    const row = [...document.querySelectorAll<HTMLElement>('[data-conversation-id]')].find(item => item.dataset.conversationId === id && !item.closest('[inert]'))
    row?.querySelector<HTMLButtonElement>('.agent-conv-pin')?.focus({ preventScroll: true })
  })
  const loadMore = useCallback(() => setShown(value => value + PAGE_SIZE), [])
  const loadMoreArchived = useCallback(() => setArchivedShown(value => value + PAGE_SIZE), [])

  return <>
    {error && <div className="agent-side-empty" role={operationError ? undefined : 'alert'}>{!operationError && error} <button type="button" className="agent-side-clear" onClick={onRetry}>重试</button></div>}
    {!ready || activities === null ? <>
      <button type="button" className="agent-newchat" onClick={onNew}><span className="navicon"><Icon name="pen-new-square" size={14} /></span>新对话</button>
      <div className="agent-side-empty" role="status">{error ? '暂时无法显示对话' : '正在读取对话…'}</div>
    </> : <ConversationPane archived={archived} archivedVisible={archived.slice(0, archivedShown)}
      archivedHits={term ? archived.filter(matches) : []} pinned={pinned} groups={groups} archiveOpen={archiveOpen}
      query={query} searching={!!term} activeId={activeId ?? null} menu={menu} renamingId={renamingId} confirmingId={confirmingId}
      foldedGroups={foldedGroups} foldingGroup={foldingGroup} foldableGroups={FOLDABLE_GROUPS} actionsDisabled={busy || readOnly}
      remaining={!term && rest.length > shown} moreArchived={archived.length > archivedShown}
      foldSignal={foldedGroups.join('|') + ':' + (foldingGroup ?? '')} searchRef={search}
      onNew={() => { clearModes(); onNew() }} onOpen={id => { clearModes(); onOpen(id) }}
      onToggleArchive={open => { clearModes(); onArchiveOpenChange(open) }}
      onSearch={value => { clearModes(); setShown(PAGE_SIZE); onQueryChange(value) }} onClearSearch={() => onQueryChange('')}
      onToggleMenu={(id, target) => {
        if (menu.id === id && !menu.closing) { closeMenu(true); return }
        clearModes(); anchor.current = target
        const row = target.closest('.agent-conv-row')
        const bottom = row?.closest('.side-nav, .railpanel .agent-groups')?.getBoundingClientRect().bottom ?? window.innerHeight
        setMenu({ id, up: bottom - (row?.getBoundingClientRect().bottom ?? 0) < 116, closing: false })
      }}
      onTogglePin={(id, pinned) => { clearMenu(); void onPin(id, pinned).then(saved => { if (saved) focusPin(id) }) }}
      onStartRename={id => { clearMenu(); renaming.current = id; setRenamingId(id); setConfirmingId(null) }}
      onCommitRename={(id, title) => {
        if (renaming.current !== id) return
        const startedScope = scopeKey
        void onRename(id, title).then(saved => {
          if (saved && currentScope.current === startedScope && renaming.current === id) { renaming.current = null; setRenamingId(null); focusSearch() }
        })
      }}
      onCancelRename={() => { renaming.current = null; setRenamingId(null); focusSearch() }}
      onArchive={id => { clearMenu(); void onArchive(id).then(saved => { if (saved) focusSearch() }) }}
      onAskDelete={id => { clearMenu(); setConfirmingId(id); renaming.current = null; setRenamingId(null) }}
      onConfirmDelete={id => { const startedScope = scopeKey; void onDelete(id).then(saved => {
        if (saved && currentScope.current === startedScope) { setConfirmingId(null); focusSearch() }
      }) }}
      onCancelDelete={() => { setConfirmingId(null); focusSearch() }}
      onRestore={id => { void onRestore(id).then(saved => { if (saved) focusSearch() }) }}
      onToggleGroup={label => {
        clearMenu(); setFoldedGroups(previous => previous.includes(label) ? previous.filter(item => item !== label) : [...previous, label])
        setFoldingGroup(label); window.clearTimeout(foldTimer.current)
        foldTimer.current = window.setTimeout(() => setFoldingGroup(null), 240)
      }} onLoadMore={loadMore} onLoadMoreArchived={loadMoreArchived} />}
  </>
}

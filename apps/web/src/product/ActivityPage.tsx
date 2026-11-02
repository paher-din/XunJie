import { useRef, useState, type ReactNode, type RefObject } from 'react'
import type { LearningActivity } from '@xunjie/contracts/learning-data'
import { Icon, IconText } from '../icons'
import { CenterToolArea, type ToolSpec } from '../components/workspace/CenterToolArea'
import { ComponentView } from '../component-host/ComponentView'
import { useActivitySession } from './ActivitySession'
import { WorkspacePopover } from '../components/workspace/WorkspacePopover'
import { SelectionToolbar, WorkspaceReferenceComposer, useWorkspaceReferences } from '../components/workspace/references'
import { ActivityWorkspace, type ActivityWorkspaceHandle } from './ActivityWorkspace'
import { ActivityActions } from './ActivityActions'
import { ExecutionPanel } from './ExecutionPanel'

/** The existing workspace container consumes the reliable session; it owns only layout and focus. */
export function ActivityPage({ activity, spaceKey, namespace, authorized, workspaceRef, busy, onBack, onStatus, onRefresh, details, account, error }: {
  activity: LearningActivity; spaceKey: string; namespace: string; authorized: boolean
  workspaceRef: RefObject<ActivityWorkspaceHandle | null>; busy: boolean
  onBack: () => void; onStatus: () => void; onRefresh: () => void
  details: ReactNode; account: ReactNode; error: ReactNode
}) {
  const [materialsOpen, setMaterialsOpen] = useState(!!activity.course)
  const [tabsSlot, setTabsSlot] = useState<HTMLDivElement | null>(null)
  const references = useWorkspaceReferences()
  const ask = useRef<HTMLButtonElement>(null)
  const { workspace } = useActivitySession()
  const [toolError, setToolError] = useState('')
  const tools: ToolSpec[] = [{ key: 'design', label: '作品', icon: 'code-square' },
    ...(activity.course?.components ?? []).map(binding => ({ key: `component:${binding.key}` as const, label: binding.configuration.title, icon: 'clipboard-text' as const }))]
  // A component may declare a restricted run; its record, stop and download stay in this area.
  const toolBodies = Object.fromEntries((activity.course?.components ?? []).map(binding => [`component:${binding.key}`,
    (binding.definition.manifest.operations?.length
      ? <div key={binding.key} className="component-tool">
        <ComponentView activity={activity} binding={binding} spaceKey={spaceKey} namespace={namespace} authorized={authorized} />
        <ExecutionPanel activity={activity} binding={binding} authorized={authorized} />
      </div>
      : <ComponentView key={binding.key} activity={activity} binding={binding} spaceKey={spaceKey} namespace={namespace} authorized={authorized} />)]))
  const title = activity.course?.taskTitle || activity.goal || activity.question || '资料学习'
  return <div className={'ws ws-organized product-workspace' + (references.open ? ' discussion-open' : '')}>
    <header className="ws-head">
      <button type="button" className="ws-navbtn" aria-label="返回活动列表" onClick={onBack}><Icon name="arrow-left" size={18} /></button>
      <div className="product-activity-title"><span>{activity.course?.courseName ?? '自主学习'}</span><h1 id="activity-title">{title}</h1></div>
      <div className="ws-head-utilities">
        <button type="button" className="ws-btn ghost" aria-expanded={materialsOpen} onClick={() => {
          if (window.matchMedia('(width < 1024px)').matches && references.open) { references.setOpen(false); setMaterialsOpen(true) }
          else setMaterialsOpen(value => !value)
        }}>
          <IconText name="clipboard-text">目标与材料</IconText></button>
        <button ref={ask} type="button" className="ws-btn ghost" aria-label={references.open ? '问题与引用' : '打开对话'}
          aria-expanded={references.open} onClick={() => references.setOpen(!references.open)}><IconText name="chat-round-dots">询问 Agent</IconText></button>
        <WorkspacePopover label="活动" icon="menu-dots">
          <p>{activity.status === 'closed' ? '活动已关闭，可随时重新开始。' : '继续围绕这个目标学习。'}</p>
          <button type="button" className="ws-btn ghost" disabled={busy} onClick={onStatus}>{activity.status === 'closed' ? '重新开始活动' : '关闭活动'}</button>
          <button type="button" className="ws-btn ghost" disabled={busy} onClick={onRefresh}>刷新列表</button>
          {account}
        </WorkspacePopover>
      </div>
    </header>
    {error && <div className="product-workspace-notice">{error}</div>}
    {toolError && <div role="alert" className="product-workspace-notice">{toolError}</div>}
    <div className="ws-commandbar"><div className="ws-head-tabs" ref={setTabsSlot} />
      <span className="product-workspace-caption">当前作品{activity.status === 'closed' ? ' · 活动已关闭' : ''}</span></div>
    <div className="ws-body">
      {materialsOpen && <aside className="product-task-details" aria-label="目标与材料">{details}</aside>}
      <CenterToolArea taskId={namespace + ':' + activity.activityId} tools={tools} toolBodies={toolBodies}
        beforeToolChange={() => workspace.leave()}
        tool="design" onToolChange={() => { setToolError('') }} onToast={setToolError} tabsSlot={tabsSlot}
        designBody={<ActivityWorkspace ref={workspaceRef} activity={activity} spaceKey={spaceKey} namespace={namespace} authorized={authorized} />} />
      {references.open && <aside className="product-discussion" aria-label="问题与引用">
        <WorkspaceReferenceComposer closeFocusRef={ask} /><ActivityActions />
      </aside>}
    </div>
    <SelectionToolbar />
  </div>
}

import type { Ref } from 'react'
import { Icon, IconText } from '../icons'
import { WorkspacePopover } from './WorkspacePopover'
import { HdlBuildPane, type HdlBuildPaneProps } from './HdlToolArea'
import type { HdlBuildView } from './hdlPresentation'

/** 仅展示初始化事实；模式文案与初始化代次由页面提供。 */
export interface PrepBadgeProps {
  status: string
  loadEpoch: number
  label: string
  modeLabel: string
  statusLabel: string
  attention: boolean
  signingOut: boolean
  onSignOut: () => void
}
export function PrepBadge({ status, loadEpoch, label, modeLabel, statusLabel, attention, signingOut, onSignOut }: PrepBadgeProps) {
  return <span className="ts-badge" data-status={status} data-load-epoch={loadEpoch || undefined}>
    <WorkspacePopover label={label} icon="shield-check" closeOnAction attention={attention}>
      <p>{modeLabel} · {statusLabel}</p>
      <button type="button" className="ws-btn ghost" disabled={signingOut} onClick={onSignOut}>
        <IconText name="logout-2">{signingOut ? '结束中…' : '退出'}</IconText>
      </button>
    </WorkspacePopover>
  </span>
}

export interface PrepSnapshotOption { id: string; label: string }
export interface PrepHelpMenuProps {
  onProjectHelp: () => void
  boardHelp?: { disabled: boolean; onHelp: () => void }
  codeHelp?: {
    snapshotId: string
    snapshots: readonly PrepSnapshotOption[]
    onSnapshotChange: (id: string) => void
    onFileHelp: () => void
    onSelectionHelp: () => void
  }
}
export function PrepHelpMenu({ onProjectHelp, boardHelp, codeHelp }: PrepHelpMenuProps) {
  return <WorkspacePopover label="求助" icon="chat-round-dots" closeOnAction>
    <p>选择要讨论的对象，继续在同一个项目中获得帮助。</p>
    <button type="button" className="ws-btn ghost" onClick={onProjectHelp}>就项目求助</button>
    {boardHelp && <button type="button" className="ws-btn ghost" disabled={boardHelp.disabled} onClick={boardHelp.onHelp}>引用当前板卡求助</button>}
    {codeHelp && <>
      <label className="ws-control-field">引用的确认版本<select aria-label="代码求助快照" value={codeHelp.snapshotId} onChange={event => codeHelp.onSnapshotChange(event.target.value)}>
        {!codeHelp.snapshots.length && <option value="">尚无确认快照</option>}
        {codeHelp.snapshots.map(snapshot => <option key={snapshot.id} value={snapshot.id}>{snapshot.label}</option>)}
      </select></label>
      <button type="button" className="ws-btn ghost" onClick={codeHelp.onFileHelp}>就这个文件求助</button>
      <button type="button" className="ws-btn ghost" onClick={codeHelp.onSelectionHelp}>就所选代码求助</button>
    </>}
  </WorkspacePopover>
}

export interface PrepWorkspaceHeaderProps {
  onBack: () => void
  tabsRef: Ref<HTMLDivElement>
  help?: PrepHelpMenuProps
  onSubmission?: () => void
  onStopHelp?: () => void
  badge: PrepBadgeProps
}
export function PrepWorkspaceHeader({ onBack, tabsRef, help, onSubmission, onStopHelp, badge }: PrepWorkspaceHeaderProps) {
  return <header className="ws-head">
    <div className="ws-navbtns"><button className="ws-navbtn" aria-label="返回" onClick={onBack}><Icon name="arrow-left" size={18} /></button></div>
    <div className="ws-head-tabs" ref={tabsRef} />
    <div className="ws-head-utilities">
      {help && <PrepHelpMenu {...help} />}
      {onSubmission && <button type="button" className="ws-btn ghost" onClick={onSubmission}>提交与反馈</button>}
      {onStopHelp && <button type="button" className="ws-btn ghost" onClick={onStopHelp}>停止这次帮助</button>}
      <PrepBadge {...badge} />
    </div>
  </header>
}

/** 运行簇仍由原 Portal 装入相同 ref，避免改变挂载位置或命令时序。 */
export interface PrepWorkspaceCommandBarProps { runRef: Ref<HTMLDivElement> }
export function PrepWorkspaceCommandBar({ runRef }: PrepWorkspaceCommandBarProps) {
  return <div className="ws-commandbar" aria-label="工作区操作"><div className="ws-head-run" ref={runRef} /></div>
}

export type PrepDraftConflictChoice = 'mine' | 'stored'
export interface PrepDraftConflictFile { fileId: string; path: string }
export interface PrepDraftConflictRowProps {
  file: PrepDraftConflictFile
  busy: boolean
  onChoose: (fileId: string, choice: PrepDraftConflictChoice) => void
}
export function PrepDraftConflictRow({ file, busy, onChoose }: PrepDraftConflictRowProps) {
  return <div className="ws-draft-conflict" data-fileid={file.fileId}>
    <span className="ws-draft-conflict-path">{file.path}</span>
    <span className="ws-draft-conflict-actions">
      <button type="button" className="outline" disabled={busy} onClick={() => onChoose(file.fileId, 'mine')}>用本页正文继续</button>
      <button type="button" className="outline" disabled={busy} onClick={() => onChoose(file.fileId, 'stored')}>载入另一处正文</button>
    </span>
  </div>
}
export interface PrepDraftConflictBarProps {
  files: readonly PrepDraftConflictFile[]
  busy: boolean
  onChoose: PrepDraftConflictRowProps['onChoose']
}
export function PrepDraftConflictBar({ files, busy, onChoose }: PrepDraftConflictBarProps) {
  if (!files.length) return null
  return <div className="ws-draft-conflicts">
    <p className="ws-draft-conflicts-note">这份草稿在另一处也被修改过，请选择保留哪一份正文。</p>
    {files.map(file => <PrepDraftConflictRow key={file.fileId} file={file} busy={busy} onChoose={onChoose} />)}
  </div>
}

export interface PrepHdlBuildSettingsProps {
  snapshotId: string
  snapshots: readonly PrepSnapshotOption[]
  onSelect: (id: string) => void
  busy: boolean
  showRead: boolean
  readBusy: boolean
  onRead: () => void
}
export function PrepHdlBuildSettings({ snapshotId, snapshots, onSelect, busy, showRead, readBusy, onRead }: PrepHdlBuildSettingsProps) {
  return <WorkspacePopover label="构建设置" icon="settings">
    <p>构建使用所选确认快照；草稿不会自动保存或装载。</p>
    <label className="ws-control-field">构建版本<select aria-label="HDL 确认快照" value={snapshotId} onChange={event => onSelect(event.target.value)} disabled={busy}>
      <option value="">选择确认快照</option>
      {snapshots.map(snapshot => <option key={snapshot.id} value={snapshot.id}>{snapshot.label}</option>)}
    </select></label>
    {showRead && <button type="button" className="ws-btn ghost" disabled={readBusy} onClick={onRead}>核对 HDL 状态</button>}
  </WorkspacePopover>
}

export type PrepHdlBuildPanelProps<TBuild extends HdlBuildView = HdlBuildView> = HdlBuildPaneProps<TBuild>
export function PrepHdlBuildPanel<TBuild extends HdlBuildView>(props: PrepHdlBuildPanelProps<TBuild>) {
  return <div style={{ maxHeight: '34vh', overflow: 'auto', flexShrink: 0 }}><HdlBuildPane {...props} /></div>
}

export interface PrepHdlRequestActionProps { busy: boolean; onReconcile: () => void }
export function PrepHdlRequestAction({ busy, onReconcile }: PrepHdlRequestActionProps) {
  return <button type="button" className="ws-btn ghost" disabled={busy} onClick={onReconcile}>核对原 HDL 请求</button>
}

export interface PrepComparisonActionProps { onCompare: () => void }
export function PrepComparisonAction({ onCompare }: PrepComparisonActionProps) {
  return <span className="ws-run-actions"><button type="button" className="ws-btn ghost" style={{ padding: '0 10px', fontSize: 12 }} onClick={onCompare}>比较双方正文</button></span>
}

export interface PrepSessionReplaceDialogProps {
  sessionId: string
  sessionRevision: number
  disabled: boolean
  onKeep: () => void
  onReplace: () => void
}
export function PrepSessionReplaceDialog({ sessionId, sessionRevision, disabled, onKeep, onReplace }: PrepSessionReplaceDialogProps) {
  return <div role="dialog" aria-modal="true" aria-label="确认替换虚拟板会话"
    style={{ position: 'fixed', inset: '25% 25% auto', zIndex: 20, background: 'var(--paper)', padding: 24, border: '1px solid var(--line)' }}>
    <p>替换会停止原虚拟板并按新构建重新初始化；原实例退出确认前不会显示新装载成功。</p>
    <p>原会话 {sessionId} · 版本 {sessionRevision}</p>
    <button type="button" className="ws-btn ghost" onClick={onKeep}>保留原会话</button>
    <button type="button" className="ws-btn solid" disabled={disabled} onClick={onReplace}>确认替换装载</button>
  </div>
}

export interface PrepTutoringReturnNoticeProps {
  toast?: string | null
  returnNotice?: { notice: string; origin?: { fileId: string; path: string; documentVersion: number | null } } | null
}
export function PrepTutoringReturnNotice({ toast, returnNotice }: PrepTutoringReturnNoticeProps) {
  if (!toast && !returnNotice) return null
  return <div className="toast" role="status">
    {toast}
    {returnNotice && <><p data-testid="tutor-return-notice">{returnNotice.notice}</p>
      {returnNotice.origin && <p data-testid="tutor-return-origin" data-file-id={returnNotice.origin.fileId}>
        本机保留的原引用：{returnNotice.origin.path} · {returnNotice.origin.documentVersion === null ? '本机未确认实例' : `原文件版本 ${returnNotice.origin.documentVersion}`}
      </p>}</>}
  </div>
}

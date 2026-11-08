import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react'
import { Icon } from '../icons'
import type { WorkspaceFile as ProjectFile, WorkspaceAccess, DraftProtectionDisplay } from './filePresentation'
import { eolLabel, eolOf, hasBom, languageLabel, languageOf, type CreateOutcome } from './projectFiles'
import { CodeEditorHost, type CodeEditorHandle } from './CodeEditorHost'
import { FileStrip, type FileStripHandle } from './FileStrip'
import type { CodeSelectionResult } from './codeSelection'
import { diagnosticStatusText, type EditorDiagnosticsDisplay } from './diagnosticPresentation'

export interface CodeWorkspaceDisplay {
  loaded: boolean
  files: ProjectFile[]
  openFiles: ProjectFile[]
  activeFile: ProjectFile | null
  access: WorkspaceAccess
  protection: DraftProtectionDisplay
  usage: { activeFiles: number; activeBytes: number }
  createdFileIds: string[]
  dirtyFileIds: string[]
  fileActions: Record<string, { recycleBlockedReason: string | null; restoreBlockedReason: string | null; occupant: ProjectFile | null }>
}
export interface CodeWorkspaceProps {
  state: CodeWorkspaceDisplay
  /** Current authoritative draft text; never normalized before the editor receives it. */
  text: string
  workspaceKey: string
  editorHandleRef?: Ref<CodeEditorHandle>
  onSelectionChange?: (result: CodeSelectionResult) => void
  diagnostics?: EditorDiagnosticsDisplay
  onOpen: (fileId: string) => void
  onCloseTab: (fileId: string) => void
  onCreate: (name: string) => CreateOutcome
  onDraftChange: (fileId: string, text: string) => void
  onRecycle: (fileId: string) => void
  onRestore: (fileId: string) => void
}

/** Controlled code view. Storage, lifecycle decisions and commands stay with the caller. */
export function CodeWorkspace({ state, text: activeText, workspaceKey, editorHandleRef, onSelectionChange, diagnostics, onOpen, onCloseTab, onCreate, onDraftChange, onRecycle, onRestore }: CodeWorkspaceProps) {
  const editorRef = useRef<CodeEditorHandle>(null)
  const stripRef = useRef<FileStripHandle>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [cursor, setCursor] = useState<{ line: number; column: number } | null>(null)

  const active = state.activeFile
  // 已回收的实例不继续编辑：草稿留着，但编辑区换成明确说明（同一个空态容器，不新造页面）。
  const recycledActive = active !== null && active.lifecycle === 'recycled'
  const activeList = useMemo(() => state.files.filter(file => file.lifecycle === 'active'), [state.files])
  const readOnly = state.access.kind === 'read-only'
  const readOnlyReason = accessReason(state.access)

  useImperativeHandle(editorHandleRef, () => ({
    focus: () => editorRef.current?.focus(),
    saveViewState: () => editorRef.current?.saveViewState() ?? null,
    captureSelection: () => editorRef.current?.captureSelection() ?? { ok: false, reason: '没有可用的代码编辑器。' },
    revealOriginalRange: (location) => editorRef.current?.revealOriginalRange(location) ?? { ok: false, reason: '没有可用的代码编辑器。' },
  }))
  const selectionCallback = useRef(onSelectionChange)
  selectionCallback.current = onSelectionChange
  useEffect(() => {
    if (active === null || recycledActive) selectionCallback.current?.({ ok: false, reason: '没有打开的活动文件，请重新选择。' })
  }, [active?.fileId, recycledActive])

  return (
    <div className="cw">
      {state.access.kind !== 'editable' && (
        <p className="cw-access" data-kind={state.access.kind}>
          <Icon name="lock-keyhole" size={14} tone="neutral" />
          <span>{state.access.reason}</span>
          {state.access.kind === 'paused' && <b>可以继续编辑已有文件，不能新建、回收或恢复</b>}
        </p>
      )}

      <FileStrip
        ref={stripRef}
        files={activeList}
        recycledFiles={state.files.filter((file) => file.lifecycle === 'recycled')}
        openFiles={state.openFiles}
        activeFileId={active?.fileId ?? null}
        isDirty={file => state.dirtyFileIds.includes(file.fileId)}
        isCreated={file => state.createdFileIds.includes(file.fileId)}
        lifecyclePending={file => file.confirmed === null || file.confirmed.lifecycle !== file.lifecycle}
        canCreate={state.access.kind === 'editable'}
        createBlockedReason={state.access.kind === 'editable' ? null : state.access.reason}
        canManage={state.access.kind === 'editable'}
        manageBlockedReason={state.access.kind === 'editable' ? null : state.access.reason}
        recycleBlockedReason={file => state.fileActions[file.fileId]?.recycleBlockedReason ?? null}
        restoreBlockedReason={file => state.fileActions[file.fileId]?.restoreBlockedReason ?? null}
        restoreOccupant={file => state.fileActions[file.fileId]?.occupant ?? null}
        usage={state.usage}
        menuOpen={menuOpen}
        onMenuOpenChange={setMenuOpen}
        onOpen={onOpen}
        onClose={onCloseTab}
        onCreate={(name) => {
          const outcome = onCreate(name)
          if (outcome.ok) editorRef.current?.focus()
          return outcome
        }}
        onRecycle={onRecycle}
        onRestore={onRestore}
      />

      {active === null || recycledActive ? (
        <div className="cw-empty">
          <p>{recycledActive ? '这个实例已回收，草稿保留。' : '编辑区没有打开的文件。'}</p>
          <div className="cw-empty-actions">
            <button
              type="button"
              className="outline"
              onClick={() => {
                if (activeList[0]) onOpen(activeList[0].fileId)
              }}
              disabled={activeList.length === 0}
            >
              打开项目里的文件
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => stripRef.current?.startNaming()}
              disabled={state.access.kind !== 'editable'}
            >
              新建文件
            </button>
          </div>
        </div>
      ) : (
        <CodeEditorHost
          ref={editorRef}
          workspaceKey={workspaceKey}
          fileId={active.fileId}
          language={languageOf(active.path)}
          initialText={activeText}
          readOnly={readOnly}
          readOnlyReason={readOnlyReason}
          onTextChange={onDraftChange}
          onCursorChange={setCursor}
          onSelectionChange={onSelectionChange}
          diagnostics={diagnostics?.markers}
        />
      )}

      {diagnostics && active && <details className="cw-diagnostics" aria-label="编辑检查">
        <summary>{diagnostics.result?.status === 'ready' && diagnostics.result.diagnostics.length
          ? `编辑检查：${diagnostics.result.diagnostics.filter(item => item.severity === 'error').length} 个错误，${diagnostics.result.diagnostics.filter(item => item.severity === 'warning').length} 个警告`
          : diagnosticStatusText[diagnostics.status]}</summary>
        {diagnostics.result?.status === 'ready' ? <>
          <p>静态分析当前草稿，未保存或运行程序；无诊断不代表课程验收通过。</p>
          <ul>{diagnostics.result.diagnostics.map((issue, index) => <li key={index}>
            <span>{issue.severity === 'error' ? '错误' : issue.severity === 'warning' ? '警告' : '提示'}：{issue.message}</span>
            {issue.path && <span> · {issue.path}{issue.line ? `:${issue.line}${issue.range ? `:${issue.range.startColumn}` : '（整行定位）'}` : ''}</span>}
          </li>)}</ul>
        </> : diagnostics.status === 'paused' ? <p>采集暂停、限定检查或当前任务不可编辑时，不发送代码做自动检查。</p> : null}
      </details>}
      <StatusBar file={active} created={active !== null && state.createdFileIds.includes(active.fileId)} dirty={active !== null && state.dirtyFileIds.includes(active.fileId)} loaded={state.loaded} protection={state.protection} cursor={cursor} text={activeText} />
    </div>
  )
}

function accessReason(access: WorkspaceAccess): string | null {
  if (access.kind === 'read-only') return `${access.reason}，作品只读`
  if (access.kind === 'paused') return `${access.reason}，只能继续编辑已有文件`
  return null
}

export function StatusBar({
  file,
  created, dirty, loaded, protection,
  cursor,
  text,
}: {
  file: ProjectFile | null
  created: boolean
  dirty: boolean
  loaded: boolean
  protection: DraftProtectionDisplay
  cursor: { line: number; column: number } | null
  text: string
}) {
  return (
    <div className="cw-status">
      <span className="cw-status-path">{file?.path ?? '没有打开的文件'}</span>
      {file && (
        <>
          <span className="cw-status-sep" aria-hidden="true">
            ·
          </span>
          <span>{languageLabel(languageOf(file.path))}</span>
          <span className="cw-status-sep" aria-hidden="true">
            ·
          </span>
          <span className="cw-status-mono">
            {cursor === null ? '行 —，列 —' : `行 ${cursor.line}，列 ${cursor.column}`}
          </span>
          <span className="cw-status-sep" aria-hidden="true">
            ·
          </span>
          <span className="cw-status-mono">{eolLabel(eolOf(text))}</span>
          {hasBom(text) && <span className="cw-status-mono">BOM</span>}
          <span className="cw-status-sep" aria-hidden="true">
            ·
          </span>
          <span className="cw-status-mono">UTF-8</span>
        </>
      )}
      <span className="cw-status-right">
        {file && (
          <span className="cw-confirmed">
            {created ? (
              '本机新建 · 还没有确认作品'
            ) : file.confirmed === null ? (
              '确认实例已不可用 · 草稿保留待比较'
            ) : (
              <>
                文件版本 v{file.confirmed?.version}
                {dirty && <b className="cw-unconfirmed"> · 有未确认修改</b>}
              </>
            )}
          </span>
        )}
        {/* 未确认的回收/恢复自成一句：它改的是实例的生命周期，不是正文，不和「有未确认修改」合并表述。 */}
        {file !== null && file.confirmed !== null && file.confirmed.lifecycle !== file.lifecycle && (
          <b className="cw-unconfirmed cw-lifecycle-pending" data-lifecycle={file.lifecycle}>
            {file.lifecycle === 'recycled' ? '待确认回收' : '待确认恢复'}
          </b>
        )}
        {loaded && <ProtectionChip status={protection.status} reason={protection.reason} />}
      </span>
    </div>
  )
}

/**
 * 本机草稿保护状态。文案严格区分「本机已保护」与「已保存作品」：
 * 前者只说明这台机器上的写入事务完成了，作品要学生自己发起确认保存才会上传。
 */
export function ProtectionChip({ status, reason }: { status: DraftProtectionDisplay['status']; reason: string | null }) {
  if (status === 'failed') {
    return (
      <span className="cw-protect" data-status="failed" title={reason ?? undefined}>
        <i />
        本机草稿未保护 · 正文还在内存，刷新会丢失
      </span>
    )
  }
  return (
    <span className="cw-protect" data-status={status}>
      <i />
      {status === 'saving' ? '正在保护本机草稿…' : '本机草稿已保护'}
    </span>
  )
}

/** 顶栏运行簇：工作区级的确认状态与操作（学科工具包声明，见 docs/home-design.md Q3）。 */
export interface CodeRunClusterProps {
  access: WorkspaceAccess
  lifecyclePendingCount: number
  unconfirmedCount: number
  confirmedRevision: number
  onSave: () => void
}
export function CodeRunCluster({ access, lifecyclePendingCount, unconfirmedCount, confirmedRevision, onSave }: CodeRunClusterProps) {
  return (
    <>
      <span className="ws-run-state" data-state={access.kind === 'editable' ? 'editing' : 'locked'}>
        <i />
        <span>{access.kind === 'read-only' ? '作品只读' : access.kind === 'paused' ? '分配已暂停' : '编辑中'}</span>
      </span>
      {lifecyclePendingCount > 0 && (
        // 生命周期意图与正文修改是两件事：正文可能一个字没改，回收/恢复也要学生点确认保存才生效。
        <span className="ws-flow" title="回收/恢复改的是实例的生命周期，随下一次确认保存一并发出">
          <span className="ws-flow-node draft">
            <i />
            {lifecyclePendingCount} 个实例待确认回收或恢复
          </span>
        </span>
      )}
      {unconfirmedCount > 0 ? (
        <span className="ws-flow" title="本机草稿不等于已保存的作品；确认保存由学生发起">
          <span className="ws-flow-node draft">
            <i />
            {/* 只报「正文或新建」这一部分：生命周期意图上面已经单独说过，同一件事不报两遍 */}
            {unconfirmedCount - lifecyclePendingCount > 0
              ? `${unconfirmedCount - lifecyclePendingCount} 个文件未确认`
              : '有未确认的实例状态'}
          </span>
          <span className="ws-flow-link">▸</span>
          <span className="ws-flow-node loaded">确认作品 v{confirmedRevision}</span>
        </span>
      ) : (
        <span className="ws-flow synced" title="本机草稿与确认作品逐字一致">
          <b>✓</b>
          与确认作品 v{confirmedRevision} 一致
        </span>
      )}
      <span className="ws-run-actions">
        <button type="button" className="ws-btn solid" onClick={onSave} disabled={unconfirmedCount === 0}>
          确认保存（模拟）
        </button>
      </span>
    </>
  )
}

// Public props for the independently exported visual parts.
export type StatusBarProps = Parameters<typeof StatusBar>[0]
export type ProtectionChipProps = Parameters<typeof ProtectionChip>[0]

import { useRef, useState } from 'react'
import { Icon } from '../../icons'
import type { ProjectFile } from '../../bridge/types'
import { eolLabel, eolOf, hasBom, languageLabel, languageOf } from '../../lib/projectFiles'
import { CodeEditorHost, type CodeEditorHandle } from './CodeEditorHost'
import { FileStrip, type FileStripHandle } from './FileStrip'
import type { ProjectWorkspace } from './useProjectWorkspace'

/**
 * 程序设计课程的核心工具：多文件代码编辑区。
 *
 * 三层信息各就各位，不互相冒充：
 * - 文件条 = 文件实例与标签（关标签不删文件）；
 * - 编辑器 = 当前文件的正文，正文权威在调用方的草稿，不在编辑器的显示值；
 * - 状态行 = 这个文件的编辑事实（行列 / 换行 / 编码）与本机草稿的保护状态。
 *
 * 「确认保存」不在这块面板里：作品是否已保存属于工作区级的确认状态，落在顶栏运行簇
 * （学科工具包声明操作），本机草稿的保护状态与它是两件事，界面不合并表述。
 */
export interface CodeWorkspaceProps {
  ws: ProjectWorkspace
  /** 隔离命名空间：mock 用任务 id，正式版是模式 / 账号 / Attempt 的组合。 */
  workspaceKey: string
}

export function CodeWorkspace({ ws, workspaceKey }: CodeWorkspaceProps) {
  const editorRef = useRef<CodeEditorHandle>(null)
  const stripRef = useRef<FileStripHandle>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [cursor, setCursor] = useState<{ line: number; column: number } | null>(null)

  const active = ws.activeFile
  const readOnly = ws.access.kind !== 'editable'
  const readOnlyReason = accessReason(ws)
  const activeText = active === null ? '' : ws.draftText(active.fileId)

  return (
    <div className="cw">
      {ws.access.kind !== 'editable' && (
        <p className="cw-access" data-kind={ws.access.kind}>
          <Icon name="lock-keyhole" size={14} tone="neutral" />
          <span>{ws.access.reason}</span>
          {ws.access.kind === 'paused' && <b>可以继续编辑已有文件，不能新建、回收或恢复</b>}
        </p>
      )}

      <FileStrip
        ref={stripRef}
        files={ws.files.filter((file) => file.lifecycle === 'active')}
        openFiles={ws.openFiles}
        activeFileId={active?.fileId ?? null}
        isDirty={ws.isDirty}
        isCreated={ws.isCreated}
        canCreate={ws.access.kind === 'editable'}
        createBlockedReason={ws.access.kind === 'editable' ? null : ws.access.reason}
        usage={ws.usage}
        menuOpen={menuOpen}
        onMenuOpenChange={setMenuOpen}
        onOpen={ws.open}
        onClose={ws.closeTab}
        onCreate={(name) => {
          const outcome = ws.create(name, '')
          if (outcome.ok) editorRef.current?.focus()
          return outcome
        }}
      />

      {active === null ? (
        <div className="cw-empty">
          <p>编辑区没有打开的文件。</p>
          <div className="cw-empty-actions">
            <button
              type="button"
              className="outline"
              onClick={() => {
                const first = ws.files.find((file) => file.lifecycle === 'active')
                if (first) ws.open(first.fileId)
              }}
              disabled={ws.files.length === 0}
            >
              打开项目里的文件
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => stripRef.current?.startNaming()}
              disabled={ws.access.kind !== 'editable'}
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
          onTextChange={(fileId, text) => ws.setDraft(fileId, text)}
          onCursorChange={setCursor}
        />
      )}

      <StatusBar file={active} ws={ws} cursor={cursor} text={activeText} />
    </div>
  )
}

function accessReason(ws: ProjectWorkspace): string | null {
  if (ws.access.kind === 'read-only') return `${ws.access.reason}，作品只读`
  if (ws.access.kind === 'paused') return `${ws.access.reason}，只能继续编辑已有文件`
  return null
}

function StatusBar({
  file,
  ws,
  cursor,
  text,
}: {
  file: ProjectFile | null
  ws: ProjectWorkspace
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
            {ws.isCreated(file) ? (
              '本机新建 · 还没有确认作品'
            ) : (
              <>
                文件版本 v{file.confirmed?.version}
                {ws.isDirty(file) && <b className="cw-unconfirmed"> · 有未确认修改</b>}
              </>
            )}
          </span>
        )}
        {ws.loaded && <ProtectionChip status={ws.protection.status} reason={ws.protection.reason} />}
      </span>
    </div>
  )
}

/**
 * 本机草稿保护状态。文案严格区分「本机已保护」与「已保存作品」：
 * 前者只说明这台机器上的写入事务完成了，作品要学生自己发起确认保存才会上传。
 */
function ProtectionChip({ status, reason }: { status: ProjectWorkspace['protection']['status']; reason: string | null }) {
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
export function CodeRunCluster({ ws, onSave }: { ws: ProjectWorkspace; onSave: () => void }) {
  return (
    <>
      <span className="ws-run-state" data-state={ws.access.kind === 'editable' ? 'editing' : 'locked'}>
        <i />
        <span>{ws.access.kind === 'read-only' ? '作品只读' : ws.access.kind === 'paused' ? '分配已暂停' : '编辑中'}</span>
      </span>
      {ws.unconfirmedCount > 0 ? (
        <span className="ws-flow" title="本机草稿不等于已保存的作品；确认保存由学生发起">
          <span className="ws-flow-node draft">
            <i />
            {ws.unconfirmedCount} 个文件未确认
          </span>
          <span className="ws-flow-link">▸</span>
          <span className="ws-flow-node loaded">确认作品 v{ws.confirmedRevision}</span>
        </span>
      ) : (
        <span className="ws-flow synced" title="本机草稿与确认作品逐字一致">
          <b>✓</b>
          与确认作品 v{ws.confirmedRevision} 一致
        </span>
      )}
      <span className="ws-run-actions">
        <button type="button" className="ws-btn solid" onClick={onSave} disabled={ws.unconfirmedCount === 0}>
          确认保存（模拟）
        </button>
      </span>
    </>
  )
}

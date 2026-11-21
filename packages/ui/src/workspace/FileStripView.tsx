import { Popover } from '@base-ui/react/popover'
import { useEffect, useId, useRef, useState } from 'react'
import { ConfirmationDialog } from '../foundation/ConfirmationDialog'
import { Icon } from '../icons'
import { FileTabs, type FileTabDisplay } from './FileTabs'
import './file-strip-view.css'

export interface FileStripViewProps {
  files: FileTabDisplay[]
  openFiles: FileTabDisplay[]
  activeId: string | null
  readOnly: boolean
  canManage(id: string): boolean
  onOpen(id: string): void
  onClose(id: string): void
  onCreate(name: string): string | undefined
  onRename(id: string, name: string): string | undefined
  onDelete(id: string): Promise<void>
  onExport(): void
}

function fileIconName(name: string): 'file-text' | 'file-code' {
  return /\.(txt|md)$/i.test(name) ? 'file-text' : 'file-code'
}

export function FileStripView({
  files,
  openFiles,
  activeId,
  readOnly,
  canManage,
  onOpen,
  onClose,
  onCreate,
  onRename,
  onDelete,
  onExport,
}: FileStripViewProps) {
  const trigger = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const errorId = useId()
  const [open, setOpen] = useState(false)
  const [actions, setActions] = useState<string | null>(null)
  const [naming, setNaming] = useState<{ id?: string; value: string; error?: string } | null>(null)
  const [deleting, setDeleting] = useState<FileTabDisplay | null>(null)
  const [deletingBusy, setDeletingBusy] = useState(false)
  const [deleteError, setDeleteError] = useState('')

  const namingActive = Boolean(naming)
  const namingId = naming?.id
  useEffect(() => {
    if (!namingActive) return
    const input = inputRef.current
    if (!input) return
    input.focus()
    if (namingId) {
      const dot = input.value.lastIndexOf('.')
      if (dot > 0) input.setSelectionRange(0, dot)
      else input.select()
    }
  }, [namingActive, namingId])

  const openIds = new Set(openFiles.map(item => item.id))

  function changeOpen(next: boolean) {
    setOpen(next)
    if (!next) {
      setActions(null)
      setNaming(null)
    }
  }

  async function confirmDelete() {
    if (!deleting || deletingBusy) return
    setDeletingBusy(true)
    setDeleteError('')
    try {
      await onDelete(deleting.id)
      setDeleting(null)
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : '删除未完成，请重试。')
    } finally {
      setDeletingBusy(false)
    }
  }

  const nameForm = naming && (
    <form
      className="cw-managed-name"
      onSubmit={event => {
        event.preventDefault()
        if (readOnly) return
        const name = naming.value.trim()
        const error = naming.id ? onRename(naming.id, name) : onCreate(name)
        if (error) setNaming({ ...naming, error })
        else changeOpen(false)
      }}
    >
      <label>
        {naming.id ? '新名称' : '文件名'}
        <input
          ref={inputRef}
          className="cw-managed-input"
          autoComplete="off"
          spellCheck={false}
          value={naming.value}
          maxLength={240}
          placeholder={naming.id ? undefined : '例如 alu.sv 或 notes.md'}
          aria-invalid={!!naming.error}
          aria-describedby={naming.error ? errorId : undefined}
          onChange={event => setNaming({ id: naming.id, value: event.target.value })}
          onKeyDown={event => {
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              setNaming(null)
            }
          }}
        />
      </label>
      {naming.error && (
        <p id={errorId} className="cw-managed-error" role="alert">
          {naming.error}
        </p>
      )}
      <div className="cw-managed-actions">
        <button type="button" className="ws-btn ghost cw-managed-form-btn" onClick={() => setNaming(null)}>
          取消
        </button>
        <button type="submit" className="ws-btn solid cw-managed-form-btn" disabled={readOnly}>
          {naming.id ? '确认改名' : '创建'}
        </button>
      </div>
    </form>
  )

  return (
    <>
      <nav className="cw-filestrip" aria-label="作品文件">
        <Popover.Root open={open} onOpenChange={changeOpen}>
          <Popover.Trigger ref={trigger} className="cw-stripbtn cw-managed-trigger" aria-label="文件">
            <Icon name="folder-with-files" size={15} variant="linear" tone="neutral" />
            <span className="cw-managed-trigger-label">文件</span>
            <span className="cw-managed-count" aria-hidden="true">
              {files.length}
            </span>
            <Icon name="alt-arrow-down" size={12} variant="linear" tone="neutral" className="cw-managed-chevron" />
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Positioner className="cw-managed-positioner" align="start" sideOffset={6} collisionPadding={12}>
              <Popover.Popup className="cw-filemenu cw-managed-menu" aria-label="文件" finalFocus={trigger}>
                {(files.length > 0 || readOnly) && (
                  <div className="cw-managed-head" aria-hidden="true">
                    <span>作品文件</span>
                    <span>
                      {readOnly
                        ? '只读'
                        : openFiles.length < files.length
                          ? `已打开 ${openFiles.length} / ${files.length}`
                          : `${files.length} 个文件`}
                    </span>
                  </div>
                )}

                <div className="cw-managed-list">
                  {files.length === 0 && !(naming && !naming.id) && (
                    <p className="cw-managed-empty">还没有作品文件</p>
                  )}
                  {files.map(file => {
                    const isActive = activeId === file.id
                    const isClosed = !openIds.has(file.id)
                    const isActionsOpen = actions === file.id && !readOnly && canManage(file.id)
                    return (
                      <div
                        key={file.id}
                        className="cw-managed-entry"
                        data-active={isActive}
                        data-closed={isClosed || undefined}
                        data-expanded={isActionsOpen || undefined}
                      >
                        {naming?.id === file.id ? (
                          nameForm
                        ) : (
                          <>
                            <div className="cw-managed-row">
                              <button
                                type="button"
                                className="cw-managed-item cw-managed-file-btn"
                                title={isClosed ? `${file.name}（标签已关闭，点击重新打开）` : file.name}
                                onClick={() => {
                                  onOpen(file.id)
                                  changeOpen(false)
                                }}
                              >
                                <Icon
                                  name={fileIconName(file.name)}
                                  size={15}
                                  variant="linear"
                                  tone="neutral"
                                  className="cw-managed-file-icon"
                                />
                                <span className="cw-managed-path">{file.name}</span>
                                {isActive && (
                                  <Icon
                                    name="check"
                                    size={14}
                                    variant="linear"
                                    tone="neutral"
                                    className="cw-managed-active-check"
                                  />
                                )}
                              </button>
                              {!readOnly && canManage(file.id) && (
                                <button
                                  type="button"
                                  className="cw-managed-more"
                                  aria-label={`管理 ${file.name}`}
                                  aria-expanded={isActionsOpen}
                                  onClick={() => setActions(isActionsOpen ? null : file.id)}
                                >
                                  <Icon name="menu-dots" size={15} variant="linear" tone="neutral" />
                                </button>
                              )}
                            </div>
                            {isActionsOpen && (
                              <div className="cw-managed-row-actions">
                                <button
                                  type="button"
                                  className="cw-managed-command"
                                  onClick={() => {
                                    setActions(null)
                                    setNaming({ id: file.id, value: file.name })
                                  }}
                                >
                                  <Icon name="pen" size={13} variant="linear" tone="neutral" />
                                  <span>重命名</span>
                                </button>
                                <button
                                  type="button"
                                  className="cw-managed-command cw-managed-delete"
                                  onClick={() => {
                                    changeOpen(false)
                                    setDeleteError('')
                                    setDeleting(file)
                                  }}
                                >
                                  <Icon name="trash-bin-trash" size={13} variant="linear" />
                                  <span>删除</span>
                                </button>
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    )
                  })}
                </div>

                <div className="cw-managed-footer">
                  {naming && !naming.id ? (
                    nameForm
                  ) : (
                    <button
                      type="button"
                      className="cw-managed-item cw-managed-action"
                      disabled={readOnly}
                      title={readOnly ? '当前作品只读，不能新建文件' : undefined}
                      onClick={() => {
                        setActions(null)
                        setNaming({ value: '' })
                      }}
                    >
                      <Icon name="add" size={15} variant="linear" tone="neutral" />
                      <span>新建文件</span>
                    </button>
                  )}
                  {files.length > 0 && (
                    <button type="button" className="cw-managed-item cw-managed-action" onClick={onExport}>
                      <Icon name="download-minimalistic" size={15} variant="linear" tone="neutral" />
                      <span>导出作品备份</span>
                    </button>
                  )}
                </div>
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
        <span className="cw-managed-strip-sep" aria-hidden="true" />
        <FileTabs files={openFiles} activeId={activeId} onOpen={onOpen} onClose={onClose} />
      </nav>
      <ConfirmationDialog
        open={!!deleting}
        title="删除文件"
        description={`将从当前作品删除「${deleting?.name ?? ''}」。删除后无法从回收站恢复。`}
        confirmLabel="删除文件"
        busy={deletingBusy}
        error={deleteError}
        onClose={() => setDeleting(null)}
        onReturnFocus={() => trigger.current?.focus()}
        onConfirm={() => void confirmDelete()}
      />
    </>
  )
}

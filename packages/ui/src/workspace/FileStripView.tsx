import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState, type ReactNode } from 'react'
import { Icon } from '../icons'
import { FileTabs, type FileTabDisplay } from './FileTabs'
import { ConfirmationDialog } from '../foundation/ConfirmationDialog'
import './file-strip-view.css'

/** Shared strip geometry; ownership and lifecycle stay with the host. */
export function FileStripFrame({ children }: { children: ReactNode }) {
  return <div className="cw-filestrip">{children}</div>
}
export interface FileStripViewHandle { startNaming(): void }
export interface FileStripViewProps {
  files: FileTabDisplay[]; openFiles: FileTabDisplay[]; activeId: string | null
  disabled?: boolean; canManage?: (id: string) => boolean
  onOpen(id: string): void; onClose(id: string): void
  onCreate(name: string): string | null; onRename(id: string, name: string): string | null
  onDelete(id: string): string | null; onExport(): void
}
export const FileStripView = forwardRef<FileStripViewHandle, FileStripViewProps>(function FileStripView({
  files, openFiles, activeId, disabled, canManage = () => true, onOpen, onClose, onCreate, onRename, onDelete, onExport,
}, ref) {
  const [open, setOpen] = useState(false)
  const [naming, setNaming] = useState<{ id?: string; value: string } | null>(null)
  const [actions, setActions] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [deleting, setDeleting] = useState<FileTabDisplay | null>(null)
  const [deleteError, setDeleteError] = useState('')
  const errorId = useId()
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const close = () => { setOpen(false); setNaming(null); setActions(null); setError('') }
  const startNaming = () => { setOpen(true); setNaming({ value: '' }); setError(''); setActions(null) }
  useImperativeHandle(ref, () => ({ startNaming }))
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) close() }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])
  const editor = naming && <form className="cw-name-wrap" onSubmit={event => {
    event.preventDefault()
    if (disabled) return
    const problem = naming.id ? onRename(naming.id, naming.value.trim()) : onCreate(naming.value.trim())
    if (problem) setError(problem); else close()
  }}>
    <label className="cw-name-label">{naming.id ? '重命名文件' : '新建文件'}
      <input autoFocus value={naming.value} maxLength={240} placeholder="例如 notes.md" aria-invalid={!!error}
        aria-describedby={error ? errorId : undefined} onChange={event => { setNaming({ ...naming, value: event.target.value }); setError('') }} /></label>
    {error && <p id={errorId} className="cw-name-error" role="alert">{error}</p>}
    <div className="cw-name-actions"><button type="submit" className="ws-btn solid" disabled={disabled}>{naming.id ? '确认改名' : '创建'}</button>
      <button type="button" className="ws-btn ghost" onClick={() => { setNaming(null); setError('') }}>取消</button></div>
  </form>
  return <>
    <FileStripFrame>
      <div className="cw-filelist" ref={root} onKeyDown={event => {
        if (event.key === 'Escape') { event.stopPropagation(); close(); trigger.current?.focus() }
      }}>
        <button ref={trigger} type="button" className="cw-stripbtn" aria-expanded={open} onClick={() => open ? close() : setOpen(true)}>
          <Icon name="folder-with-files" size={15} /><span>文件</span><b>{files.length}</b></button>
        {open && <div className="cw-filemenu cw-managed-menu" aria-label="作品文件列表">
          {!files.length && <p className="cw-filemenu-empty">这个活动还没有文件</p>}
          {files.map(file => <div key={file.id} className={'cw-filemenu-row' + (activeId === file.id ? ' active' : '')}>
            {naming?.id === file.id ? editor : <>
              <button type="button" className="cw-filemenu-open" onClick={() => { onOpen(file.id); close() }}>
                <Icon name={/\.(txt|md)$/i.test(file.name) ? 'file-text' : 'file-code'} size={15} /><span className="cw-filemenu-path">{file.name}</span></button>
              {canManage(file.id) && <button type="button" className="cw-filemenu-recycle" aria-label={`管理 ${file.name}`} aria-expanded={actions === file.id}
                onClick={() => setActions(actions === file.id ? null : file.id)}><Icon name="menu-dots" size={16} /></button>}
              {actions === file.id && <div className="cw-row-actions">
                <button type="button" className="ws-btn ghost" disabled={disabled} onClick={() => { setNaming({ id: file.id, value: file.name }); setActions(null); setError('') }}>重命名</button>
                <button type="button" className="ws-btn ghost cw-delete-action" disabled={disabled} onClick={() => { setDeleting(file); setDeleteError(''); close() }}>删除</button>
              </div>}
            </>}
          </div>)}
          {naming && !naming.id ? editor : <button type="button" className="cw-filemenu-row cw-filemenu-add" disabled={disabled} onClick={startNaming}>
            <Icon name="add" size={15} /><span>新建文件</span></button>}
          <div className="cw-export-action"><button type="button" className="ws-btn ghost" onClick={onExport}>导出作品备份</button></div>
        </div>}
      </div>
      <FileTabs files={openFiles} activeId={activeId} onOpen={onOpen} onClose={onClose} />
    </FileStripFrame>
    <ConfirmationDialog open={!!deleting} title="删除文件" description={<>将从当前作品移除「{deleting?.name}」。此操作没有回收站恢复入口。</>}
      confirmLabel="删除文件" error={deleteError} onClose={() => setDeleting(null)} onReturnFocus={() => trigger.current?.focus()}
      onConfirm={() => { if (!deleting) return; const problem = onDelete(deleting.id); if (problem) setDeleteError(problem); else setDeleting(null) }} />
  </>
})

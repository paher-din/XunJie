import type { ReactNode } from 'react'
import { Icon } from '../icons'

/** File identity and lifecycle stay with the caller. Closing a tab never deletes a file. */
export interface FileTabDisplay {
  id: string
  name: string
  decoration?: ReactNode
}

export interface FileTabsProps {
  files: FileTabDisplay[]
  activeId: string | null
  onOpen: (id: string) => void
  onClose?: (id: string) => void
  tabRoles?: boolean
}

export function FileTabs({ files, activeId, onOpen, onClose, tabRoles = false }: FileTabsProps) {
  return <div className="cw-filetabs" role={tabRoles ? 'tablist' : 'group'} aria-label="已打开的文件">
    {files.map(file => <div key={file.id} className={'cw-filetab' + (file.id === activeId ? ' active' : '')}>
      <button type="button" className="cw-filetab-main" role={tabRoles ? 'tab' : undefined}
        aria-selected={tabRoles ? file.id === activeId : undefined} aria-pressed={tabRoles ? undefined : file.id === activeId}
        title={file.name} onClick={() => onOpen(file.id)}>
        <Icon name={/\.(txt|md)$/i.test(file.name) ? 'file-text' : 'file-code'} size={14} tone="neutral" />
        <span className="cw-filetab-name">{file.name}</span>{file.decoration}
      </button>
      {onClose && <button type="button" className="cw-filetab-x" aria-label={`关闭 ${file.name} 的标签`}
        title="关闭标签（文件仍在项目里）" onClick={() => onClose(file.id)}><Icon name="close" size={12} /></button>}
    </div>)}
    {files.length === 0 && <span className="cw-filetabs-empty">没有打开的文件</span>}
  </div>
}

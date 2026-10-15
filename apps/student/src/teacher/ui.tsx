import type { ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Icon } from '../icons'
import type { IconName } from '../icons/catalog'
import type { TeacherCourse } from './types'

export function TeacherButton({ children, onClick, primary = false, disabled = false, icon, type = 'button' }: {
  children: ReactNode; onClick?: () => void; primary?: boolean; disabled?: boolean; icon?: IconName; type?: 'button' | 'submit'
}) {
  return <button type={type} className={`t-button${primary ? ' t-button-primary' : ''}`} onClick={onClick} disabled={disabled}>
    {icon && <Icon name={icon} size={16} />}{children}
  </button>
}
export function TeacherBadge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'progress' | 'done' | 'pending' | 'overdue' }) {
  return <span className={`t-badge t-badge-${tone}`}>{children}</span>
}
export function CourseMark({ kind }: { kind: TeacherCourse['kind'] }) {
  return <span className={`t-course-mark ${kind === 'hdl' ? 'hdl' : ''}`}><Icon name={kind === 'hdl' ? 'cpu' : 'code-square'} size={24} /></span>
}
export function TeacherEmpty({ title, children, icon = 'folder-with-files' }: { title: string; children?: ReactNode; icon?: IconName }) {
  return <div className="t-empty"><span><Icon name={icon} size={28} /></span><h2>{title}</h2><p>{children}</p></div>
}
export function TeacherDialog({ open, onOpenChange, title, description, children }: {
  open: boolean; onOpenChange: (open: boolean) => void; title: string; description: string; children: ReactNode
}) {
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal>
    <Dialog.Overlay className="t-dialog-overlay" />
    <Dialog.Content className="t-dialog">
      <div className="t-dialog-header"><div><Dialog.Title>{title}</Dialog.Title><Dialog.Description>{description}</Dialog.Description></div>
        <Dialog.Close className="t-icon-button" aria-label="关闭对话框"><Icon name="close" size={20} /></Dialog.Close></div>
      <div className="t-dialog-body">{children}</div>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>
}

import { useId, useRef } from 'react'
import { Menu } from '@base-ui/react/menu'
import { Icon, type IconName } from '../icons'
import { Toggle } from './controls'
import './skill-list-item.css'

export interface SkillListItemProps {
  name: string
  description: string
  /** Visible origin label: 课程 / GitHub / 本地. */
  source?: string
  /** Use an icon instead of the source text chip. */
  sourceIcon?: IconName
  checked: boolean
  disabled?: boolean
  readOnly?: boolean
  busy?: boolean
  onCheckedChange(checked: boolean): void
  onOpen(trigger: HTMLButtonElement | null): void
  onRemove?: (trigger: HTMLButtonElement | null) => void
}

/** A compact skill row. Persistence and document loading belong to the caller. */
export function SkillListItem({ name, description, source, sourceIcon, checked, disabled = false, readOnly = false, busy = false,
  onCheckedChange, onOpen, onRemove }: SkillListItemProps) {
  const descriptionId = useId(), transferringFocus = useRef(false), trigger = useRef<HTMLButtonElement>(null)
  return <article className="st-skill-item" aria-busy={busy || undefined}>
    <span className="st-skill-icon" aria-hidden="true"><Icon name="skill" size={22} /></span>
    <button type="button" className="st-skill-copy" onClick={event => onOpen(event.currentTarget)}
      aria-label={`打开技能：${name}${source ? `（${source}）` : ''}`} aria-describedby={descriptionId}>
      <span className="st-skill-title">
        <span className="st-skill-name">{name}</span>
        {sourceIcon ? <span className="st-skill-source-icon" title={source} aria-hidden="true"><Icon name={sourceIcon} size={16} /></span>
          : source && <span className="st-skill-source">{source}</span>}
      </span>
      <span className="st-skill-description" id={descriptionId}>{busy ? '正在保存技能状态…' : description}</span>
    </button>
    <div className="st-skill-actions">
      <Menu.Root onOpenChange={open => { if (open) transferringFocus.current = false }}>
        <Menu.Trigger ref={trigger} className="st-skill-more" aria-label={`更多操作：${name}`} title="更多操作">
          <Icon name="menu-dots" size={20} />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner className="st-skill-menu-positioner" align="end" sideOffset={6}>
            <Menu.Popup className="st-skill-menu" aria-label={`${name}的操作`}
              finalFocus={() => !transferringFocus.current}>
              <Menu.Group>
                <Menu.Item className="st-skill-menu-item" onClick={() => { transferringFocus.current = true; onOpen(trigger.current) }}>
                  <Icon name="file-text" variant="linear" tone="neutral" /><span>打开</span>
                </Menu.Item>
                {onRemove && <Menu.Item className="st-skill-menu-item st-skill-menu-danger" disabled={disabled || readOnly}
                  onClick={() => { transferringFocus.current = true; onRemove(trigger.current) }}>
                  <Icon name="trash-bin-trash" /><span>删除</span>
                </Menu.Item>}
              </Menu.Group>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      <Toggle checked={checked} disabled={disabled || readOnly} label={`启用 ${name}`} onChange={onCheckedChange} />
    </div>
  </article>
}

import { Menu } from '@base-ui/react/menu'
import { Icon } from '../icons'
import './activity-card-menu.css'

export interface ActivityCardMenuProps {
  title: string; closed: boolean; disabled?: boolean; onOpen(): void; onChangeStatus(): void
}
/** A sibling of the card's open button: menu actions never trigger navigation. */
export function ActivityCardMenu({ title, closed, disabled, onOpen, onChangeStatus }: ActivityCardMenuProps) {
  return <Menu.Root>
    <Menu.Trigger className="activity-card-menu-trigger" aria-label={`管理活动：${title}`} disabled={disabled}>
      <Icon name="menu-dots" size={18} />
    </Menu.Trigger>
    <Menu.Portal><Menu.Positioner align="end" sideOffset={6} className="activity-card-menu-positioner">
      <Menu.Popup className="activity-card-menu-popup">
        <Menu.Item className="activity-card-menu-item" onClick={onOpen}>打开活动</Menu.Item>
        <Menu.Item className="activity-card-menu-item" disabled={disabled} onClick={onChangeStatus}>{closed ? '重新开始活动' : '关闭活动'}</Menu.Item>
      </Menu.Popup>
    </Menu.Positioner></Menu.Portal>
  </Menu.Root>
}

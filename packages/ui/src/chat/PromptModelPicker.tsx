import { useId, useState } from 'react'
import { Menu } from '@base-ui/react/menu'
import { Icon, type IconName } from '../icons'

export interface PromptModelOption { id: string; name: string; note: string; icon: IconName }

/** Shared model picker; the caller supplies available models and persists selection. */
export function PromptModelPicker({ model, models, onChange, disabled = false, open: controlledOpen, onOpenChange, onSettings, align = 'end' }: {
  model: PromptModelOption; models: readonly PromptModelOption[]; onChange(id: string): void
  onSettings?(): void; disabled?: boolean; open?: boolean; onOpenChange?(open: boolean): void; align?: 'start' | 'end'
}) {
  const [localOpen, setLocalOpen] = useState(false)
  const open = !disabled && (controlledOpen ?? localOpen)
  const triggerId = useId()
  return <div className="prompt-model">
    <Menu.Root open={open} triggerId={triggerId} modal={false} disabled={disabled}
      onOpenChange={next => { setLocalOpen(next); onOpenChange?.(next) }}>
      <Menu.Trigger id={triggerId} className={open ? 'prompt-model-btn open' : 'prompt-model-btn'} aria-label="切换模型">
        <span className="prompt-model-swap" key={model.id}><Icon className="prompt-model-icon" name={model.icon} />
          <span className="prompt-model-label">{model.name}</span></span>
        <Icon name="alt-arrow-down" size={12} className="caret" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner className="prompt-model-positioner" positionMethod="fixed" side="top" align={align}
          sideOffset={8} collisionPadding={8}>
          <Menu.Popup className="prompt-model-menu" aria-label="模型">
            <Menu.RadioGroup value={model.id}>
              {models.map(option => <Menu.RadioItem key={option.id} value={option.id} label={option.name}
                className="prompt-model-item" closeOnClick onClick={() => onChange(option.id)}>
                <Icon className="mi-icon" name={option.icon} size={20} />
                <span className="mi-copy"><span className="mi-name">{option.name}</span><span className="mi-note">{option.note}</span></span>
                <span className="mi-check">{option.id === model.id && <Icon name="check" size={14} />}</span>
              </Menu.RadioItem>)}
            </Menu.RadioGroup>
            {onSettings && <Menu.Item className="prompt-model-item" closeOnClick onClick={onSettings}>
              <Icon className="mi-icon" name="settings" size={20} /><span className="mi-name">模型设置</span>
            </Menu.Item>}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  </div>
}

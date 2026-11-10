import { Fragment, useRef, useState, type AriaAttributes, type ReactNode } from 'react'
import { Select } from '@base-ui/react/select'
import { Icon } from '../icons'
import './select-field.css'

export interface SelectChoice {
  value: string
  label: string
  description?: string
  icon?: ReactNode
  dividerBefore?: boolean
  disabled?: boolean
}

export interface SelectFieldProps extends Pick<AriaAttributes, 'aria-invalid' | 'aria-describedby'> {
  label: string
  value: string
  options: readonly SelectChoice[]
  onChange(value: string): void
  onOpen?(): void
  disabled?: boolean
  placeholder?: string
  className?: string
  id?: string
  name?: string
}

/** Shared student-facing selection control. Callers own values, options and actions. */
export function SelectField({ label, value, options, onChange, onOpen, disabled = false, placeholder = '请选择',
  className, id, name, 'aria-invalid': invalid, 'aria-describedby': describedBy }: SelectFieldProps) {
  const [open, setOpen] = useState(false), trigger = useRef<HTMLButtonElement>(null)
  const selected = options.find(option => option.value === value)
  const groups: SelectChoice[][] = []
  for (const option of options) {
    if (!groups.length || option.dividerBefore) groups.push([])
    groups[groups.length - 1]!.push(option)
  }
  return <Select.Root value={value} items={options} name={name} disabled={disabled || !options.length} modal={false}
    onValueChange={next => { if (next !== null) onChange(next) }} open={open}
    onOpenChange={next => { setOpen(next); if (next) onOpen?.() }}>
    <Select.Trigger ref={trigger} id={id} aria-label={label} aria-invalid={invalid} aria-describedby={describedBy} data-ui-select-trigger=""
      className={'ui-select-trigger' + (className ? ` ${className}` : '')}>
      {selected?.icon && <span className="ui-select-icon">{selected.icon}</span>}
      <Select.Value className="ui-select-value" data-placeholder={!selected && !value || undefined}>{selected?.label ?? (value || placeholder)}</Select.Value>
      <Select.Icon className="ui-select-arrow"><Icon name="alt-arrow-down" size={16} /></Select.Icon>
    </Select.Trigger>
    <Select.Portal container={trigger.current?.closest<HTMLElement>('[data-ui-popup-scope], [role="dialog"]') ?? undefined}>
      <Select.Positioner className="ui-select-positioner" sideOffset={6} alignItemWithTrigger={false}>
        <Select.Popup className="ui-select-popup" data-ui-select-popup="">
          <Select.List className="ui-select-list">{groups.map((group, index) => <Fragment key={group[0]!.value}>
            {index > 0 && <Select.Separator className="ui-select-divider" />}
            <Select.Group>{group.map(option => <Select.Item key={option.value} value={option.value} label={option.label}
              disabled={option.disabled} className="ui-select-item">
              {option.icon && <span className="ui-select-icon">{option.icon}</span>}
              <span className="ui-select-copy"><Select.ItemText>{option.label}</Select.ItemText>
                {option.description && <small>{option.description}</small>}</span>
              <Select.ItemIndicator className="ui-select-check"><Icon name="check" size={16} /></Select.ItemIndicator>
            </Select.Item>)}</Select.Group>
          </Fragment>)}</Select.List>
        </Select.Popup>
      </Select.Positioner>
    </Select.Portal>
  </Select.Root>
}

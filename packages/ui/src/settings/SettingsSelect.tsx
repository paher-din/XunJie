import { useRef, useState, type ReactNode } from 'react'
import { Select } from '@base-ui/react/select'
import { Combobox } from '@base-ui/react/combobox'
import { Icon } from '../icons'
import './settings-select.css'

const providerLogos: Record<string, string> = {
  deepseek: new URL('../assets/providers/deepseek-color.svg', import.meta.url).href,
  kimi: new URL('../assets/providers/kimi-color.svg', import.meta.url).href,
  'opencode-go': new URL('../assets/providers/opencode.svg', import.meta.url).href,
  'command-code': new URL('../assets/providers/commandcode.svg', import.meta.url).href,
  zhipu: new URL('../assets/providers/zhipu-color.svg', import.meta.url).href,
}

/** Locally bundled provider marks and the product's dedicated custom-connection icon. */
export function ModelProviderLogo({ providerId }: { providerId: string }) {
  const src = providerLogos[providerId]
  return src ? <img alt="" src={src} className={['opencode-go', 'command-code', 'kimi'].includes(providerId) ? 'st-provider-icon-mono' : undefined} />
    : <Icon name={providerId === 'mimo' ? 'brand-mimo' : 'provider-custom'} size={20} />
}

export interface SettingsChoice {
  value: string
  label: string
  description?: string
  icon?: ReactNode
  dividerBefore?: boolean
}

/** Form selector using the established input box and a keyboard-accessible popup. */
export function SettingsSelect({ label, value, options, onChange, onOpen, disabled = false }: {
  label: string; value: string; options: readonly SettingsChoice[]; onChange(value: string): void
  onOpen?(): void; disabled?: boolean
}) {
  const [open, setOpen] = useState(false), trigger = useRef<HTMLButtonElement>(null)
  const selected = options.find(option => option.value === value)
  return <Select.Root value={value} items={options} disabled={disabled} modal={false}
    onValueChange={next => { if (next !== null) onChange(next) }} open={open}
    onOpenChange={next => { setOpen(next); if (next) onOpen?.() }}>
    <Select.Trigger ref={trigger} aria-label={label} className="st-input st-choice-trigger">
      {selected?.icon && <span className="st-choice-icon">{selected.icon}</span>}
      <Select.Value className="st-choice-value">{selected?.label ?? value}</Select.Value>
      <Select.Icon className="st-choice-arrow"><Icon name="alt-arrow-down" size={16} /></Select.Icon>
    </Select.Trigger>
    <Select.Portal container={trigger.current?.closest<HTMLElement>('[role="dialog"]')}>
      <Select.Positioner className="st-choice-positioner" sideOffset={6} alignItemWithTrigger={false}>
        <Select.Popup className="st-choice-popup">
          <Select.List className="st-choice-list"><Select.Group>
            {options.map(option => <div key={option.value}>
              {option.dividerBefore && <Select.Separator className="st-choice-divider" />}
              <Select.Item value={option.value} className="st-choice-item">
                {option.icon && <span className="st-choice-icon">{option.icon}</span>}
                <span className="st-choice-copy"><Select.ItemText>{option.label}</Select.ItemText>
                  {option.description && <small>{option.description}</small>}</span>
                <Select.ItemIndicator className="st-choice-check"><Icon name="check" size={16} /></Select.ItemIndicator>
              </Select.Item>
            </div>)}
          </Select.Group></Select.List>
        </Select.Popup>
      </Select.Positioner>
    </Select.Portal>
  </Select.Root>
}

/** An editable model id: suggestions never prevent use of a custom model. */
export function ModelIdInput({ label, value, options, onChange, onOpen, loading = false }: {
  label: string; value: string; options: readonly SettingsChoice[]; onChange(value: string): void
  onOpen?(): void; loading?: boolean
}) {
  const [open, setOpen] = useState(false), anchor = useRef<HTMLDivElement>(null)
  const selected = options.find(option => option.value === value) ?? null
  return <Combobox.Root items={options} value={selected} inputValue={value}
    itemToStringLabel={item => item.value} itemToStringValue={item => item.value}
    isItemEqualToValue={(a, b) => a.value === b.value}
    filter={(item, query) => `${item.value} ${item.label}`.toLowerCase().includes(query.toLowerCase())}
    onInputValueChange={(next, event) => {
      if (event.reason === 'input-change' || event.reason === 'clear-press') onChange(next)
      // Free-form ids are configuration values, not disposable search queries.
      else if (event.reason !== 'item-press') event.cancel()
    }}
    onValueChange={item => { if (item) onChange(item.value) }} open={open}
    onOpenChange={next => { setOpen(next); if (next) onOpen?.() }}>
    <Combobox.InputGroup ref={anchor} className="st-model-combobox">
      <Combobox.Input aria-label={label} className="st-input st-mono-input" placeholder="搜索或输入模型 ID"
        autoComplete="off" spellCheck={false} />
      <Combobox.Trigger className="st-model-combobox-trigger" aria-label={`展开${label}列表`}><Icon name="alt-arrow-down" size={16} /></Combobox.Trigger>
    </Combobox.InputGroup>
    <Combobox.Portal container={anchor.current?.closest<HTMLElement>('[role="dialog"]')}>
      <Combobox.Positioner className="st-choice-positioner" sideOffset={6}>
        <Combobox.Popup className="st-choice-popup">
          <Combobox.Empty className="st-choice-empty">{loading ? '正在更新模型列表，可继续输入模型 ID…'
            : value.trim() ? '列表中没有此型号，可直接使用填写的模型 ID。' : '暂无模型列表，可直接输入模型 ID。'}</Combobox.Empty>
          <Combobox.List className="st-choice-list">{(item: SettingsChoice) => <Combobox.Item key={item.value} value={item} className="st-choice-item">
            <span className="st-choice-copy"><span>{item.label}</span>{item.label !== item.value && <small className="st-choice-model-id">{item.value}</small>}</span>
            <Combobox.ItemIndicator className="st-choice-check"><Icon name="check" size={16} /></Combobox.ItemIndicator>
          </Combobox.Item>}</Combobox.List>
          {loading && options.length > 0 && <div className="st-choice-foot" role="status">正在更新，当前列表可继续使用</div>}
        </Combobox.Popup>
      </Combobox.Positioner>
    </Combobox.Portal>
  </Combobox.Root>
}

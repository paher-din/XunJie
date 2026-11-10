import { useRef, useState } from 'react'
import { Combobox } from '@base-ui/react/combobox'
import { SelectField, type SelectChoice, type SelectFieldProps } from '../foundation/SelectField'
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

export type SettingsChoice = SelectChoice

/** Form selector using the established input box and a keyboard-accessible popup. */
export function SettingsSelect(props: SelectFieldProps) { return <SelectField {...props} /> }

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
    <Combobox.Portal container={anchor.current?.closest<HTMLElement>('[data-ui-popup-scope], [role="dialog"]') ?? undefined}>
      <Combobox.Positioner className="ui-select-positioner" sideOffset={6}>
        <Combobox.Popup className="ui-select-popup">
          <Combobox.Empty className="ui-select-empty">{loading ? '正在更新模型列表，可继续输入模型 ID…'
            : value.trim() ? '列表中没有此型号，可直接使用填写的模型 ID。' : '暂无模型列表，可直接输入模型 ID。'}</Combobox.Empty>
          <Combobox.List className="ui-select-list">{(item: SettingsChoice) => <Combobox.Item key={item.value} value={item} className="ui-select-item">
            <span className="ui-select-copy"><span>{item.label}</span>{item.label !== item.value && <small className="st-choice-model-id">{item.value}</small>}</span>
            <Combobox.ItemIndicator className="ui-select-check"><Icon name="check" size={16} /></Combobox.ItemIndicator>
          </Combobox.Item>}</Combobox.List>
          {loading && options.length > 0 && <div className="ui-select-foot" role="status">正在更新，当前列表可继续使用</div>}
        </Combobox.Popup>
      </Combobox.Positioner>
    </Combobox.Portal>
  </Combobox.Root>
}

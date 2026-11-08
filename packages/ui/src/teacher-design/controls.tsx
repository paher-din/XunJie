import type { ReactNode, ComponentProps } from 'react'
import { Icon } from '../icons'
import type { DesignCheckDisplay, DesignLinkProps } from './types'
export function DesignAnchor({to, ...props}: DesignLinkProps) { return <a href={to} {...props} /> }
export function PreviewDesignField({ title, hint, required, children }: { title: string; hint?: string; required?: boolean; children: ReactNode }) {
  return <label className="td-field"><span className="td-field-title">{title}{required && <span className="td-required">必填</span>}</span>{children}{hint && <span className="td-hint">{hint}</span>}</label>
}

export function LiveDesignField({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return <label className="td-field"><span className="td-field-title">{title}</span>{children}{hint && <span className="td-hint">{hint}</span>}</label>
}
export function DesignLinkedChoices({ title, options, value, onChange }: { title: string; options: { id: string; title: string }[]; value: string[]; onChange: (value: string[]) => void }) {
  return <fieldset className="tld-links"><legend>{title}</legend>{options.length ? options.map(option => <label key={option.id}><input type="checkbox" checked={value.includes(option.id)} onChange={event => onChange(event.target.checked ? [...value, option.id] : value.filter(id => id !== option.id))} /><span>{option.title || '尚未命名'}</span></label>) : <p className="td-hint">先在前面的章节添加对应内容。</p>}{value.filter(id => !options.some(option => option.id === id)).map(id => <label className="tld-invalid-link" key={id}><input type="checkbox" checked onChange={() => onChange(value.filter(valueId => valueId !== id))} /><span>失效引用：{id}</span></label>)}</fieldset>
}
export function DesignCheckGroup<S extends string>({ title, count, tone, empty, items, onSelect }: { title: string; count: number; tone: string; empty: string; items: DesignCheckDisplay<S>[]; onSelect: (section: S) => void }) {
  return <div className="td-check-group"><div className="td-check-group-title"><span className={`td-check-dot ${tone}`} /><strong>{title}</strong><span>{count}</span></div>{items.length ? items.map((item, index) => <button type="button" className="td-check-item" key={`${item.section}-${index}`} onClick={() => onSelect(item.section)}><span>{item.title}</span><Icon name="alt-arrow-right" tone="neutral" /></button>) : <p className="td-check-empty"><Icon name="check" tone="neutral" />{empty}</p>}</div>
}
export function DesignRepeatHeading({title, index, removable, onRemove}: {title:string;index:number;removable:boolean;onRemove:()=>void}) {
  return <div className="td-repeat-heading"><span className="td-mini-index">{String(index + 1).padStart(2, '0')}</span><strong>{title}</strong><button type="button" className="td-icon-btn" disabled={!removable} title={removable ? '移除此项' : '请先取消其他条目对此项的关联'} aria-label={`移除${title} ${index + 1}`} onClick={onRemove}><Icon name="close" /></button></div>
}


export type PreviewDesignFieldProps = ComponentProps<typeof PreviewDesignField>
export type LiveDesignFieldProps = ComponentProps<typeof LiveDesignField>
export type DesignLinkedChoicesProps = ComponentProps<typeof DesignLinkedChoices>
export type DesignRepeatHeadingProps = ComponentProps<typeof DesignRepeatHeading>
export type DesignCheckGroupProps<S extends string> = Parameters<typeof DesignCheckGroup<S>>[0]

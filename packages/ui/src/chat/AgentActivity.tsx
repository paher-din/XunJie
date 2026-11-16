import { Children, useEffect, useState, useId, type ComponentProps, type ReactNode } from 'react'
import { Collapsible } from '@base-ui/react/collapsible'
import { Spinner } from '@astryxdesign/core/Spinner'
import { Icon, type IconName } from '../icons'
import { MascotSvg } from '../brand'

/** Compact execution rows; multi-step runs start collapsed like Astryx ChatToolCalls. */
export function AgentTrace({ children, className = '', active = false, grouped = false, label = '执行记录', ...props }:
  ComponentProps<'div'> & { active?: boolean; grouped?: boolean; label?: string }) {
  const items = Children.toArray(children)
  const [open, setOpen] = useState(active)
  useEffect(() => { if (active) setOpen(true) }, [active])
  if (!grouped && items.length <= 1) return <div {...props} data-slot="trace" data-count={items.length}
    className={`agent-trace ${className}`.trim()}>{items}</div>
  return <div {...props} data-slot="trace" data-count={items.length} className={`agent-trace ${className}`.trim()}>
    <Collapsible.Root open={open} onOpenChange={setOpen}>
      <Collapsible.Trigger className="agent-trace-group-trigger">
        <span className="agent-trace-group-icon" aria-hidden="true"><Icon name="code-square" tone="neutral" /></span>
        <span className="agent-trace-group-copy"><span className="agent-trace-group-title">{label}</span>
          <span className="agent-trace-group-count">{items.length} 步</span></span>
        <Icon name="alt-arrow-down" className="agent-trace-group-chevron" />
      </Collapsible.Trigger>
      <Collapsible.Panel className="agent-trace-group-panel">
        <div className="agent-trace-group-list">{items}</div>
      </Collapsible.Panel>
    </Collapsible.Root>
  </div>
}

export interface AgentTraceItemProps extends Omit<ComponentProps<typeof Collapsible.Root>, 'title' | 'className'> {
  title: ReactNode; description?: ReactNode; status?: ReactNode; className?: string; icon?: IconName | null
  tone?: 'running' | 'done' | 'error' | 'waiting' | 'neutral'
}
export function AgentTraceItem({ title, description, status, tone = 'neutral', icon = 'code-square', children, className = '', ...props }: AgentTraceItemProps) {
  return <Collapsible.Root {...props} className={`agent-trace-item ${className}`.trim()} data-slot="trace-collapsible" data-tone={tone}>
    <Collapsible.Trigger className="agent-trace-trigger" data-slot="trace-collapsible-trigger">
      <span className="agent-trace-line" data-slot="trace-line" data-status={tone}>
        {icon && <span className="agent-trace-icon" data-slot="trace-icon" aria-hidden="true"><Icon name={icon} tone="neutral" /></span>}
        <span className="agent-trace-copy"><span className="agent-trace-title" data-slot="trace-title">{title}</span>
          {description && <span className="agent-trace-description" data-slot="trace-description">{description}</span>}</span>
        {status && <span className="agent-trace-status"><span aria-hidden="true" className="agent-trace-state-icon">
          {tone === 'running' ? <Spinner size="md" shade="inherit" /> : tone === 'done' ? <Icon name="check-circle" /> : tone === 'error' ? <Icon name="info-circle" /> : tone === 'waiting' ? <Icon name="clock-circle" /> : null}
        </span>{status}</span>}
      </span><Icon name="alt-arrow-down" className="agent-trace-chevron" />
    </Collapsible.Trigger>
    <Collapsible.Panel className="agent-trace-panel" data-slot="trace-collapsible-content"><div className="agent-trace-content">{children}</div></Collapsible.Panel>
  </Collapsible.Root>
}

export interface AgentRunStatusProps extends ComponentProps<'div'> {
  label?: ReactNode; phase?: 'preparing' | 'generating' | 'waiting' | 'stopped' | 'failed' | 'paused' | 'readonly'
}
export function AgentRunStatus({ label, phase = 'generating', children, className = '', ...props }: AgentRunStatusProps) {
  const busy = phase === 'generating' || phase === 'preparing'
  return <div {...props} role="status" className={`agent-run-status ${className}`.trim()} data-phase={phase}>
    <div className="agent-run-heading"><MascotSvg className="agent-run-mascot" motion={busy ? 'think' : 'idle'} /><span className="agent-run-label">{label}</span></div>
    <div className="agent-run-actions">{children}</div>
  </div>
}

export interface ReferenceAttachmentProps {
  name: string; excerpt: string; kind?: 'text' | 'code' | 'semantic'; locateLabel: string; removeLabel: string
  readOnly?: boolean; onLocate(): void; onRemove(): void
}
export function ReferenceAttachment({ name, excerpt, kind, locateLabel, removeLabel, readOnly, onLocate, onRemove }: ReferenceAttachmentProps) {
  return <div className="agent-reference"><div className="agent-reference-heading">
    <Icon name={kind === 'code' ? 'code-square' : 'clipboard-text'} />
    <button type="button" className="agent-reference-name" aria-label={locateLabel} onClick={onLocate}>{name}</button>
    <button type="button" className="agent-reference-remove" aria-label={removeLabel} disabled={readOnly} onClick={onRemove}><Icon name="close" /></button>
    </div><details><summary>查看引用片段</summary><pre data-kind={kind}>{excerpt}</pre></details></div>
}

export interface AgentQuestionProps {
  prompt: string; options: readonly { id: string; label: string }[]; allowText: boolean
  mode: 'choice' | 'text'; optionId: string; text: string; disabled: boolean; valid: boolean
  pending: boolean; skippable: boolean; onMode(mode: 'choice' | 'text', optionId?: string): void
  onText(text: string): void; onSubmit(skip?: boolean): void
}
/** Controlled presentation only: answer protection, receipts and retries belong to the host. */
export function AgentQuestion({ prompt, options, allowText, mode, optionId, text, disabled, valid, pending, skippable, onMode, onText, onSubmit }: AgentQuestionProps) {
  const id = useId()
  return <div className="agent-question-content"><p className="agent-question-prompt">{prompt}</p><form onSubmit={event => { event.preventDefault(); onSubmit() }}>
    {!!options.length && <fieldset disabled={disabled}><legend>选择你的回答</legend>
      {options.map(option => <label key={option.id} className="agent-question-option" data-selected={mode === 'choice' && optionId === option.id}>
        <input type="radio" name={id} checked={mode === 'choice' && optionId === option.id} onChange={() => onMode('choice', option.id)} /><span>{option.label}</span>
      </label>)}
      {allowText && <label className="agent-question-option" data-selected={mode === 'text'}><input type="radio" name={id} checked={mode === 'text'} onChange={() => onMode('text')} /><span>用自己的话回答</span></label>}
    </fieldset>}
    {allowText && mode === 'text' && <div className="agent-question-text"><label htmlFor={id}>你的回应</label>
      <textarea id={id} disabled={disabled} value={text} maxLength={4000} rows={3} onChange={event => onText(event.target.value)} /></div>}
    <div className="agent-question-actions"><button type="submit" className="primary" disabled={disabled || !valid}>提交回应</button>
      {skippable && <button type="button" className="outline" disabled={disabled} onClick={() => onSubmit(true)}>跳过这次提问</button>}</div>
    {pending && <p role="status" className="agent-question-hint">正在核对原回应，输入已保留。</p>}
  </form></div>
}

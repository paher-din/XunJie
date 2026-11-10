import { useId, type ReactNode } from 'react'
import { Icon } from '../icons'
import './model-choice-card.css'

/** Select a model, then inspect its own settings without leaving the list. */
export function ModelChoiceCard({ modelId, name, selected, expanded, onSelect, onExpand, children, invalid = false,
  showSelection = true, action }: {
  modelId: string; name?: string | undefined; selected: boolean; expanded: boolean
  onSelect?(selected: boolean): void; onExpand(expanded: boolean): void
  children?: ReactNode; invalid?: boolean; showSelection?: boolean; action?: ReactNode
}) {
  const regionId = useId(), title = name || modelId || '自定义模型'
  return <section className={'st-model-choice' + (selected ? ' selected' : '') + (invalid ? ' invalid' : '')}
    aria-label={modelId || title} data-selected={selected || undefined}>
    <div className="st-model-choice-head">
      {showSelection && (onSelect ? <button type="button" className="st-model-choice-select" role="checkbox"
        aria-label={`选择模型 ${modelId}`} aria-checked={selected} onClick={() => onSelect(!selected)}>
        <span className="st-model-choice-check">{selected && <Icon name="check" size={12} />}</span>
      </button> : selected ? <span className="st-model-choice-select st-model-choice-saved" role="img" aria-label="已配置" title="已配置">
        <span className="st-model-choice-check"><Icon name="check" size={12} /></span>
      </span> : null)}
      <button type="button" className="st-model-choice-title" aria-label={`${expanded ? '收起' : '展开'} ${modelId || title} 的配置`}
        aria-expanded={expanded} aria-controls={regionId} onClick={() => {
          if (!selected && onSelect) onSelect(true)
          onExpand(!expanded)
        }}>
        <span className="st-model-choice-name"><span>{title}</span>{modelId && title !== modelId && <small>{modelId}</small>}</span>
        <Icon name="alt-arrow-down" size={16} className={expanded ? 'st-model-choice-arrow expanded' : 'st-model-choice-arrow'} />
      </button>
      {action}
    </div>
    <div id={regionId} className="st-model-choice-body" role="region" aria-label={`${modelId || title}的配置`} hidden={!expanded}>{expanded && children}</div>
  </section>
}

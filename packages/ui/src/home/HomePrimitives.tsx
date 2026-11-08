import { useRef, type ReactNode } from 'react'
import { Icon, IconText } from '../icons'
import { Button } from '../foundation'

export interface TaskToolbarProps<T extends string> {
  filters: readonly T[]
  value: T
  onFilter: (value: T) => void
  query: string
  onQuery: (value: string) => void
}

/** 筛选与搜索的展示；实际任务过滤由页面负责。 */
export function TaskToolbar<T extends string>({ filters, value, onFilter, query, onQuery }: TaskToolbarProps<T>) {
  const searchRef = useRef<HTMLInputElement>(null)
  return <div className="task-toolbar">
    <div className="filters">{filters.map(filter => <button key={filter}
      className={value === filter ? 'filter active' : 'filter'} onClick={() => onFilter(filter)}>{filter}</button>)}</div>
    <label className="search">
      <Icon name="minimalistic-magnifier" size={14} />
      <input ref={searchRef} aria-label="搜索任务" placeholder="搜索任务或课程…" value={query} onChange={event => onQuery(event.target.value)} />
      {query !== '' && <button type="button" className="search-clear" aria-label="清除搜索"
        onClick={() => { onQuery(''); searchRef.current?.focus() }}><Icon name="close" size={12} /></button>}
    </label>
  </div>
}

export interface ContinueTaskCardProps {
  tag: ReactNode
  title: string
  /** undefined 省略段落，空字符串保留空段落。 */
  description?: string
  meta: ReactNode
  metaClassName: 'db-side' | 'pct'
  action: string
  onOpen: () => void
}

/** 继续任务的纯展示；推荐、进度计算与导航由页面负责。 */
export function ContinueTaskCard({ tag, title, description, meta, metaClassName, action, onOpen }: ContinueTaskCardProps) {
  return <div className="db-continue">
    <span className="course-tag"><i className="dot" />{tag}</span>
    <h3>{title}</h3>
    {description !== undefined && <p>{description}</p>}
    <div className="db-continue-foot">
      <span className={metaClassName}>{meta}</span>
      <Button onClick={onOpen}>
        <IconText name="arrow-right" position="end">{action}</IconText>
      </Button>
    </div>
  </div>
}

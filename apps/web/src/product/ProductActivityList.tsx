import { useMemo, useRef, useState } from 'react'
import { ConfirmationDialog } from '@xunjie/ui/foundation'
import { toast } from '@xunjie/ui/feedback'
import type { LearningActivity } from '@xunjie/contracts/learning-data'
import { ActivityCardMenu, HomeSectionHeading, LearningCardGrid, LearningTaskCard, TaskToolbar } from '@xunjie/ui/home'

export function activityTitle(activity: LearningActivity, titles: Record<string, string>) {
  return titles[activity.activityId] || activity.course?.taskTitle || activity.goal || activity.question || '资料学习'
}
export function ProductActivityList({ activities, titles = {}, onOpen, onStart, onStatus, disabled, groupByCourse, onCourse }: {
  activities: LearningActivity[]; titles?: Record<string, string>; onOpen(id: string): void; onStart?(): void
  onStatus?(activity: LearningActivity): Promise<void>; disabled?: boolean; groupByCourse?: boolean; onCourse?(id: string): void
}) {
  const section = useRef<HTMLElement>(null)
  const [closing, setClosing] = useState<LearningActivity | null>(null)
  const [pending, setPending] = useState(false)
  const [statusError, setStatusError] = useState('')
  async function updateStatus(activity: LearningActivity) {
    if (!onStatus || pending || disabled) return
    setPending(true); setStatusError('')
    try { await onStatus(activity); setClosing(null); toast.success(activity.status === 'closed' ? '活动已重新开始。' : '活动已关闭，作品与记录保留。') }
    catch (error) { const message = error instanceof Error && error.name !== 'ZodError' ? error.message : '活动状态响应不完整，请刷新列表核对后重试。'; setStatusError(message); if (!closing) toast.error(message) }
    finally { setPending(false) }
  }
  const [filter, setFilter] = useState('全部')
  const [query, setQuery] = useState('')
  const filtered = useMemo(() => activities.filter(activity => {
    if (filter !== '全部' && activity.status !== (filter === '进行中' ? 'open' : 'closed')) return false
    return [activityTitle(activity, titles), activity.goal, activity.question, activity.course?.courseName ?? ''].join(' ').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.activityId.localeCompare(b.activityId)), [activities, filter, query, titles])
  const groups = [...filtered.reduce((groups, activity) => {
    const id = groupByCourse ? activity.course?.courseId ?? 'unlinked' : 'all'
    if (!groups.has(id)) groups.set(id, { id, title: activity.course?.courseName ?? '未关联课程的活动', activities: [] as LearningActivity[] })
    groups.get(id)!.activities.push(activity)
    return groups
  }, new Map<string, { id: string; title: string; activities: LearningActivity[] }>()).values()]
  return <section ref={section} className="product-activity-list" aria-label="学习活动">
    <HomeSectionHeading title="学习活动" count={`${filtered.length} / ${activities.length} 个活动`} />
    <TaskToolbar filters={['全部', '进行中', '已关闭']} value={filter} onFilter={setFilter} query={query} onQuery={setQuery} />
    {!filtered.length ? <div className="empty">
      <p>{activities.length ? '没有符合条件的学习活动。' : '还没有学习活动。'}</p>
      {(query || filter !== '全部') && <button type="button" className="outline" onClick={() => { setFilter('全部'); setQuery('') }}>清除筛选</button>}
      {!activities.length && onStart && <button type="button" className="outline" onClick={onStart}>开始对话</button>}
    </div> : groups.map(group => <div key={group.id} className="product-activity-course-group" data-course-group={groupByCourse ? group.id : undefined}>
      {groupByCourse && <div className="product-activity-course-heading"><h3>{group.title}<span>{group.activities.length} 个活动</span></h3>
        {group.id !== 'unlinked' && onCourse && <button type="button" className="outline" onClick={() => onCourse(group.id)}>查看课程</button>}</div>}
      <LearningCardGrid>{register => group.activities.map((activity, index) => {
      const title = activityTitle(activity, titles)
      const goal = [activity.course?.objectives[0], activity.goal, activity.question].find(value => value && value !== title)
      return <LearningTaskCard key={activity.activityId} activityId={activity.activityId} title={title} goal={goal}
        badge={<span className={'status ' + (activity.status === 'closed' ? 'product-status-closed' : '')}>{activity.status === 'closed' ? '已关闭' : '进行中'}</span>}
        menu={onStatus && <ActivityCardMenu title={title} closed={activity.status === 'closed'} disabled={disabled || pending}
          onOpen={() => onOpen(activity.activityId)} onChangeStatus={() => { if (activity.status === 'closed') void updateStatus(activity); else { setStatusError(''); setClosing(activity) } }} />}
        footer={activity.course?.courseName ?? (activity.identity?.kind === 'school' ? '未关联课程' : '自主学习')} action={activity.status === 'closed' ? '查看活动' : '继续学习'}
        register={register} index={index} onOpen={() => onOpen(activity.activityId)} />
    })}</LearningCardGrid></div>)}
    <ConfirmationDialog open={!!closing} title="关闭活动" confirmLabel="关闭活动" busy={pending} error={statusError}
      description={<>关闭「{closing && activityTitle(closing, titles)}」后，会停止该活动的运行。已有作品和学习记录保留，可随时重新开始。</>}
      onClose={() => { setClosing(null); setStatusError('') }} onConfirm={() => { if (closing) void updateStatus(closing) }}
      onReturnFocus={() => section.current?.querySelector<HTMLInputElement>('.search input')?.focus()} />
  </section>
}

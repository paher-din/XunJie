import { useEffect, useState } from 'react'
import { SelectField } from '@xunjie/ui/foundation'
import type { LearningActivity } from '@xunjie/contracts/learning-data'
import type { Course } from '@xunjie/contracts/courses'
import { DASHBOARD_WIDGETS, DashboardSection, defaultDashboardLayout, type DashboardLayout } from '@xunjie/ui/dashboard'
import { ContinueTaskCard, CourseTiles, HomeCourseRegion, HomeIntro, HomeSectionHeading, HomeStatus, LearningCardGrid, LearningTaskCard } from '@xunjie/ui/home'
import './product-home.css'

export interface ProductHomeProps {
  identityName: string
  activities: LearningActivity[] | null
  courses: Course[] | null
  spaceKind: 'personal' | 'school'
  availableSpaces: { key: string; label: string; kind: 'personal' | 'school' }[]
  spaceKey: string
  dashboardKey: string
  onSpaceChange: (key: string) => void
  busy: boolean
  onOpenActivity: (id: string) => void
  onOpenCourse: (id: string) => void
  onStartConversation: () => void
  onRefresh: () => void
  /** A failed read; null data without an error is still loading. */
  error?: string | null
  onConnectSchool?: () => void
}

function activityTitle(activity: LearningActivity) {
  return activity.course?.taskTitle || activity.goal || activity.question || '资料学习'
}

function readLayout(key: string): DashboardLayout {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? 'null') as DashboardLayout | null
    const all = saved && Array.isArray(saved.board) && Array.isArray(saved.tray) ? [...saved.board, ...saved.tray] : []
    if (all.length === Object.keys(DASHBOARD_WIDGETS).length && new Set(all).size === all.length
      && all.every(id => typeof id === 'string' && Object.hasOwn(DASHBOARD_WIDGETS, id))) return saved!
  } catch { /* Fall back without replacing the stored value. */ }
  return defaultDashboardLayout()
}

export function ProductHome({ identityName, activities, courses, spaceKind, availableSpaces, spaceKey, dashboardKey, onSpaceChange,
  busy, onOpenActivity, onOpenCourse, onStartConversation, onRefresh, error, onConnectSchool }: ProductHomeProps) {
  const [category, setCategory] = useState(spaceKind)
  const [layout, setLayout] = useState(() => readLayout(dashboardKey))
  useEffect(() => setCategory(spaceKind), [spaceKind, spaceKey])
  useEffect(() => setLayout(readLayout(dashboardKey)), [dashboardKey])
  const changeLayout = (next: DashboardLayout) => {
    setLayout(next)
    try { localStorage.setItem(dashboardKey, JSON.stringify(next)) } catch { /* Keep this view usable when storage is unavailable. */ }
  }
  const now = new Date()
  const hour = now.getHours()
  const greeting = hour < 12 ? '上午好' : hour < 18 ? '下午好' : '晚上好'
  const currentActivities = activities?.filter(activity => activity.identity.kind === spaceKind) ?? null
  const personalActivities = spaceKind === 'personal' ? currentActivities?.filter(activity => !activity.course) ?? null : null
  const recent = currentActivities?.filter(activity => activity.status === 'open')
    .slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  const isCurrent = category === spaceKind
  const categorySpaces = availableSpaces.filter(space => space.kind === category)
  const selectedSpace = categorySpaces.find(space => space.key === spaceKey)
  const selectCategory = (kind: 'personal' | 'school') => {
    setCategory(kind)
    const target = availableSpaces.find(space => space.kind === kind && space.key === spaceKey)
      ?? availableSpaces.find(space => space.kind === kind)
    if (target && target.key !== spaceKey) onSpaceChange(target.key)
  }

  return <div className="content home-page product-home">
    <HomeIntro title={<>{greeting}，{identityName}</>} date={<>{now.getMonth() + 1} 月 {now.getDate()} 日</>} />
    <DashboardSection data={{}} tasks={null} now={now} layout={layout} onLayoutChange={changeLayout}
      periodLabel="学习概览" editHint="添加或移出看板组件；暂无统计的数据会显示空态。"
      continueSlot={recent ? <ContinueTaskCard tag="继续学习" title={activityTitle(recent)}
        description={recent.goal && recent.goal !== activityTitle(recent) ? recent.goal : undefined}
        meta="最近创建的进行中活动" metaClassName="db-side" action="继续学习"
        onOpen={() => onOpenActivity(recent.activityId)} /> : <div className="product-home-continue-empty">
          <p>{activities === null ? '学习活动尚未加载' : '从一个问题开始学习'}</p>
          <button type="button" className="outline" disabled={busy} onClick={onStartConversation}>开始对话</button>
        </div>} />
    <HomeCourseRegion selected={false}>
      <HomeSectionHeading title="我的课程" count={isCurrent && !error ? category === 'school' && courses ? `${courses.length} 门` : category === 'personal' && personalActivities ? `${personalActivities.length} 个活动` : '' : ''}
        refresh={{ disabled: busy, onRefresh }} />
      <div className="product-home-categories" role="group" aria-label="课程分类">
        <button type="button" className={category === 'school' ? 'active' : ''} aria-pressed={category === 'school'} onClick={() => selectCategory('school')}>学校</button>
        <button type="button" className={category === 'personal' ? 'active' : ''} aria-pressed={category === 'personal'} onClick={() => selectCategory('personal')}>个人</button>
      </div>
      {category === 'school' && categorySpaces.length > 1 && <label className="product-home-space-select">学校
        <SelectField label="选择学校" value={selectedSpace?.key ?? ''} disabled={busy}
          onChange={onSpaceChange} options={[
            ...(!selectedSpace ? [{ value: '', label: '选择学校', disabled: true }] : []),
            ...categorySpaces.map(space => ({ value: space.key, label: space.label })),
          ]} />
      </label>}
      {categorySpaces.length === 0 ? <div className="empty product-home-empty">{category === 'school' ? '暂无学校身份，连接学校后可在这里查看课程。' : '暂无个人空间。'}
        {category === 'school' && onConnectSchool && <button type="button" className="outline" disabled={busy} onClick={onConnectSchool}>连接学校</button>}</div>
        : error ? <HomeStatus kind="error" message={error} retry={{ disabled: busy, onRetry: onRefresh }} />
        : !isCurrent ? <HomeStatus kind="loading" message="正在切换学习空间…" />
        : category === 'school' ? courses === null ? <HomeStatus kind="loading" message="正在读取学校课程…" />
          : courses.length === 0 ? <HomeStatus kind="empty" message="暂无学校课程。" />
            : <CourseTiles courses={courses.map(course => course.courseId)} toneOf={id => courses.findIndex(course => course.courseId === id)}
              titleOf={id => courses.find(course => course.courseId === id)!.name}
              summaryOf={id => `${courses.find(course => course.courseId === id)!.tasks.length} 个任务`}
              onOpen={id => onOpenCourse(id)} />
          : personalActivities === null ? <HomeStatus kind="loading" message="正在读取学习活动…" />
            : personalActivities.length === 0 ? <div className="empty product-home-empty">暂无自主学习活动。<button type="button" className="outline" disabled={busy} onClick={onStartConversation}>开始对话</button></div>
              : <CourseTiles courses={personalActivities.map(activity => activity.activityId)} idKind="activity"
                toneOf={id => personalActivities.findIndex(activity => activity.activityId === id)}
                titleOf={id => activityTitle(personalActivities.find(activity => activity.activityId === id)!)}
                summaryOf={id => personalActivities.find(activity => activity.activityId === id)!.status === 'closed' ? '已关闭' : '进行中'}
                actionOf={id => personalActivities.find(activity => activity.activityId === id)!.status === 'closed' ? '查看活动' : '继续学习'}
                onOpen={id => onOpenActivity(id)} />}
    </HomeCourseRegion>
    {category === 'school' && isCurrent && currentActivities && currentActivities.length > 0 && <section aria-labelledby="school-activities-title">
      <HomeSectionHeading title="我的学习活动" count={`${currentActivities.length} 个`} />
      <LearningCardGrid>{register => currentActivities.map((activity, index) => <LearningTaskCard
        key={activity.activityId} activityId={activity.activityId} title={activityTitle(activity)}
        goal={activity.course?.objectives[0] || activity.question || undefined}
        badge={<span className={'status' + (activity.status === 'closed' ? ' pending' : '')}>{activity.status === 'closed' ? '已关闭' : '进行中'}</span>}
        footer={activity.course?.courseName ?? '自主学习'} action={activity.status === 'closed' ? '查看活动' : '继续学习'}
        register={register} index={index} onOpen={() => onOpenActivity(activity.activityId)} />)}</LearningCardGrid>
    </section>}
  </div>
}

export default ProductHome

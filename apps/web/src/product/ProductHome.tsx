import { useEffect, useMemo, useState } from 'react'
import type { LearningActivity } from '@xunjie/contracts/learning-data'
import type { Course } from '@xunjie/contracts/courses'
import { DASHBOARD_WIDGETS, DashboardSection, defaultDashboardLayout, type DashboardLayout } from '@xunjie/ui/dashboard'
import { ContinueTaskCard, CourseTiles, HomeCourseRegion, HomeIntro, HomeSectionHeading, HomeStatus, LearningCardGrid, LearningTaskCard } from '@xunjie/ui/home'
import './product-home.css'

export interface ProductHomeProps {
  accountName: string
  personalActivities: LearningActivity[] | null
  schoolActivities: LearningActivity[] | null
  personalKey?: string
  schoolKey?: string
  initialCategory?: 'personal' | 'school'
  courses: Course[] | null
  dashboardKey: string
  busy: boolean
  onOpenActivity: (id: string, sourceKey: string) => void
  onOpenCourse: (id: string) => void
  onStartConversation: () => void
  onRefresh: () => void
  /** A failed read; null data without an error is still loading. */
  personalError?: string | null
  schoolError?: string | null
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

export function ProductHome({ accountName, personalActivities: personalData, schoolActivities: schoolData, courses,
  personalKey, schoolKey, initialCategory = schoolKey ? 'school' : 'personal', dashboardKey,
  busy, onOpenActivity, onOpenCourse, onStartConversation, onRefresh, personalError, schoolError, onConnectSchool }: ProductHomeProps) {
  const [category, setCategory] = useState(initialCategory)
  const [layout, setLayout] = useState(() => readLayout(dashboardKey))
  useEffect(() => setLayout(readLayout(dashboardKey)), [dashboardKey])
  const changeLayout = (next: DashboardLayout) => {
    setLayout(next)
    try { localStorage.setItem(dashboardKey, JSON.stringify(next)) } catch { /* Keep this view usable when storage is unavailable. */ }
  }
  const now = new Date()
  const hour = now.getHours()
  const greeting = hour < 12 ? '上午好' : hour < 18 ? '下午好' : '晚上好'
  const personalActivities = useMemo(() => personalData?.filter(activity => activity.identity.kind === 'personal' && !activity.course) ?? null, [personalData])
  const schoolActivities = useMemo(() => schoolKey ? schoolData?.filter(activity => activity.identity.kind === 'school') ?? null : [], [schoolData, schoolKey])
  const coursesById = useMemo(() => new Map(courses?.map((course, index) => [course.courseId, { course, index }])), [courses])
  const activitiesById = useMemo(() => new Map(personalActivities?.map((activity, index) => [activity.activityId, { activity, index }])), [personalActivities])
  const currentActivities = category === 'school' ? schoolActivities : personalActivities
  const recent = currentActivities?.reduce<LearningActivity | undefined>((previous, activity) =>
    activity.status === 'open' && (!previous || activity.createdAt > previous.createdAt) ? activity : previous, undefined)
  const sourceKey = category === 'school' ? schoolKey : personalKey
  const error = category === 'school' ? schoolError : personalError

  return <div className="content home-page product-home">
    <HomeIntro title={<>{greeting}，{accountName}</>} date={<>{now.getMonth() + 1} 月 {now.getDate()} 日</>} />
    <DashboardSection data={{}} tasks={null} now={now} layout={layout} onLayoutChange={changeLayout}
      periodLabel="学习概览" editHint="添加或移出看板组件；暂无统计的数据会显示空态。"
      continueSlot={recent ? <ContinueTaskCard tag="继续学习" title={activityTitle(recent)}
        description={recent.goal && recent.goal !== activityTitle(recent) ? recent.goal : undefined}
        meta="最近创建的进行中活动" metaClassName="db-side" action="继续学习"
        onOpen={() => onOpenActivity(recent.activityId, sourceKey!)} /> : <div className="product-home-continue-empty">
          <p>{currentActivities === null ? '学习活动尚未加载' : '从一个问题开始学习'}</p>
          <button type="button" className="outline" disabled={busy} onClick={onStartConversation}>开始对话</button>
        </div>} />
    <HomeCourseRegion selected={false}>
      <HomeSectionHeading title="我的课程" count={!error ? category === 'school' && courses ? `${courses.length} 门` : category === 'personal' && personalActivities ? `${personalActivities.length} 个活动` : '' : ''}
        refresh={{ disabled: busy, onRefresh }} />
      <div className="product-home-categories" role="group" aria-label="课程分类">
        <button type="button" className={category === 'school' ? 'active' : ''} aria-pressed={category === 'school'} onClick={() => setCategory('school')}>学校</button>
        <button type="button" className={category === 'personal' ? 'active' : ''} aria-pressed={category === 'personal'} onClick={() => setCategory('personal')}>个人</button>
      </div>
      {!sourceKey ? <div className="empty product-home-empty">{category === 'school' ? '尚未绑定学校，绑定后可在这里查看课程。' : '请在本机客户端开始个人学习。'}
        {category === 'school' && onConnectSchool && <button type="button" className="outline" disabled={busy} onClick={onConnectSchool}>连接学校</button>}</div>
        : error ? <HomeStatus kind="error" message={error} retry={{ disabled: busy, onRetry: onRefresh }} />
        : category === 'school' ? courses === null ? <HomeStatus kind="loading" message="学校课程" />
          : courses.length === 0 ? <HomeStatus kind="empty" message="暂无学校课程。" />
            : <CourseTiles courses={courses.map(course => course.courseId)} toneOf={id => coursesById.get(id)!.index}
              titleOf={id => coursesById.get(id)!.course.name}
              summaryOf={id => `${coursesById.get(id)!.course.tasks.length} 个任务`}
              onOpen={id => onOpenCourse(id)} />
          : personalActivities === null ? <HomeStatus kind="loading" message="学习活动" />
            : personalActivities.length === 0 ? <div className="empty product-home-empty">暂无自主学习活动。<button type="button" className="outline" disabled={busy} onClick={onStartConversation}>开始对话</button></div>
              : <CourseTiles courses={personalActivities.map(activity => activity.activityId)} idKind="activity"
                toneOf={id => activitiesById.get(id)!.index}
                titleOf={id => activityTitle(activitiesById.get(id)!.activity)}
                summaryOf={id => activitiesById.get(id)!.activity.status === 'closed' ? '已关闭' : '进行中'}
                actionOf={id => activitiesById.get(id)!.activity.status === 'closed' ? '查看活动' : '继续学习'}
                onOpen={id => onOpenActivity(id, personalKey!)} />}
    </HomeCourseRegion>
    {category === 'school' && !error && currentActivities && currentActivities.length > 0 && <section aria-labelledby="school-activities-title">
      <HomeSectionHeading title="我的学习活动" count={`${currentActivities.length} 个`} />
      <LearningCardGrid>{register => currentActivities.map((activity, index) => <LearningTaskCard
        key={activity.activityId} activityId={activity.activityId} title={activityTitle(activity)}
        goal={activity.course?.objectives[0] || activity.question || undefined}
        badge={<span className={'status' + (activity.status === 'closed' ? ' pending' : '')}>{activity.status === 'closed' ? '已关闭' : '进行中'}</span>}
        footer={activity.course?.courseName ?? '自主学习'} action={activity.status === 'closed' ? '查看活动' : '继续学习'}
        register={register} index={index} onOpen={() => onOpenActivity(activity.activityId, schoolKey!)} />)}</LearningCardGrid>
    </section>}
  </div>
}

export default ProductHome

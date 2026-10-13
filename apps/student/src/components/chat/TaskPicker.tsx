import { useEffect } from 'react'
import { Icon } from '../../icons'
import type { ProjectTask } from '../../bridge/types'

/**
 * 任务选择器（已确认 2026-10-11，第 19 条）：生成卡无归属时，收纳先弹选择器由学生指派。
 * 按课程分组，未完成任务在前；收纳意图即归属答案（也是 Agent 归属错误的修改路径）。
 */
export function TaskPicker({
  tasks,
  onPick,
  onCancel,
}: {
  tasks: ProjectTask[]
  onPick: (taskId: string) => void
  onCancel: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel])

  // 分组：按课程；组内未完成任务在前（未开始 / 进行中优先于已完成）
  const byCourse = new Map<string, ProjectTask[]>()
  for (const t of tasks) {
    const list = byCourse.get(t.course) ?? []
    list.push(t)
    byCourse.set(t.course, list)
  }
  const groups = [...byCourse.entries()].map(([course, list]) => [
    course,
    [...list].sort((a, b) => Number(a.status === '已完成') - Number(b.status === '已完成')),
  ]) as Array<[string, ProjectTask[]]>

  return (
    <div className="genpick-veil" onClick={onCancel}>
      <div className="genpick" role="dialog" aria-label="选择收纳到的任务" onClick={(e) => e.stopPropagation()}>
        <div className="genpick-h">
          <strong>收纳到哪个任务？</strong>
          <span>这张卡还没有对应任务</span>
          <button className="genpick-x" aria-label="取消" onClick={onCancel}>
            <Icon name="close" size={15} />
          </button>
        </div>
        <div className="genpick-list">
          {groups.map(([course, list]) => (
            <div key={course} className="genpick-group">
              <div className="genpick-course">{course}</div>
              {list.map((t) => (
                <button key={t.id} className="genpick-task" onClick={() => onPick(t.id)}>
                  <span className="genpick-task-name">{t.name}</span>
                  <span className="genpick-task-meta">
                    {t.status}
                    {t.deadlineAt ? ` · 截止 ${t.deadlineAt.slice(0, 10)}` : ''}
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
        <div className="genpick-foot">收纳意图即归属答案；生成时 Agent 猜错了归属，在这里改。</div>
      </div>
    </div>
  )
}

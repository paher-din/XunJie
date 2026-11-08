/** 学生任务的展示状态，不读取任何业务 store。 */
export type TaskDisplayStatus = '进行中' | '未开始' | '已完成' | '已分配' | '任务已暂停'

const CLASS_BY_STATUS: Record<TaskDisplayStatus, string> = {
  进行中: 'status',
  未开始: 'status pending',
  已完成: 'status done',
  已分配: 'status pending',
  任务已暂停: 'status pending',
}

export function StatusChip({ status }: { status: TaskDisplayStatus }) {
  return <span className={CLASS_BY_STATUS[status]}>{status}</span>
}

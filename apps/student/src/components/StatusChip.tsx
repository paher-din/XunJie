import type { TaskStatus } from '../bridge/types'

const CLASS_BY_STATUS: Record<TaskStatus, string> = {
  进行中: 'status',
  未开始: 'status pending',
  已完成: 'status done',
}

export function StatusChip({ status }: { status: TaskStatus }) {
  return <span className={CLASS_BY_STATUS[status]}>{status}</span>
}

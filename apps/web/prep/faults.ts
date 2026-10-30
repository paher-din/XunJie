/**
 * 准备模式的开发故障入口（I0_UI_04）。
 *
 * 依据 docs/tasks/I0_UI_CLIENT_CONTRACT.md §2：「故障入口仅在 loopback 开发/测试进程启用，用于
 * 延迟、丢 ACK、失败和恢复脚本」。这里只实现断线恢复要用的一种故障：
 *
 * - `drop-ack`：写命令（创建 Attempt / sync / snapshot）照常提交到进程内 authority，
 *   但**不下发响应**并断开连接。客户端因此只能看到「没有拿到服务端信封」，用于复现
 *   「服务已提交、ACK 丢失」，而不是让 fixture 假装请求失败。
 * - `fail-write`：写命令**不提交**，直接返回 503 `PERSISTENCE_UNAVAILABLE`。这是服务端真实
 *   存在的一类「暂时不可用」，用于确认客户端不会把它当成永久拒绝、也不会当成成功。
 *
 * 故障按合成场景隔离（测试各自用独立 scenario），进程重启即清空；不进入生产构建，
 * 因为它只由 prep 模式的 middleware 引用。
 */

export type PrepFault = 'none' | 'drop-ack' | 'fail-write'

const faults = new Map<string, PrepFault>()

export function prepFaultOf(scenario: string): PrepFault {
  return faults.get(scenario) ?? 'none'
}

/** 设置一个场景的故障；返回生效值。 */
export function setPrepFault(scenario: string, fault: PrepFault): PrepFault {
  if (fault === 'none') faults.delete(scenario)
  else faults.set(scenario, fault)
  return prepFaultOf(scenario)
}

export function isPrepFault(value: unknown): value is PrepFault {
  return value === 'none' || value === 'drop-ack' || value === 'fail-write'
}

/** harness 与被测进程的固定地址；端口由 package.json 的 dev 脚本以 strictPort 锁定。 */
export const PREP_PORT = process.env.XUNJIE_E2E_PREP_PORT ?? '5601'
export const REAL_PORT = process.env.XUNJIE_E2E_REAL_PORT ?? '5602'
for (const port of [PREP_PORT, REAL_PORT]) {
  if (!/^\d+$/.test(port) || Number(port) < 1024 || Number(port) > 65535) throw new Error('E2E port must be 1024..65535')
}
export const PREP_URL = `http://127.0.0.1:${PREP_PORT}`
export const REAL_URL = `http://127.0.0.1:${REAL_PORT}`

/** I0-A 准备场景在现有任务入口路由上的地址（hash 路由）。 */
export const PREP_TASK_PATH = '/#/task/i0-prep-textscope-c'

/** 原数字逻辑演示任务（导入来源自带的 counter）。 */
export const COUNTER_TASK_PATH = '/#/task/counter'

/** 只允许打到本机开发进程；任何其它主机都算外发。 */
export function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]'
  } catch {
    return false
  }
}

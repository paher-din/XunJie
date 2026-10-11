/**
 * I0-A 工作区模式与传输端点选择。
 *
 * 依据 docs/tasks/I0_UI_CLIENT_CONTRACT.md §2：模式在启动命令上显式固定，运行期不切换、
 * 真实请求失败不回退到 fixture。`npm run dev:prep` → preparation；`npm run dev` 与
 * `npm run build` → real。所有 `import.meta.env.DEV` 守卫都会被生产构建静态消除，
 * 因此正式产物里不残留准备端点字符串（由 e2e 与构建后检查核对）。
 */

export type WorkspaceMode = 'preparation' | 'real'

/**
 * 构建期常量：只有开发进程且 Vite 以 `--mode prep` 启动时为 true。
 * 生产构建里静态折叠为 false，据此消除准备入口、准备端点与合成场景字符串。
 */
export const PREP_BUILD: boolean = import.meta.env.DEV && import.meta.env.MODE === 'prep'

export const workspaceMode: WorkspaceMode = PREP_BUILD ? 'preparation' : 'real'

export function isPreparation(mode: WorkspaceMode = workspaceMode): boolean {
  return mode === 'preparation'
}

/** 窄 HTTP 客户端的 base URL：准备走开发专用 fixture，真实走同源 `/api`。 */
export function apiBase(mode: WorkspaceMode): string {
  if (import.meta.env.DEV && mode === 'preparation') return '/__i0prep/api'
  return '/api'
}

/**
 * 准备 bootstrap 元信息端点（场景/epoch、合成受信代际、获准合成对象引用）。
 * 真实模式没有这个入口：分配发现与正常业务宿主属交接项 H-01/H-02，未交付前保持不可用，
 * 不用准备常量顶替，也不猜 ID。
 */
export function prepContextUrl(mode: WorkspaceMode): string | null {
  return import.meta.env.DEV && mode === 'preparation' ? '/__i0prep/context' : null
}

/** 界面上统一使用的模式标识文案。 */
export function modeLabel(mode: WorkspaceMode): string {
  return mode === 'preparation' ? '准备场景（合成）' : '真实模式'
}

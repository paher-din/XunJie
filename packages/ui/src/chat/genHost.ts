/** 生成卡的运行适配边界；包不读取宿主状态，也不实现网络或沙箱协议。 */
export interface GenHost {
  mount: (container: HTMLElement, source: string, snapshot?: unknown) => void
  unmount: () => void
  snapshot: () => Promise<unknown>
  reload: (source: string, snapshot?: unknown) => void
  loadVersion: (source: string, snapshot?: unknown) => void
}
export interface GenHostOptions {
  label: string
  callbacks: {
    onReady: (height?: number) => void
    onState: (state: unknown, height?: number) => void
    onRuntimeError: (info?: { message?: string }) => void
    onDead: () => void
  }
}
export type GenHostFactory = (options: GenHostOptions) => GenHost

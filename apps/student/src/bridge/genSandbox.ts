/**
 * 生成交互卡的宿主侧沙箱协议层（docs/prototypes/gen-cards/sandbox.js 的正式版移植）。
 *
 * ── 为什么是真实边界 ────────────────────────────────────────
 * 卡片内容跑在 iframe srcdoc 里，与宿主之间只经 postMessage 通信，不用 div 假扮：
 * 宿主能随时杀掉/重建沙箱（冻结 = 移除 iframe，只剩快照；恢复 = 重建 iframe 并用快照续跑），
 * 这就是「真实边界」的最小证据。
 *
 * ── 消息协议（5 类，frontend-architecture.md §7） ──────────
 * 信封：{ gen: 1, type, instance, payload }
 *   宿主 → 沙箱  init               { theme, label, snapshot? }   配置 + 恢复用快照（取出钉住时带上）
 *   沙箱 → 宿主  ready             { height }                    init 的应答；宿主按 height 自适应（上限 480 内滚）
 *   沙箱 → 宿主  input             { state, height }             交互变化即发；宿主把 state 当作「当前状态」持久化
 *   宿主 → 沙箱  snapshot-request  { req }
 *   沙箱 → 宿主  snapshot          { req, state, height }        冻结/入收纳前取全量状态
 *   沙箱 → 宿主  error             { message }                   沙箱内未捕获异常
 *
 * ── 宿主的校验与看门狗 ──────────────────────────────────────
 *  · 来源窗口：event.source 必须 === iframe.contentWindow
 *  · 结构与版本：gen === 1、type 在白名单、instance 匹配
 *  · payload 形状：height 为正数、state 可 JSON 化
 *  · 就绪看门狗：发出 init 后 3000ms 未收到 ready → 判死（协议超时），进入 dead 态
 *
 * ── 生产版差异（mock 简化掉的） ──────────────────────────────
 *  · targetOrigin 用 '*'：srcdoc 页是 about:srcdoc 无真实 origin；生产版分配专用源 / 一次性 token 后按白名单投递
 *  · 快照存 localStorage；生产版落盘（保存源内容 / 配置 / 版本 / 可恢复状态）
 *
 * 本类不依赖 React：组件在容器元素上 mount / unmount，冻结 = unmount（iframe 移除）。
 */

export const GEN_PROTOCOL_VERSION = 1

/** 就绪看门狗：发出 init 后 3 秒未收到 ready 判死（协议超时）。 */
export const GEN_READY_TIMEOUT_MS = 3000
/** snapshot-request 的应答超时：沙箱不响应时回退到宿主内存态。 */
export const GEN_SNAPSHOT_TIMEOUT_MS = 1500
/** 壳高上限：超出由沙箱 body 内滚。 */
export const GEN_HEIGHT_CAP = 480

const MESSAGE_TYPES = ['init', 'ready', 'input', 'snapshot-request', 'snapshot', 'error'] as const
type MessageType = (typeof MESSAGE_TYPES)[number]

export type GenSandboxStatus = 'loading' | 'live' | 'dead'

export interface GenSandboxCallbacks {
  /** ready 收到：沙箱就绪，高度已自适应。 */
  onReady?: (height: number) => void
  /** input 收到：交互状态变化（宿主内存态同步 + 持久化出口）。 */
  onState?: (state: unknown, height?: number) => void
  /** error 收到：沙箱内未捕获异常（运行失败；回滚由页面负责）。 */
  onRuntimeError?: (info: { message?: string }) => void
  /** 看门狗超时：3 秒不就绪判死（协议超时）。 */
  onDead?: () => void
}

let seq = 0

/** 主题强调色：跟随宿主当前主题（srcdoc 页内联 --accent）。 */
function currentAccent(): string {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
    return v || '#007aff'
  } catch {
    return '#007aff'
  }
}

interface Envelope {
  gen: number
  type: MessageType
  instance: string
  payload?: Record<string, unknown>
}

function isEnvelope(m: unknown): m is Envelope {
  if (!m || typeof m !== 'object') return false
  const e = m as Record<string, unknown>
  return (
    e.gen === GEN_PROTOCOL_VERSION &&
    typeof e.instance === 'string' &&
    typeof e.type === 'string' &&
    (MESSAGE_TYPES as readonly string[]).includes(e.type)
  )
}

/**
 * 一张生成交互卡的沙箱宿主：
 * mount 建 iframe 并发 init；unmount 移除 iframe（冻结）；
 * snapshot / collect 走 snapshot-request 配对；loadVersion 换版本用快照续跑。
 */
export class GenSandboxHost {
  readonly instance: string
  private status: GenSandboxStatus = 'loading'
  private state: unknown = null
  private iframe: HTMLIFrameElement | null = null
  private container: HTMLElement | null = null
  private watch = 0
  private reqSeq = 0
  private readonly pending = new Map<number, (state: unknown) => void>()
  private readonly heightCap: number
  private readonly label: string
  private readonly callbacks: GenSandboxCallbacks

  constructor(opts: { label: string; heightCap?: number; callbacks?: GenSandboxCallbacks }) {
    this.instance = `gen-${++seq}`
    this.label = opts.label
    this.heightCap = opts.heightCap ?? GEN_HEIGHT_CAP
    this.callbacks = opts.callbacks ?? {}
    this.onMessage = this.onMessage.bind(this)
  }

  get currentStatus(): GenSandboxStatus {
    return this.status
  }

  /** 宿主持有的「当前状态」（input 消息持续更新）。 */
  get currentState(): unknown {
    return this.state
  }

  /** 建 iframe → 挂容器 → load 后发 init + 看门狗。先挂 DOM 再赋 srcdoc：量高时一定有布局视口。 */
  mount(container: HTMLElement, srcdoc: string, snapshot?: unknown | null): void {
    this.container = container
    this.state = snapshot ?? null
    window.addEventListener('message', this.onMessage)
    this.load(srcdoc, snapshot ?? null)
  }

  /** 移除 iframe 与监听（冻结 = iframe 不存在了，只剩状态）。 */
  unmount(): void {
    this.clearWatch()
    if (this.iframe) {
      this.iframe.remove()
      this.iframe = null
    }
    this.pending.clear()
    this.container = null
    window.removeEventListener('message', this.onMessage)
  }

  /** 重新装载（重试）：换新文档，用最近状态续跑。 */
  reload(srcdoc: string, snapshot?: unknown | null): void {
    this.load(srcdoc, snapshot ?? this.state)
  }

  /** 运行失败回滚：换上个可用版本的文档，用给定（或最近）快照续跑。 */
  loadVersion(srcdoc: string, snapshot?: unknown): void {
    this.load(srcdoc, snapshot ?? this.state)
  }

  /** 全量快照：snapshot-request 配对；沙箱已死 / 不响应时回退到宿主内存态。 */
  snapshot(): Promise<unknown> {
    const win = this.iframe?.contentWindow
    if (!win || this.status === 'dead' || this.status === 'loading') {
      return Promise.resolve(this.state)
    }
    return new Promise((resolve) => {
      const req = ++this.reqSeq
      this.pending.set(req, resolve)
      this.post(win, 'snapshot-request', { req })
      window.setTimeout(() => {
        if (this.pending.has(req)) {
          this.pending.delete(req)
          resolve(this.state)
        }
      }, GEN_SNAPSHOT_TIMEOUT_MS)
    })
  }

  /** 收纳 = 先取快照，再冻结（iframe 移除）。 */
  async collect(): Promise<unknown> {
    this.state = await this.snapshot()
    this.unmount()
    return this.state
  }

  private load(srcdoc: string, snapshot: unknown | null): void {
    if (!this.container) return
    this.clearWatch()
    if (this.iframe) {
      this.iframe.remove()
      this.iframe = null
    }
    this.pending.clear()
    this.status = 'loading'
    const f = document.createElement('iframe')
    f.className = 'gen-frame'
    f.setAttribute('sandbox', 'allow-scripts') // 隔离：无同源、无弹窗、无顶层跳转
    f.style.height = `${Math.min(this.heightCap, 120)}px`
    /* load 监听先挂，再赋 srcdoc */
    f.addEventListener('load', () => {
      /* init：配置 + 恢复快照（取出钉住时 snapshot 非空 = 从快照续跑） */
      this.post(f.contentWindow!, 'init', {
        theme: { accent: currentAccent() },
        label: this.label,
        snapshot: snapshot ?? null,
      })
      /* 看门狗：3 秒无 ready → 判死（协议超时） */
      this.clearWatch()
      this.watch = window.setTimeout(() => {
        if (this.status !== 'loading') return
        this.status = 'dead'
        this.callbacks.onDead?.()
      }, GEN_READY_TIMEOUT_MS)
    })
    this.iframe = f
    this.container.appendChild(f)
    f.srcdoc = srcdoc
  }

  private post(win: Window, type: MessageType, payload: Record<string, unknown>): void {
    win.postMessage({ gen: GEN_PROTOCOL_VERSION, type, instance: this.instance, payload }, '*')
  }

  private clearWatch(): void {
    if (this.watch) {
      window.clearTimeout(this.watch)
      this.watch = 0
    }
  }

  private setFrameHeight(h: number): void {
    if (!this.iframe) return
    this.iframe.style.height = `${Math.min(h, this.heightCap)}px`
  }

  /* 协议接收：校验来源窗口 / 版本 / 实例 / 形状 */
  private onMessage(e: MessageEvent): void {
    if (!this.iframe || e.source !== this.iframe.contentWindow) return // ① 来源窗口
    const m: unknown = e.data
    if (!isEnvelope(m)) return // ②③ 版本 + 实例 + type 白名单
    if (m.instance !== this.instance) return
    switch (m.type) {
      case 'ready': {
        const h = Number(m.payload?.height)
        if (!(h > 0)) return // ④ 形状：高度必须为正数
        this.clearWatch()
        this.status = 'live'
        this.setFrameHeight(h)
        this.callbacks.onReady?.(h)
        break
      }
      case 'input': {
        if (!m.payload || typeof m.payload.state === 'undefined') return
        try {
          this.state = JSON.parse(JSON.stringify(m.payload.state))
        } catch {
          return // ④ state 必须可 JSON 化
        }
        const h = Number(m.payload.height)
        if (h > 0) this.setFrameHeight(h)
        this.callbacks.onState?.(this.state, h > 0 ? h : undefined)
        break
      }
      case 'snapshot': {
        const req = Number(m.payload?.req)
        const resolve = this.pending.get(req)
        if (resolve) {
          this.pending.delete(req)
          try {
            this.state = JSON.parse(JSON.stringify(m.payload?.state ?? null))
          } catch {
            // 快照不可 JSON 化时保留内存态
          }
          resolve(this.state)
        }
        break
      }
      case 'error': {
        /* 运行失败：回滚到上个可用版本由页面负责（拿到状态 → loadVersion → 再打错误条） */
        this.status = 'dead'
        const message = m.payload?.message
        this.callbacks.onRuntimeError?.(typeof message === 'string' ? { message } : {})
        break
      }
      case 'init':
      case 'snapshot-request':
        break // 宿主 → 沙箱方向，沙箱不应回发；忽略
    }
  }
}

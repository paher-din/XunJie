import { IconText, type IconName } from '../../icons'
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import {
  activateTool,
  addTool,
  closeTool,
  defaultLayout,
  genCardIdOf,
  isDefaultShape,
  moveTab,
  panes,
  resizeSplit,
  splitTab,
  type CoreToolKey,
  type LayoutNode,
  type PaneNode,
  type ToolKey,
} from '../../lib/wsLayout'
import type { StoredGenCard } from '../../bridge/types'
import { GenToolPane } from './GenCardItems'

export type { ToolKey }

/**
 * 中心容器变体。
 * - `digital-logic`（默认）：原数字逻辑演示，静态代码 + 虚拟板 + 波形 + 模拟构建/烧录。
 * - `digital-logic-real`：真实 HDL 工作区，所有正文和运行状态由页面注入。
 * - `textscope-c`：I0-A 的 C 准备工作区。正文与顶栏运行簇由页面注入，
 *   board / wave 保留为数字逻辑演示并明确标注，不提供模拟构建入口。
 */
export type CenterVariant = 'digital-logic' | 'digital-logic-real' | 'textscope-c'

/** 暴露给工作区页面的命令句柄：从收纳 / 会话消息里重开生成卡标签。 */
export interface CenterToolAreaHandle {
  /** 打开（或激活）某张生成卡的工具区标签。 */
  openGenTab: (cardId: string) => void
  /** 关闭某张生成卡的标签（只关视图，卡本体仍在会话与收纳里）。 */
  closeGenTab: (cardId: string) => void
}

/**
 * 中心工具区：通用运行簇 + 类浏览器标签页分屏布局（Q7 已确认；上栏整合 2026-10-10）。
 * - 标签可拖拽：落到其他窗格标签栏/中央 = 并入；落到窗格四缘 = 分屏；分隔条可拖动调比例。
 * - 布局按任务持久化（localStorage `ws-layout:<taskId>`），可一键恢复默认。
 * - 工具状态（装载版本、板状态）持有在本组件，分屏/移动标签不会销毁草稿与运行会话。
 * - 单窗格时标签条 portal 到顶栏；运行簇（板状态、草稿/板载版本流、操作按钮）始终 portal 到顶栏，
 *   与任务进度环并列成一条单行指挥栏（原型确认：docs/prototypes 方案 A）。
 * 运行簇的状态与操作按钮将来由学科工具包声明（docs/home-design.md Q3）。
 */

export const SEGMAP: Record<number, string> = {
  0: 'abcdef',
  1: 'bc',
  2: 'abdeg',
  3: 'abcdg',
  4: 'bcfg',
  5: 'acdfg',
  6: 'acdefg',
  7: 'abc',
  8: 'abcdef',
  9: 'abcdfg',
}
const SEGPATHS: Record<string, string> = {
  a: 'M8 8h44',
  b: 'M52 8v40',
  c: 'M52 52v40',
  d: 'M8 92h44',
  e: 'M8 52v40',
  f: 'M8 8v40',
  g: 'M8 50h44',
}

/** 七段数码管（单个数字位）。tone=card 用于白色教学卡上的浅色描边。 */
export function Seg7({ n, tone = 'board' }: { n: number; tone?: 'board' | 'card' }) {
  const on = SEGMAP[n] ?? ''
  // tone=board 是虚拟开发板（仪器材质，颜色两套主题一致）；tone=card 压在教学卡上，跟随主题
  const [lit, unlit] =
    tone === 'board' ? ['#dfe9fb', '#55637a'] : ['var(--seg-lit)', 'var(--line-strong)']
  return (
    <svg width="60" height="100" viewBox="0 0 60 100">
      {Object.entries(SEGPATHS).map(([k, d]) => (
        <path
          key={k}
          d={d}
          // 描边用内联 style：presentation attribute 不解析 var()
          style={{ stroke: on.includes(k) ? lit : unlit }}
          strokeWidth="7"
          strokeLinecap="round"
          fill="none"
        />
      ))}
    </svg>
  )
}

const VERILOG: Array<[string, string]> = [
  ['cm', '// 可交互数字计数器 · 草稿 v4（未装载）'],
  ['kw', 'module'],
  ['', ' counter('],
  ['', '  input  wire clk,'],
  ['', '  input  wire rst_n,'],
  ['', '  input  wire key,'],
  ['', '  output reg  [3:0] led,'],
  ['', '  output reg  [6:0] seg'],
  ['', ');'],
  ['', '  reg [3:0] cnt;'],
  ['', '  always @(posedge clk or negedge rst_n) begin'],
  ['td', '    // TODO: 按键消抖 —— 当前 key 直接采样，会一次跳多数'],
  ['', "    if (!rst_n) cnt <= 4'd0;"],
  ['', "    else if (key) cnt <= cnt + 4'd1;"],
  ['', '    led <= cnt;'],
  ['', '  end'],
  ['kw', 'endmodule'],
]

function EditorPane() {
  return (
    <div className="ws-editor">
      {VERILOG.map(([cls, text], i) => (
        <span key={i} className="ws-editor-row">
          <span className="ln">{i + 1}</span>
          <span className={`code ${cls}`}>{text || ' '}</span>
        </span>
      ))}
      <p className="ws-editor-note">静态演示代码 · 不可编辑，也不代表已保存的作品</p>
    </div>
  )
}

function WavePane() {
  return (
    <div className="ws-wave">
      <svg width="760" height="210" viewBox="0 0 760 210">
        <text className="wlabel" x="0" y="36">clk</text>
        <path
          d={`M60 44h12${Array.from({ length: 19 }, (_, i) => `v${i % 2 ? -24 : 24}h24`).join('')}`}
          stroke="#7d99c5" fill="none" strokeWidth="1.6" transform="translate(48 0)"
        />
        <text className="wlabel" x="0" y="86">rst_n</text>
        <path d="M60 96h72v-24h500" stroke="#7d99c5" fill="none" strokeWidth="1.6" transform="translate(48 0)" />
        <text className="wlabel" x="0" y="136">key</text>
        <path
          d="M60 120h160v24h40v-24h120v24h40v-24h160"
          stroke="#7d99c5" fill="none" strokeWidth="1.6" transform="translate(48 0)"
        />
        <text className="wlabel" x="0" y="186">cnt</text>
        <path d="M60 176h200v-16h160v-16h200" stroke="#c0a079" fill="none" strokeWidth="1.6" transform="translate(48 0)" />
        <text className="wlabel" x="120" y="204">0</text>
        <text className="wlabel" x="330" y="204">1</text>
        <text className="wlabel" x="500" y="204">2</text>
      </svg>
      <p className="ws-pane-note">波形为静态示意 · 真实版本按仿真采样绘制，支持暂停与单步</p>
    </div>
  )
}

function BoardPane({
  count,
  sw,
  loaded,
  onCount,
  onReset,
  onSw,
}: {
  count: number
  sw: boolean[]
  loaded: string
  onCount: () => void
  onReset: () => void
  onSw: (i: number) => void
}) {
  return (
    <div className="ws-boardwrap">
      <div className="ws-board">
        <div className="ws-seg-row">
          <Seg7 n={count % 10} />
        </div>
        <div className="ws-ledrow">
          {[3, 2, 1, 0].map((i) => (
            <span key={i} className={(count >> i) & 1 ? 'ws-led on' : 'ws-led'} title={`LED${i}`} />
          ))}
        </div>
        <div className="ws-ctlrow">
          {sw.map((on, i) => (
            <span key={i} className="ws-switch">
              <button
                className={on ? 'ws-sw on' : 'ws-sw'}
                aria-label={`拨码开关 ${i}`}
                onClick={() => onSw(i)}
              />
              SW{i}
            </span>
          ))}
          <span className="ws-switch">
            <button className="ws-pbtn" onClick={onCount}>
              计数
            </button>
            KEY0
          </span>
          <span className="ws-switch">
            <button className="ws-pbtn" onClick={onReset}>
              复位
            </button>
            KEY1
          </span>
        </div>
      </div>
      <div className="ws-board-note">
        <p>
          <b>虚拟开发板</b> · 已装载设计 {loaded}
        </p>
        <p>
          输出由装载的设计决定：数码管显示计数值，4 个 LED 显示 cnt 的二进制位。SW
          开关在本设计中未使用，写错端口映射时现象会真实暴露。
        </p>
        <p>板卡行为由界面脚本模拟，未接仿真器。</p>
      </div>
    </div>
  )
}

/**
 * 一枚核心工具标签的声明。工具集由学科工具包给出（docs/home-design.md Q3）：
 * 数字逻辑是设计 / 虚拟板 / 波形，程序设计是代码；标签文案随课程变，
 * 但布局树里的 key 仍是 wsLayout 的那几个核心工具，不新增布局概念。
 */
export interface ToolSpec {
  key: CoreToolKey
  label: string
  icon: IconName
}

export const DIGITAL_LOGIC_TOOLS: ToolSpec[] = [
  { key: 'design', label: '设计', icon: 'code-square' },
  { key: 'board', label: '虚拟板', icon: 'virtual-board' },
  { key: 'wave', label: '波形', icon: 'digital-waveform' },
]

export const CODE_TOOLS: ToolSpec[] = [{ key: 'design', label: '代码', icon: 'code-square' }]

const GEN_TAB_ICON: IconName = 'play-circle'

/** 标签展示元数据：核心工具查工具包声明，生成卡标签用存储里的标题。 */
function toolMeta(k: ToolKey, tools: ToolSpec[], genCards: StoredGenCard[]): { icon: IconName; name: string; gen: boolean } {
  const cardId = genCardIdOf(k)
  if (cardId) {
    return { icon: GEN_TAB_ICON, name: genCards.find((c) => c.cardId === cardId)?.title ?? '生成卡', gen: true }
  }
  const spec = tools.find((t) => t.key === k)
  return { icon: spec?.icon ?? 'code-square', name: spec?.label ?? k, gen: false }
}

type DropZone = 'left' | 'right' | 'top' | 'bottom' | 'center'

/**
 * 持久化布局是否还认得当前工具包：每个窗格至少一个标签、标签都是当前核心工具或生成卡、
 * active 在其中。课程换工具包后旧布局不再适用，直接回默认，不留下空白窗格。
 */
function knownTools(node: LayoutNode, toolKeys: CoreToolKey[]): boolean {
  const list = panes(node)
  if (list.length === 0) return false
  return list.every(
    (pane) =>
      pane.tabs.length > 0 &&
      pane.tabs.every((tab) => genCardIdOf(tab) !== null || toolKeys.includes(tab as CoreToolKey)) &&
      pane.tabs.includes(pane.active),
  )
}

function Divider({ horiz, onResize }: { horiz: boolean; onResize: (ratio: number) => void }) {
  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    e.preventDefault()
    const parent = e.currentTarget.parentElement
    if (!parent) return
    const rect = parent.getBoundingClientRect()
    const move = (ev: PointerEvent) => {
      const ratio = horiz ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height
      onResize(ratio)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return <div className={horiz ? 'ws-divider row' : 'ws-divider col'} onPointerDown={onPointerDown} />
}

/** 分段控件式工具标签：滑动高亮跟随激活项；拖到标签栏 = 并入该窗格。生成卡标签带 ×（只关视图）。 */
function ToolTabs({
  pane,
  tools,
  allowDrop,
  genCards,
  onActivate,
  onDragStart,
  onDragEnd,
  onDropOn,
  onClose,
}: {
  pane: PaneNode
  /** 当前课程工具包声明的核心工具（标签文案与图标）。 */
  tools: ToolSpec[]
  allowDrop: boolean
  genCards: StoredGenCard[]
  onActivate: (k: ToolKey) => void
  onDragStart: (k: ToolKey) => void
  onDragEnd: () => void
  onDropOn: (paneId: string) => void
  /** 关闭生成卡标签（只关视图，卡本体仍在会话与收纳里）。 */
  onClose: (k: ToolKey) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [glider, setGlider] = useState({ x: 0, w: 0 })

  useLayoutEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>('.ws-tooltab.active')
    if (el) setGlider({ x: el.offsetLeft, w: el.offsetWidth })
  }, [pane.active, pane.tabs])

  return (
    <div
      ref={ref}
      className="ws-tooltabs"
      role="tablist"
      aria-label="工具"
      onDragOver={(e) => {
        if (allowDrop) e.preventDefault()
      }}
      onDrop={(e) => {
        e.preventDefault()
        onDropOn(pane.id)
      }}
    >
      <span className="ws-tabglider" style={{ transform: `translateX(${glider.x}px)`, width: glider.w }} />
      {pane.tabs.map((k) => {
        const meta = toolMeta(k, tools, genCards)
        return (
          <button
            key={k}
            role="tab"
            aria-selected={pane.active === k}
            draggable
            className={pane.active === k ? 'ws-tooltab active' : 'ws-tooltab'}
            onDragStart={() => onDragStart(k)}
            onDragEnd={onDragEnd}
            onClick={() => onActivate(k)}
          >
            <IconText name={meta.icon} tone="neutral" variant="linear">{meta.name}</IconText>
            {meta.gen && (
              <span
                className="ws-tabx"
                title="关闭标签（卡还在会话与收纳里）"
                onClick={(e) => {
                  e.stopPropagation()
                  onClose(k)
                }}
              >
                ×
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

export const CenterToolArea = forwardRef(function CenterToolArea({
  taskId,
  tool,
  onToolChange,
  onToast,
  onDesignLoaded,
  genCards = [],
  onGenTabsChange,
  onGenCollect,
  onGenStateSync,
  tabsSlot,
  runSlot,
  variant = 'digital-logic',
  tools = DIGITAL_LOGIC_TOOLS,
  designBody,
  boardBody,
  waveBody,
  runCluster,
}: {
  taskId: string
  /** 外部（引导脚本）要求聚焦的工具。 */
  tool: ToolKey
  onToolChange: (t: ToolKey) => void
  onToast: (text: string) => void
  onDesignLoaded?: () => void
  /** 当前任务的生成卡收纳存储（标签页内容按 cardId 查；钉右缘与胶囊收纳同源）。 */
  genCards?: StoredGenCard[]
  /** 布局里打开着的生成卡标签（页面据此计算胶囊收纳列表与角标）。 */
  onGenTabsChange?: (cardIds: string[]) => void
  /** 标签页上「收纳」：拿到最新快照后由页面冻结入收纳并关闭标签。 */
  onGenCollect?: (cardId: string, snapshot: unknown) => void
  /** live 期间的交互状态续写。 */
  onGenStateSync?: (cardId: string, snapshot: unknown) => void
  /** 顶栏标签槽（浏览器式）：单窗格时标签条 portal 到这里；分屏后各窗格回到自带标签条。 */
  tabsSlot?: HTMLElement | null
  /** 顶栏运行簇槽：板状态、版本流与操作按钮 portal 到这里（不分屏也常驻顶栏）。 */
  runSlot?: HTMLElement | null
  /** 中心容器变体；缺省是原数字逻辑演示。 */
  variant?: CenterVariant
  /** 学科工具包声明的核心工具；缺省是数字逻辑那三枚。 */
  tools?: ToolSpec[]
  /** 「设计 / 代码」标签的正文：课程工具包自己给（缺省是数字逻辑的静态代码演示）。 */
  designBody?: ReactNode
  /** 真实板卡 / 有限波形由业务页面提供，不改变原标签与分屏布局。 */
  boardBody?: ReactNode
  waveBody?: ReactNode
  /** 顶栏运行簇内容：状态与操作由学科工具包声明（缺省是虚拟板的状态与烧录）。 */
  runCluster?: ReactNode
}, ref: React.Ref<CenterToolAreaHandle>) {
  const [count, setCount] = useState(3)
  const [sw, setSw] = useState([true, false, true, false])
  const [loaded, setLoaded] = useState('v3')

  const toolKeys = tools.map((t) => t.key)
  const storeKey = `ws-layout:${taskId}`
  const [layout, setLayout] = useState<LayoutNode>(() => {
    try {
      const raw = localStorage.getItem(storeKey)
      if (raw) {
        const stored = JSON.parse(raw) as LayoutNode
        // 工具包换过之后，旧布局里的标签可能已经不是当前课程的工具：只接受仍然认识的标签
        if (knownTools(stored, toolKeys)) return stored
      }
    } catch {
      // 损坏的持久化布局回退默认
    }
    return defaultLayout(toolKeys)
  })
  const [dragTool, setDragTool] = useState<ToolKey | null>(null)
  const [dropHint, setDropHint] = useState<string | null>(null)

  useEffect(() => {
    localStorage.setItem(storeKey, JSON.stringify(layout))
  }, [storeKey, layout])

  // 引导脚本切换工具时，激活对应窗格里的标签
  useEffect(() => {
    setLayout((l) => activateTool(l, tool))
  }, [tool])

  /* 生成卡标签：打开 / 关闭（关闭只关视图，卡本体仍在会话与收纳里，第 19 条） */
  useImperativeHandle(ref, () => ({
    openGenTab: (cardId: string) => {
      setLayout((l) => addTool(l, `gen:${cardId}`))
      onToolChange(`gen:${cardId}`)
    },
    closeGenTab: (cardId: string) => setLayout((l) => closeTool(l, `gen:${cardId}`)),
  }))

  // 向页面报告当前打开着的生成卡标签（收纳列表与角标排除它们）
  useEffect(() => {
    const ids = panes(layout)
      .flatMap((p) => p.tabs)
      .map((t) => genCardIdOf(t))
      .filter((id): id is string => id !== null)
    onGenTabsChange?.(ids)
  }, [layout, onGenTabsChange])

  const isTextScopeC = variant === 'textscope-c'
  const isRealHdl = variant === 'digital-logic-real'

  /** C 变体下 board / wave 仍是数字逻辑演示：加一条明确横幅，避免被当成 C 工具。 */
  function withDemoBanner(node: ReactElement): ReactElement {
    if (!isTextScopeC) return node
    return (
      <div className="ws-demo-wrap">
        <p className="ws-demo-banner">数字逻辑演示 · 与当前 C 活动无关，不写入学习记录</p>
        {node}
      </div>
    )
  }

  function renderContent(k: ToolKey): ReactNode {
    const cardId = genCardIdOf(k)
    if (cardId) {
      const card = genCards.find((c) => c.cardId === cardId) ?? null
      return (
        <GenToolPane
          card={card}
          onCollect={(snapshot) => onGenCollect?.(cardId, snapshot)}
          onStateSync={(snapshot) => onGenStateSync?.(cardId, snapshot)}
          onClose={() => setLayout((l) => closeTool(l, `gen:${cardId}`))}
        />
      )
    }
    if (k === 'design') return designBody ?? (isTextScopeC || isRealHdl ? null : <EditorPane />)
    if (k === 'wave') return waveBody ?? (isRealHdl
      ? <p className="ws-pane-note">尚未取得真实 HDL 波形。</p> : withDemoBanner(<WavePane />))
    if (boardBody !== undefined) return boardBody
    if (isRealHdl) return <p className="ws-pane-note">尚未取得真实 HDL 板卡结果。</p>
    return withDemoBanner(
      <BoardPane
        count={count}
        sw={sw}
        loaded={loaded}
        onCount={() => setCount((c) => (c + 1) % 16)}
        onReset={() => setCount(0)}
        onSw={(i) => setSw(sw.map((v, j) => (j === i ? !v : v)))}
      />,
    )
  }

  function endDrag() {
    setDragTool(null)
    setDropHint(null)
  }

  function dropOnPane(paneId: string, zone: DropZone) {
    if (!dragTool) return
    setLayout((l) => {
      if (zone === 'center') return moveTab(l, dragTool, paneId)
      const dir = zone === 'left' || zone === 'right' ? 'row' : 'col'
      const before = zone === 'left' || zone === 'top'
      return splitTab(l, dragTool, paneId, dir, before)
    })
    endDrag()
  }

  function renderPane(p: PaneNode): ReactElement {
    // 整个布局只有一个窗格时，标签条上升到顶栏（portal）；分屏后每个窗格自带标签条
    const single = layout.kind === 'pane'
    const tabs = (
      <ToolTabs
        pane={p}
        tools={tools}
        allowDrop={dragTool != null}
        genCards={genCards}
        onActivate={onToolChange}
        onDragStart={setDragTool}
        onDragEnd={endDrag}
        onDropOn={(paneId) => dropOnPane(paneId, 'center')}
        onClose={(k) => setLayout((l) => closeTool(l, k))}
      />
    )
    return (
      <div className="ws-pane">
        {single && tabsSlot ? createPortal(tabs, tabsSlot) : tabs}
        <div className="ws-pane-body">
          <div className="ws-toolpane">{renderContent(p.active)}</div>
          {dragTool && (
            <div className="ws-drop">
              {(['left', 'right', 'top', 'bottom'] as const).map((zone) => (
                <div
                  key={zone}
                  className={dropHint === p.id + zone ? `ws-dropzone ${zone} hint` : `ws-dropzone ${zone}`}
                  onDragOver={(e) => {
                    e.preventDefault()
                    setDropHint(p.id + zone)
                  }}
                  onDragLeave={() => setDropHint((h) => (h === p.id + zone ? null : h))}
                  onDrop={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    dropOnPane(p.id, zone)
                  }}
                />
              ))}
              <div
                className={dropHint === p.id + 'center' ? 'ws-dropzone center hint' : 'ws-dropzone center'}
                onDragOver={(e) => {
                  e.preventDefault()
                  setDropHint(p.id + 'center')
                }}
                onDragLeave={() => setDropHint((h) => (h === p.id + 'center' ? null : h))}
                onDrop={(e) => {
                  e.preventDefault()
                  dropOnPane(p.id, 'center')
                }}
              >
                <span>松开并入此窗格 · 拖到边缘分屏</span>
              </div>
            </div>
          )}
        </div>
      </div>
    )
  }

  function renderNode(node: LayoutNode): ReactElement {
    if (node.kind === 'pane') return renderPane(node)
    const horiz = node.dir === 'row'
    const size = `calc(${(node.ratio * 100).toFixed(2)}% - 3px)`
    return (
      <div className={horiz ? 'ws-split row' : 'ws-split col'}>
        <div className="ws-split-child" style={horiz ? { width: size } : { height: size }}>
          {renderNode(node.a)}
        </div>
        <Divider horiz={horiz} onResize={(r) => setLayout((l) => resizeSplit(l, node.id, r))} />
        <div className="ws-split-child grow">{renderNode(node.b)}</div>
      </div>
    )
  }

  const dirty = loaded === 'v3'
  return (
    <div className="ws-center">
      {runSlot &&
        createPortal(
          <>
            {!isDefaultShape(layout, toolKeys) && (
              <span className="ws-run-actions">
                <button className="ws-btn ghost" onClick={() => setLayout(defaultLayout(toolKeys))}>
                  <IconText name="restart">默认布局</IconText>
                </button>
              </span>
            )}
            {isTextScopeC || isRealHdl ? (
              // C 准备工作区：顶栏运行簇由页面注入（06 接入前是不可用状态，不提供模拟构建/烧录）
              runCluster
            ) : (
              runCluster ?? (
                <DigitalLogicRunCluster
                  dirty={dirty}
                  onBuild={() => onToast('构建通过 · 0 错误 1 警告（模拟）')}
                  onLoad={() => {
                    setLoaded('v4')
                    if (dirty) onDesignLoaded?.()
                    onToast('已装载设计 v4 到虚拟板（模拟）')
                  }}
                />
              )
            )}
          </>,
          runSlot,
        )}
      <div className="ws-split-root">{renderNode(layout)}</div>
    </div>
  )
})

/** 数字逻辑工具包的运行簇：板状态 + 草稿/板载版本流 + 检查构建与烧录（均为课程包级模拟）。 */
function DigitalLogicRunCluster({ dirty, onBuild, onLoad }: { dirty: boolean; onBuild: () => void; onLoad: () => void }) {
  return (
    <>
      <span className="ws-run-state">
        <i />
        <span>虚拟板运行中</span>
      </span>
      {dirty ? (
        <span className="ws-flow" title="草稿 v4 尚未烧录，虚拟板仍在运行 v3">
          <span className="ws-flow-node draft">
            <i />
            草稿 v4
          </span>
          <span className="ws-flow-link">▸</span>
          <span className="ws-flow-node loaded">板载 v3</span>
        </span>
      ) : (
        <span className="ws-flow synced">
          <b>✓</b>
          板载 v4 · 与草稿同步
        </span>
      )}
      <span className="ws-run-actions">
        <button className="ws-btn ghost" onClick={onBuild}>
          <IconText name="checklist">检查并构建</IconText>
        </button>
        <button className="ws-btn solid" onClick={onLoad}>
          <IconText name="load-board">烧录到虚拟板</IconText>
          {dirty && <i className="ws-btn-dot" title="有未装载的草稿" />}
        </button>
      </span>
    </>
  )
}


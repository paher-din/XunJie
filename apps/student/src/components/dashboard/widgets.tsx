import { Icon, type IconName } from '../../icons'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent } from 'react'
import type { DashboardData, ProjectTask } from '../../bridge/types'

export interface WidgetProps {
  data: DashboardData
  tasks: ProjectTask[]
  now: Date
  bindTip: (text: string) => {
    onMouseEnter: (e: MouseEvent<Element>) => void
    onMouseLeave: () => void
  }
  /** 在任意坐标（视口 CSS px）直接显示悬停提示 */
  showTip: (x: number, y: number, text: string) => void
  hideTip: () => void
}

const fmtDay = (d: Date) => `${d.getMonth() + 1}月${d.getDate()}日`
const dayKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const lv = (v: number) => (v === 0 ? 0 : v < 1 ? 1 : v < 2 ? 2 : v < 3 ? 3 : 4)
const levelClass = (v: number) => (v === 0 ? '' : ` l${lv(v)}`)

interface SemDay {
  d: Date
  v: number
}

/** 开学至今的逐日数据，转成 Date 对象。 */
function useSemDays(data: DashboardData): SemDay[] {
  return useMemo(
    () => data.activity.map((a) => ({ d: new Date(a.date + 'T00:00:00'), v: a.hours })),
    [data],
  )
}

/** 前补空格对齐周一，再按 7 天切成周列。 */
function weeksOf(days: SemDay[]): Array<Array<SemDay | null>> {
  if (days.length === 0) return []
  const pad = (days[0].d.getDay() + 6) % 7
  const arr: Array<SemDay | null> = [...Array(pad).fill(null), ...days]
  const weeks: Array<Array<SemDay | null>> = []
  for (let i = 0; i < arr.length; i += 7) weeks.push(arr.slice(i, i + 7))
  return weeks
}

/* ---- 学习活动热力图：每日 / 每周 / 每月 ---- */
export function HeatWidget({ data, now, bindTip, showTip, hideTip }: WidgetProps) {
  const [view, setView] = useState<'daily' | 'weekly'>('daily')
  const sem = useSemDays(data)
  const weeks = useMemo(() => weeksOf(sem), [sem])
  const todayKey = dayKey(now)

  return (
    <>
      <div className="db-tabs-row">
        <div className="db-tabs">
          {(['daily', 'weekly'] as const).map((v) => (
            <button key={v} className={view === v ? 'on' : ''} onClick={() => setView(v)}>
              {v === 'daily' ? '每日' : '每周'}
            </button>
          ))}
        </div>
      </div>
      <div className="db-fill">
        {view === 'daily' && <HeatDaily weeks={weeks} todayKey={todayKey} bindTip={bindTip} />}
        {view === 'weekly' && <HeatWeekly weeks={weeks} showTip={showTip} hideTip={hideTip} />}
      </div>
    </>
  )
}

function HeatDaily({
  weeks,
  todayKey,
  bindTip,
}: {
  weeks: Array<Array<SemDay | null>>
  todayKey: string
  bindTip: WidgetProps['bindTip']
}) {
  const n = weeks.length
  const ref = useRef<HTMLDivElement>(null)
  const [cw, setCw] = useState(0)
  const [ch, setCh] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      setCw(el.clientWidth)
      setCh(el.clientHeight)
    })
    ro.observe(el)
    setCw(el.clientWidth)
    setCh(el.clientHeight)
    return () => ro.disconnect()
  }, [])
  const sz = cw === 0 ? 14 : Math.max(12, Math.min(20, Math.floor((cw - (n - 1) * 4) / n)))
  // 方块大小不变，周列间距自适应铺满可用宽度（上限 14px，超出仍右对齐）
  const gap =
    cw === 0 || n <= 1 ? 4 : Math.max(4, Math.min(14, Math.floor((cw - 8 - n * sz) / (n - 1))))
  // 行间距同样自适应铺满可用高度，消除底部空白（上限 14px，超出则垂直居中）
  const rowGap =
    ch === 0 ? 4 : Math.max(4, Math.min(14, Math.floor((ch - 62 - 7 * sz) / 6)))
  return (
    <div className="db-scroll" ref={ref}>
      <div className="db-hm-months" style={{ gap }}>
        {weeks.map((w, i) => {
          const d = w.find((x) => x)?.d
          const prev = i > 0 ? weeks[i - 1].find((x) => x)?.d : undefined
          return (
            <span key={i} style={{ width: sz, animationDelay: `${i * 20}ms` }}>
              {d && (!prev || prev.getMonth() !== d.getMonth()) ? `${d.getMonth() + 1}月` : ''}
            </span>
          )
        })}
      </div>
      <div className="db-hm" style={{ gap }}>
        {weeks.map((w, i) => (
          <div
            key={i}
            className="db-hm-col"
            style={{ gridTemplateRows: `repeat(7, ${sz}px)`, rowGap }}
          >
            {w.map((x, j) =>
              x ? (
                <i
                  key={j}
                  className={`${levelClass(x.v)}${dayKey(x.d) === todayKey ? ' today' : ''}`}
                  style={{ width: sz, height: sz, animationDelay: `${i * 20 + j * 9}ms` }}
                  {...bindTip(`${fmtDay(x.d)} · 学习了 ${x.v} 小时`)}
                />
              ) : (
                <i key={j} className="blank" />
              ),
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function HeatWeekly({
  weeks,
  showTip,
  hideTip,
}: {
  weeks: Array<Array<SemDay | null>>
  showTip: WidgetProps['showTip']
  hideTip: WidgetProps['hideTip']
}) {
  const sums = weeks.map((w) => w.reduce((a, x) => a + (x ? x.v : 0), 0))
  const n = sums.length
  const max = Math.max(...sums, 1)
  const ref = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const [cw, setCw] = useState(0)
  const [ch, setCh] = useState(0)
  const [hover, setHover] = useState<number | null>(null)
  // 虚线保持挂载，用 translateX 滑动；记录上次位置，移出时从原处淡出
  const lastX = useRef(12)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      setCw(el.clientWidth)
      setCh(el.clientHeight)
    })
    ro.observe(el)
    setCw(el.clientWidth)
    setCh(el.clientHeight)
    return () => ro.disconnect()
  }, [])

  // db-scroll 有 36+4 的上下 padding，曲线高度只占用内容盒，避免撑高卡片形成反馈循环
  const H = Math.max(ch - 40, 60)
  const padX = 12
  const padT = 12
  const padB = 20
  const iw = Math.max(cw - padX * 2, 1)
  const ih = Math.max(H - padT - padB, 1)
  const px = (i: number) => padX + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw)
  const py = (v: number) => padT + ih - (v / max) * ih

  // 悬停在图表任意位置，吸附到横向最近的一周
  const onMove = (e: MouseEvent<Element>) => {
    const svg = svgRef.current
    if (!svg || n === 0) return
    const box = svg.getBoundingClientRect()
    const mx = e.clientX - box.left
    const i = Math.round(((mx - padX) / iw) * (n - 1))
    const idx = Math.max(0, Math.min(n - 1, i))
    const first = weeks[idx].find((x) => x)?.d
    if (!first) return
    setHover(idx)
    lastX.current = px(idx)
    showTip(box.left + px(idx), box.top + py(sums[idx]), `${fmtDay(first)} 当周 · 共 ${sums[idx].toFixed(1)} 小时`)
  }
  const onLeave = () => {
    setHover(null)
    hideTip()
  }

  // Catmull-Rom 转三次贝塞尔，平滑曲线
  const pts = sums.map((s, i) => [px(i), py(s)] as const)
  let line = ''
  if (pts.length === 1) line = `M ${pts[0][0]} ${pts[0][1]}`
  else {
    line = `M ${pts[0][0]} ${pts[0][1]}`
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, y0] = pts[Math.max(i - 1, 0)]
      const [x1, y1] = pts[i]
      const [x2, y2] = pts[i + 1]
      const [x3, y3] = pts[Math.min(i + 2, pts.length - 1)]
      line += ` C ${x1 + (x2 - x0) / 6} ${y1 + (y2 - y0) / 6}, ${x2 - (x3 - x1) / 6} ${y2 - (y3 - y1) / 6}, ${x2} ${y2}`
    }
  }
  const area = `${line} L ${px(n - 1)} ${padT + ih} L ${px(0)} ${padT + ih} Z`

  return (
    <div className="db-scroll" ref={ref}>
      {cw > 0 && (
        <svg
          className="db-wkline"
          width={cw}
          height={H}
          ref={svgRef}
          onMouseMove={onMove}
          onMouseLeave={onLeave}
        >
          <defs>
            <linearGradient id="dbWkFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" style={{ stopColor: 'var(--chart-blue-2)' }} stopOpacity="0.25" />
              <stop offset="100%" style={{ stopColor: 'var(--chart-blue-2)' }} stopOpacity="0.02" />
            </linearGradient>
          </defs>
          <path className="db-wkline-area" d={area} fill="url(#dbWkFill)" />
          <path
            className="db-wkline-line"
            d={line}
            pathLength={1}
            fill="none"
            style={{ stroke: 'var(--accent)' }}
            strokeWidth="2"
            strokeLinecap="round"
          />
          <line
            className="db-wkline-guide"
            x1={0}
            x2={0}
            y1={padT}
            y2={padT + ih}
            strokeDasharray="3 4"
            style={{
              transform: `translateX(${hover !== null ? px(hover) : lastX.current}px)`,
              opacity: hover !== null ? 1 : 0,
            }}
          />
          {weeks.map((w, i) => {
            const first = w.find((x) => x)?.d
            const prev = i > 0 ? weeks[i - 1].find((x) => x)?.d : undefined
            return (
              <g key={i}>
                {first && (!prev || prev.getMonth() !== first.getMonth()) && (
                  <text
                    x={px(i)}
                    y={H - 4}
                    textAnchor={i === 0 ? 'start' : 'middle'}
                    className="db-wkline-m"
                    style={{ animationDelay: `${0.5 + i * 0.05}s` }}
                  >
                    {first.getMonth() + 1}月
                  </text>
                )}
              </g>
            )
          })}
        </svg>
      )}
    </div>
  )
}

/* ---- 任务完成（进度条样式） ---- */
export function TaskProgressWidget({ tasks }: WidgetProps) {
  const done = tasks.filter((t) => t.status === '已完成').length
  const pct = tasks.length > 0 ? Math.round((done / tasks.length) * 1000) / 10 : 0
  const lastDone = tasks
    .filter((t) => t.status === '已完成' && t.lastStudiedAt)
    .sort((a, b) => (a.lastStudiedAt! < b.lastStudiedAt! ? 1 : -1))[0]
  const next = tasks.find((t) => t.status === '进行中')
  return (
    <>
      <div className="db-big">
        {done}
        <small>
          {' '}
          / {tasks.length} 个任务 · {pct}%
        </small>
      </div>
      <div className="db-goal-track">
        <div className="db-goal-fill" style={{ width: pct + '%' }} />
        {[25, 50, 75].map((t) => (
          <span key={t} className="db-goal-tick" style={{ left: t + '%' }} />
        ))}
        <span className="db-goal-now" style={{ left: pct + '%' }}>
          当前
        </span>
      </div>
      <div className="db-foot-note">
        {lastDone ? `最近完成：${lastDone.name}` : '还没有完成的任务'}
        {next ? ` · 下一个：${next.name}` : ''}
      </div>
    </>
  )
}

/* ---- 学习投入构成（马赛克占比块） ---- */
export function MosaicWidget({ data, bindTip }: WidgetProps) {
  return (
    <>
      <div className="db-mosaic">
        {data.composition.map((s) => {
          const h = ((data.compositionTotalHours * s.percent) / 100).toFixed(1)
          return (
            <div
              key={s.label}
              className={`mos ${s.tone}`}
              {...bindTip(`${s.label} · ${h} 小时 · 占 ${s.percent}%`)}
            >
              <span className="v">
                {s.percent}
                <small>%</small>
              </span>
              <span className="lab">{s.label}</span>
              <span className="hrs">{h}h</span>
            </div>
          )
        })}
      </div>
    </>
  )
}

/* ---- 成就徽章墙 ---- */
const BADGE_ICONS: Record<string, IconName> = {
  '初': 'emoji-light-bulb', '7': 'emoji-fire', '问': 'emoji-speech-balloon',
  'Bug': 'emoji-bug', '21': 'emoji-fire', '综': 'emoji-puzzle-piece',
  '师': 'emoji-handshake', '夜': 'emoji-crescent-moon', '全': 'emoji-calendar',
}

export function BadgesWidget({ data }: WidgetProps) {
  return (
    <>
      <div className="db-badges">
        {data.badges.map((b) => (
          <div key={b.label} className={`db-badge ${b.unlocked ? 'on' : 'off'}`}>
            <span className="ic">
              <Icon name={BADGE_ICONS[b.icon] ?? 'emoji-puzzle-piece'} size={28} />
              {(b.icon === '7' || b.icon === '21') && <span className="badge-level">{b.icon}d</span>}
            </span>
            {b.label}
            {!b.unlocked && <span className="badge-lock">未解锁</span>}
          </div>
        ))}
      </div>
    </>
  )
}

/* ---- 知识掌握雷达 ---- */
export function RadarWidget({ data }: WidgetProps) {
  const axes = data.radar
  const cx = 110
  const cy = 105
  const R = 78
  const pt = (i: number, r: number): [number, number] => {
    const a = -Math.PI / 2 + (i * Math.PI) / 3
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r]
  }
  const poly = axes.map((ax, i) => pt(i, R * ax.value).join(',')).join(' ')
  return (
    <>
      <svg className="db-radar" viewBox="0 0 220 210">
        {[0.33, 0.66, 1].map((f) => (
          <polygon
            key={f}
            points={axes.map((_, i) => pt(i, R * f).join(',')).join(' ')}
            fill="none"
            style={{ stroke: 'var(--chart-neut-1)' }}
          />
        ))}
        {axes.map((ax, i) => {
          const [x, y] = pt(i, R)
          const [tx, ty] = pt(i, R + 16)
          return (
            <g key={ax.axis}>
              <line x1={cx} y1={cy} x2={x} y2={y} style={{ stroke: 'var(--chart-neut-1)' }} />
              <text x={tx} y={ty + 3} textAnchor="middle" fontSize="11" style={{ fill: 'var(--muted)' }}>
                {ax.axis}
              </text>
            </g>
          )
        })}
        <polygon
          points={poly}
          style={{ fill: 'var(--chart-blue-2)', stroke: 'var(--accent)' }}
          fillOpacity="0.18"
          strokeWidth="2"
        />
        {axes.map((ax, i) => {
          const [x, y] = pt(i, R * ax.value)
          return <circle key={ax.axis} cx={x} cy={y} r="3" style={{ fill: 'var(--accent)' }} />
        })}
      </svg>
    </>
  )
}

/* ---- 里程碑时间线 ---- */
export function TimelineWidget({ data }: WidgetProps) {
  return (
    <>
      <div className="db-tl">
        {data.milestones.map((m) => (
          <div key={m.name} className={`db-tl-item ${m.state}`}>
            <b>{m.name}</b>
            <span>{m.note}</span>
          </div>
        ))}
      </div>
    </>
  )
}

/* ---- 周节奏气泡矩阵 ---- */
export function PunchWidget({ data, bindTip }: WidgetProps) {
  const days = ['一', '二', '三', '四', '五', '六', '日']
  return (
    <>
      <div className="db-punch">
        <span />
        {Array.from({ length: 24 }, (_, h) => (
          <span key={h} className="h">
            {h % 6 === 0 ? h : ''}
          </span>
        ))}
        {data.punch.map((row, d) => [
          <span key={`d${d}`} className="d">
            {days[d]}
          </span>,
          ...row.map((v, h) => {
            const s = Math.min(1, v / 1.5)
            return (
              <span
                key={`${d}-${h}`}
                className="dot"
                style={{
                  background: v ? 'var(--chart-blue-2)' : 'var(--chart-neut-0)',
                  opacity: v ? 0.25 + s * 0.75 : 1,
                  transform: `scale(${0.35 + s * 0.65})`,
                }}
                {...bindTip(`周${days[d]} ${h}:00 · 约 ${v.toFixed(1)} 小时`)}
              />
            )
          }),
        ])}
      </div>
    </>
  )
}

/* ---- 渐变面积趋势 · 近30天 ---- */
export function TrendWidget({ data }: WidgetProps) {
  const days = data.activity.slice(-30)
  const W = 980
  const H = 160
  const P = 20
  const max = Math.max(...days.map((x) => x.hours), 1)
  const pts = days.map((x, i) => [
    P + (i * (W - 2 * P)) / 29,
    H - P - (x.hours / max) * (H - 2 * P),
  ])
  let path = `M${pts[0][0]},${pts[0][1]}`
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1]
    const [x1, y1] = pts[i]
    const mx = (x0 + x1) / 2
    path += ` C${mx},${y0} ${mx},${y1} ${x1},${y1}`
  }
  const [lx, ly] = pts[pts.length - 1]
  return (
    <>
      <svg className="db-trend" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id="db-ag" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" style={{ stopColor: 'var(--accent)' }} stopOpacity=".3" />
            <stop offset="1" style={{ stopColor: 'var(--accent)' }} stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0, 1, 2, 3].map((i) => (
          <line
            key={i}
            x1={P}
            x2={W - P}
            y1={P + (i * (H - 2 * P)) / 3}
            y2={P + (i * (H - 2 * P)) / 3}
            style={{ stroke: 'var(--chart-neut-1)' }}
          />
        ))}
        <path d={`${path} L${lx},${H - P} L${pts[0][0]},${H - P} Z`} fill="url(#db-ag)" />
        <path
          d={path}
          fill="none"
          style={{ stroke: 'var(--accent)' }}
          strokeWidth="2.5"
          strokeLinecap="round"
        />
        <circle cx={lx} cy={ly} r="5" style={{ fill: 'var(--accent)' }} />
        <circle cx={lx} cy={ly} r="9" style={{ fill: 'var(--accent)' }} opacity=".2" />
      </svg>
    </>
  )
}

/* ---- 环形进度 ---- */
export function RingWidget({ tasks }: WidgetProps) {
  const done = tasks.filter((t) => t.status === '已完成').length
  const p = tasks.length > 0 ? done / tasks.length : 0
  const r = 54
  const c = 2 * Math.PI * r
  return (
    <>
      <div className="db-ring-row">
        <svg width="120" height="120" viewBox="0 0 132 132">
          <circle
            cx="66"
            cy="66"
            r={r}
            fill="none"
            style={{ stroke: 'var(--chart-neut-0)' }}
            strokeWidth="12"
          />
          <circle
            cx="66"
            cy="66"
            r={r}
            fill="none"
            style={{ stroke: 'var(--accent)' }}
            strokeWidth="12"
            strokeLinecap="round"
            strokeDasharray={`${c * p} ${c}`}
            transform="rotate(-90 66 66)"
          />
          <text
            x="66"
            y="63"
            textAnchor="middle"
            fontSize="22"
            fontWeight="700"
            style={{ fill: 'var(--ink)' }}
          >
            {done}/{tasks.length}
          </text>
          <text x="66" y="82" textAnchor="middle" fontSize="11" style={{ fill: 'var(--muted)' }}>
            个任务
          </text>
        </svg>
        <div className="db-foot-note">
          进行中 {tasks.filter((t) => t.status === '进行中').length} · 未开始{' '}
          {tasks.filter((t) => t.status === '未开始').length}
        </div>
      </div>
    </>
  )
}

/* ---- 连续学习火焰 ---- */
export function StreakWidget({ data, now }: WidgetProps) {
  const map = new Map(data.activity.map((a) => [a.date, a.hours]))
  let streak = 0
  const cursor = new Date(now)
  if (!(map.get(dayKey(cursor)) ?? 0)) cursor.setDate(cursor.getDate() - 1)
  while ((map.get(dayKey(cursor)) ?? 0) > 0) {
    streak++
    cursor.setDate(cursor.getDate() - 1)
  }
  const week = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(now)
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + i)
    return { on: (map.get(dayKey(d)) ?? 0) > 0, today: dayKey(d) === dayKey(now) }
  })
  const days = ['一', '二', '三', '四', '五', '六', '日']
  return (
    <>
      <div className="db-streak-row">
        <Icon className="db-flame" name="emoji-fire" size={48} />
        <div>
          <span className="db-big">{streak}</span> <span className="db-side">天连续学习</span>
        </div>
      </div>
      <div className="db-week-circles">
        {week.map((w, i) => (
          <span key={i} className={`wc ${w.on ? 'on' : ''} ${w.today ? 'today' : ''}`}>
            {days[i]}
          </span>
        ))}
      </div>
    </>
  )
}

/* ---- 知识点掌握度列表 ---- */
export function MasteryWidget({ data }: WidgetProps) {
  return (
    <>
      {data.mastery.map((m) => (
        <div key={m.label} className="db-sk">
          <span className="lab">{m.label}</span>
          <span className="bar">
            <i style={{ width: m.percent + '%' }} />
          </span>
          <span className="pct">{m.percent}%</span>
        </div>
      ))}
    </>
  )
}

/* ---- 等级 / XP 卡 ---- */
export function XpWidget({ data }: WidgetProps) {
  const { xp } = data
  return (
    <>
      <div className="db-xp-row">
        <div className="db-lvl">
          <small>LV</small>
          {xp.level}
        </div>
        <div style={{ flex: 1 }}>
          <div className="db-xp-meta">
            <span>
              <b>{xp.total.toLocaleString()}</b> XP
            </span>
            <span>
              距 Lv.{xp.level + 1} 还差 {xp.nextLevelRemaining}
            </span>
          </div>
          <div className="db-xp-track">
            <div className="db-xp-fill" style={{ width: xp.nextLevelProgress + '%' }} />
          </div>
        </div>
      </div>
    </>
  )
}

/* ---- 近7日柱状 ---- */
export function Bars7Widget({ data, now, bindTip }: WidgetProps) {
  const days = data.activity.slice(-7)
  const max = Math.max(...days.map((x) => x.hours), 1)
  const names = ['一', '二', '三', '四', '五', '六', '日']
  return (
    <>
      <div className="db-bars7">
        {days.map((x) => {
          const d = new Date(x.date + 'T00:00:00')
          const isToday = x.date === dayKey(now)
          return (
            <div key={x.date} className={`col ${isToday ? 'today' : ''}`}>
              <i
                style={{ height: (x.hours / max) * 82 + 4 + '%' }}
                {...bindTip(`${fmtDay(d)} · ${x.hours} 小时`)}
              />
              <span>{isToday ? '今天' : names[(d.getDay() + 6) % 7]}</span>
            </div>
          )
        })}
      </div>
    </>
  )
}

import { useRef, useState, type ComponentType } from 'react'
import { SEGMAP, Seg7 } from './CenterToolArea'

/**
 * 交互式教学卡片注册表：引导气泡、卡片收纳、钉住面板共用同一份实现。
 * 课程包预置素材（docs/home-design.md Q9）；正式版本由 Agent 选用、改写、组合。
 */
export interface CardDef {
  title: string
  Body: ComponentType
}

/** 「为什么会跳多数？」按键抖动与消抖对比实验。 */
function DebounceDemo() {
  const [clean, setClean] = useState(false)
  const [count, setCount] = useState(3)
  const [bounce, setBounce] = useState(0)
  const [log, setLog] = useState('还没有按下')

  const press = () => {
    if (clean) {
      setCount((c) => (c + 1) % 16)
      setBounce(0)
      setLog('消抖开：计数 +1（只认稳定后的按下）')
    } else {
      const n = 2 + (count % 3)
      setCount((c) => (c + n) % 16)
      setBounce(n)
      setLog(`无消抖：抖动 ×${n} → 计数 +${n}`)
    }
  }

  return (
    <div>
      <div className="ws-btext" style={{ marginTop: 6, color: 'var(--muted)' }}>
        机械按键接触的瞬间会快速弹跳几次，你的设计把每次弹跳都当成了一次按下。试试看：
      </div>
      <div className="ws-demo">
        <div className="ws-segwrap">
          <Seg7 n={count % 10} tone="card" />
        </div>
        <div>
          <div className="ws-bounces">
            {Array.from({ length: bounce }, (_, i) => (
              <i key={i} style={{ animationDelay: `${i * 0.12}s` }} />
            ))}
          </div>
          <div className="ws-dlog">{log}</div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="ws-dpress" onClick={press}>
          模拟按下按键
        </button>
        <button
          className={clean ? 'ws-dtoggle on' : 'ws-dtoggle'}
          onClick={() => {
            setClean(!clean)
            setBounce(0)
          }}
        >
          <i />
          消抖 {clean ? '开' : '关'}
        </button>
        <button
          className="textbtn"
          onClick={() => {
            setClean(false)
            setCount(3)
            setBounce(0)
            setLog('还没有按下')
          }}
        >
          重置
        </button>
      </div>
    </div>
  )
}

/** 「数码管怎么亮出数字？」数值 → 二进制 → 段码的译码过程。 */
function SegmentsDemo() {
  const [n, setN] = useState(5)
  const bin = n.toString(2).padStart(4, '0')
  // seg[6:0] 按 gfedcba 顺序拼位，与代码里 output reg [6:0] seg 对应
  const segBits = 'gfedcba'
    .split('')
    .map((l) => ((SEGMAP[n] ?? '').includes(l) ? '1' : '0'))
    .join('')

  return (
    <div>
      <div className="ws-btext" style={{ marginTop: 6, color: 'var(--muted)' }}>
        cnt 是 4 位二进制数，数码管不认二进制——中间要一个译码器，把数值翻译成「哪几段亮」。拨动数值看看段码怎么变：
      </div>
      <div className="ws-demo">
        <div className="ws-segwrap">
          <Seg7 n={n} tone="card" />
        </div>
        <div>
          <div className="ws-dlog">
            cnt = {n}（4'b{bin}）
          </div>
          <div className="ws-dlog">seg = 7'b{segBits}（gfedcba）</div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="ws-dpress" onClick={() => setN((v) => (v + 9) % 10)}>
          −1
        </button>
        <button className="ws-dpress" onClick={() => setN((v) => (v + 1) % 10)}>
          +1
        </button>
        <span className="ws-dlog">板子只有一位数码管，任务里显示 cnt 的个位</span>
      </div>
    </div>
  )
}

/** 「复位要不要等时钟？」异步 / 同步复位的时序差别。 */
function ResetDemo() {
  const [sync, setSync] = useState(false)
  const [cnt, setCnt] = useState(9)
  const [log, setLog] = useState('计数器运行中，cnt = 9')
  const timer = useRef<number | undefined>(undefined)

  const restart = () => {
    window.clearTimeout(timer.current)
    setCnt(9)
    setLog('计数器运行中，cnt = 9')
  }

  const pulse = () => {
    window.clearTimeout(timer.current)
    if (!sync) {
      setCnt(0)
      setLog('异步复位：rst_n 一拉低，cnt 立刻清零，不等时钟。')
    } else {
      setLog('同步复位：rst_n 已拉低，cnt 还没动——等下一个时钟上升沿…')
      timer.current = window.setTimeout(() => {
        setCnt(0)
        setLog('时钟上升沿到了，cnt 这才清零。')
      }, 900)
    }
  }

  return (
    <div>
      <div className="ws-btext" style={{ marginTop: 6, color: 'var(--muted)' }}>
        同样是 rst_n 拉低，异步复位立即生效，同步复位要等时钟沿——你的草稿用的是哪种？任务书要求的又是哪种？切一切、按一按感受差别：
      </div>
      <div className="ws-demo">
        <div className="ws-segwrap">
          <Seg7 n={cnt} tone="card" />
        </div>
        <div className="ws-dlog">{log}</div>
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="ws-dpress" onClick={pulse}>
          拉低 rst_n
        </button>
        <button
          className={sync ? 'ws-dtoggle on' : 'ws-dtoggle'}
          onClick={() => {
            setSync(!sync)
            restart()
          }}
        >
          <i />
          同步复位 {sync ? '开' : '关'}
        </button>
        <button className="textbtn" onClick={restart}>
          重新跑到 9
        </button>
      </div>
    </div>
  )
}

export const CARDS: Record<string, CardDef> = {
  debounce: { title: '为什么会跳多数？', Body: DebounceDemo },
  segments: { title: '数码管怎么亮出数字？', Body: SegmentsDemo },
  reset: { title: '复位要不要等时钟？', Body: ResetDemo },
}

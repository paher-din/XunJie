import { useCallback, useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'

/** 刻度行距上限（px）：与 app.css `.msg-rail-tick` 的内联 height 一致。 */
const ITEM_H_MAX = 14
/** 行距下限：消息条数超出导轨高度时向下压，不裁刻度。 */
const ITEM_H_MIN = 5
/** 贴近顶 / 底多少像素算首 / 末条（px）。 */
const EDGE_PX = 56
/** 放大镜阶梯：锚条（指针下那条；无指针时为滚动位置那条）满长，两侧逐级收短（对照 beUI Message Scroller）。 */
const SCALES = [1, 0.68, 0.44, 0.25]
/** 预览卡高度与上下安全边（px）：与 app.css `.msg-rail-card` 一致，用于纵向夹取。 */
const CARD_H = 80
const CARD_SAFE = 8
/** 预览文案截断（字符）：标题一行、回复两行。 */
const TITLE_LEN = 24
const DESC_LEN = 44

interface RailState {
  els: HTMLElement[]
  itemH: number
  railH: number
  visible: boolean
}

/**
 * 消息导航导轨（2026-10-11 用户指定，对照 beUI Message Scroller，落在对话流左侧）：
 * 一条消息一枚刻度，指针悬停满长、邻条按 0.68 / 0.44 / 0.25 逐级收短（放大镜）；
 * 无指针时锚条落在滚动位置那条上（同样满长、两侧逐级收短），不悬停也看得出读到哪。
 * 悬停 / 聚焦出预览卡（本条摘要 + 对侧回复摘要），点击跳到该条；会话没超出一屏整条收隐身。
 * 滚动位置所在条随滚动更新（贴顶 / 贴底吸首末条，中间取视口中心最近）。
 * 刻度取自渲染结果（.chat-message 与 .turn-body / .bubble），流式追加、卡片挂载都自动跟上，
 * 不另立消息快照。跳转的滚动与吸附归 AgentPage（stickRef 那一套），本组件只报「跳哪条」。
 */
export function MessageRail({
  scrollerRef,
  onJump,
}: {
  scrollerRef: RefObject<HTMLDivElement | null>
  /** 跳到某条消息；last 为 true 表示目标是末条（回到底部、重新吸附跟随）。 */
  onJump: (el: HTMLElement, last: boolean) => void
}) {
  const railRef = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<RailState>({ els: [], itemH: ITEM_H_MAX, railH: 0, visible: false })
  const [hover, setHover] = useState<number | null>(null)
  const [focus, setFocus] = useState<number | null>(null)
  const [active, setActive] = useState(-1)

  const sync = useCallback(() => {
    const scroller = scrollerRef.current
    const rail = railRef.current
    if (!scroller || !rail) return
    const els = Array.from(scroller.querySelectorAll<HTMLElement>('.chat-message')).filter(el=>el.getClientRects().length>0)
    const railH = rail.clientHeight
    const itemH = els.length
      ? Math.max(ITEM_H_MIN, Math.min(ITEM_H_MAX, Math.floor(railH / els.length)))
      : ITEM_H_MAX
    const visible = els.length > 1 && scroller.scrollHeight > scroller.clientHeight + 1
    // 流式逐字触发的同步走这里：名单与几何没变就不落 state，导轨不跟着重渲
    setState((prev) =>
      prev.railH === railH &&
      prev.itemH === itemH &&
      prev.visible === visible &&
      prev.els.length === els.length &&
      prev.els.every((el, i) => el === els[i])
        ? prev
        : { els, itemH, railH, visible },
    )
  }, [scrollerRef])

  const updateActive = useCallback(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    const els = Array.from(scroller.querySelectorAll<HTMLElement>('.chat-message')).filter(el=>el.getClientRects().length>0)
    if (els.length === 0) {
      setActive(-1)
      return
    }
    let next = 0
    const fromEnd = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
    if (scroller.scrollTop > EDGE_PX) {
      if (fromEnd <= EDGE_PX) {
        next = els.length - 1
      } else {
        const mid = scroller.getBoundingClientRect().top + scroller.clientHeight / 2
        let nearest = Number.POSITIVE_INFINITY
        els.forEach((el, i) => {
          const rect = el.getBoundingClientRect()
          const distance = Math.abs(rect.top + rect.height / 2 - mid)
          if (distance < nearest) {
            nearest = distance
            next = i
          }
        })
      }
    }
    setActive((current) => (current === next ? current : next))
  }, [scrollerRef])

  // 消息增减 / 卡片挂载（MutationObserver）、尺寸变化（ResizeObserver）与滚动都折进一帧里同步，
  // 流式逐字不各自触发一轮布局读数
  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    const content = scroller.querySelector<HTMLElement>('.chat-inner')
    let frame = 0
    const schedule = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        sync()
        updateActive()
      })
    }
    schedule()
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
    resizeObserver?.observe(scroller)
    if (content) resizeObserver?.observe(content)
    const mutationObserver = typeof MutationObserver === 'undefined' ? null : new MutationObserver(schedule)
    mutationObserver?.observe(scroller, { childList: true, subtree: true, attributes: true, attributeFilter: ['open'] })
    scroller.addEventListener('scroll', schedule, { passive: true })
    return () => {
      if (frame) cancelAnimationFrame(frame)
      resizeObserver?.disconnect()
      mutationObserver?.disconnect()
      scroller.removeEventListener('scroll', schedule)
    }
  }, [scrollerRef, sync, updateActive])

  const jump = (index: number) => {
    const el = state.els[index]
    if (!el) return
    setActive(index)
    onJump(el, index === state.els.length - 1)
  }

  const displayed = hover ?? focus
  // 放大镜的锚：指针 / 焦点优先，空手时落在滚动位置那条（对照 beUI 的 highlightActive）
  const anchor = displayed ?? (active >= 0 ? active : null)
  const shown = displayed === null ? undefined : state.els[displayed]
  const count = state.els.length
  const center = displayed === null ? 0 : (state.railH - count * state.itemH) / 2 + displayed * state.itemH + state.itemH / 2
  const cardY = Math.min(
    Math.max(center, CARD_H / 2 + CARD_SAFE),
    Math.max(CARD_H / 2 + CARD_SAFE, state.railH - CARD_H / 2 - CARD_SAFE),
  )
  const preview = shown ? excerpt(shown, displayed === null ? undefined : state.els[displayed + 1]) : null

  return (
    <div className={'msg-rail' + (state.visible ? '' : ' off')} ref={railRef}>
      <nav
        className="msg-rail-nav"
        aria-label="消息导航"
        onPointerLeave={() => setHover(null)}
      >
        {state.els.map((el, i) => {
          const current = i === active
          return (
            <button
              key={i}
              type="button"
              className={'msg-rail-tick' + (current ? ' active' : '') + (i === anchor ? ' lit' : '')}
              style={{ height: state.itemH }}
              aria-label={`跳到第 ${i + 1} 条消息（${el.classList.contains('user') ? '我' : '学习助手'}）`}
              aria-current={current ? 'true' : undefined}
              onPointerEnter={() => setHover(i)}
              onFocus={(event) => {
                // 只认键盘聚焦：鼠标点击也落焦点，卡片不该一直挂着（对照 beUI 的 :focus-visible 判定）
                if (event.currentTarget.matches(':focus-visible')) setFocus(i)
              }}
              onBlur={() => setFocus(null)}
              onClick={() => jump(i)}
            >
              <i style={{ '--s': scaleAt(i, anchor) } as CSSProperties} aria-hidden="true" />
            </button>
          )
        })}
      </nav>
      <div
        className={'msg-rail-card' + (preview ? ' show' : '')}
        style={{ '--card-y': cardY - CARD_H / 2 + 'px' } as CSSProperties}
        aria-hidden="true"
      >
        <b>{preview?.label}</b>
        {preview?.desc && <span>{preview.desc}</span>}
      </div>
    </div>
  )
}

/** 到锚条的距离查阶梯：锚条满长，两侧按 1 / 0.68 / 0.44 / 0.25 递减；无锚（空会话）一律最短。 */
function scaleAt(index: number, anchor: number | null) {
  if (anchor === null) return SCALES[SCALES.length - 1]
  return SCALES[Math.min(Math.abs(index - anchor), SCALES.length - 1)]
}

function clip(text: string, max: number) {
  return text.length > max ? text.slice(0, max).trimEnd() + '…' : text
}

/** 消息正文取渲染结果：学生消息读气泡，agent 消息读 markdown 正文（卡片、操作条不算正文）。 */
function messageText(el: HTMLElement) {
  const surface = el.classList.contains('user') ? el.querySelector('.bubble') : el.querySelector('.turn-body')
  return (surface?.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/** 预览卡文案：标题 = 本条开头；描述 = 学生消息给下一条回复的摘要，agent 消息给自身余文。 */
function excerpt(el: HTMLElement, next?: HTMLElement) {
  const reply = next && next.classList.contains('agent') ? next : undefined
  const text = messageText(el)
  if (!text) return { label: '等待回复', desc: '' }
  if (text.length <= TITLE_LEN) {
    return { label: text, desc: reply ? clip(messageText(reply), DESC_LEN) : '' }
  }
  return {
    label: clip(text, TITLE_LEN),
    desc: reply ? clip(messageText(reply), DESC_LEN) : clip(text.slice(TITLE_LEN).trim(), DESC_LEN),
  }
}

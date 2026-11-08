import { useEffect, type RefObject } from 'react'

/**
 * 贴底跟随：内容长高时逐帧朝底部滑行，而不是每长一点就把视口搬一次。
 *
 * 一行正文 28px（行高 1.9）、落定那一拍撑出的卡片几百 px——瞬时贴底把它们读成一次次的位移，
 * 就是「正文一跳一跳」和「卡片出来那一下抽」。这里按余距指数逼近（时间常数 TAU，与帧率无关），
 * 一段高度摊成几帧，越接近底越慢。
 *
 * 但「长高」分两种，混在一起处理就会抽：
 * - 追加：新内容长在视线下方，原来的字一动不动。该滑行——把整段位移摊开成一次平稳的向上跟读。
 * - 插入：整块（概念卡）嵌进正文中段，正在读的那行被顶下去几百 px。该当场补上同样的位移——
 *   那一行原地不动，卡片从它上面向上长出来。留着让滑行去追，就是先掉下去再滑回来（实测 436px）。
 * 两者靠视线锚点区分：取滚动内容最末元素所在的那个块，比对它上一帧在文档里的位置。
 * 它被顶下去 = 上方插了东西；它原地不动 = 只是往下长。
 *
 * 只跟「长高」，不跟「离底」：每帧比对新旧底部位置，内容把底缘推下去了才欠下一段跟随，
 * 滑到底之前一直记着这笔账（只在长高那一帧动一下会滑不完）；学生自己上滑不算长高，
 * 否则他一上滑就被自己拽回来。
 *
 * ours（出参）：滑行途中的离底可以上百 px，而对话流用「离底 80px」判定学生接手
 * （AgentPage 的 RELEASE_PX）——不区分就会把滑行读成接手，跟随当场断掉。
 * 每次自己写位置都记进 ours，页面的 onScroll 见位置等于它就知道这一格是自己搬的，跳过判定。
 *
 * 空转不读布局：DOM 或尺寸没变的那一帧直接跳过（读 scrollHeight / rect 是强制布局，
 * 且随历史长度增长），脏了才干活。减少动效时直接落位（⑦ 全局规则的 JS 侧对应）。
 */
const TAU_MS = 90
/** 锚点被顶下这么多才算「上方插了一整块」。
 *  误判的余量很宽：滚动不改文档位置，噪声只有 ±1px，而正文的追加都发生在锚点之下（它的顶边不动），
 *  逐字长出的卡片行则由展开动画摊平（每帧两三个 px）。所以一行的量级就足够断定是插入。 */
const INSERT_PX = 24

const STUCK = { current: true }

/** 滚动内容里最末的一个元素：视线所在处，也是新块插入的下游。 */
function lastLeaf(el: HTMLElement): Element | null {
  let n = el.lastElementChild
  while (n?.lastElementChild) n = n.lastElementChild
  return n
}

export function useFollowBottom({
  scroller,
  stick = STUCK,
  ours,
}: {
  scroller: RefObject<HTMLElement | null>
  /** 是否继续跟：贴底为真，学生上滑接手后为假。 */
  stick?: RefObject<boolean>
  /** 最近一次由本钩子写入的 scrollTop；-1 表示还没写过。 */
  ours?: RefObject<number>
}) {
  useEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    /** 有没有活要干：DOM 变了（含逐字上屏）或尺寸变了（CSS 展开动画撑高不碰 DOM，只有量尺寸看得见）。
     *  没活就不读布局——这一钩子每帧都要摸 scrollHeight 与锚点 rect，历史越长摸得越贵
     *  （DeepTutor 把同样的账写在注释里，并换成了 MutationObserver 驱动）。 */
    let dirty = true
    const mark = () => {
      dirty = true
    }
    const ro = new ResizeObserver(mark)
    const mo = new MutationObserver(mark)
    let raf = 0
    let last = performance.now()
    let target = -1
    let anchor: Element | null = null
    let anchorTop = 0
    /** 欠一段跟随：内容长高时挂上，滑到底才摘。只在长高的那一帧动一下会滑不完（实测落定停在半路）。 */
    let pending = false
    /** 滚动容器可以是空 ref 起步、也可以在会话切换间重挂，所以按帧核对身份而不是只绑一次。 */
    let bound: HTMLElement | null = null
    const rebind = (el: HTMLElement) => {
      ro.disconnect()
      mo.disconnect()
      ro.observe(el)
      if (el.firstElementChild) ro.observe(el.firstElementChild)
      mo.observe(el, { childList: true, subtree: true, characterData: true })
      bound = el
      target = -1
      anchor = null
      pending = true
      dirty = true
    }
    const tick = (now: number) => {
      const dt = now - last
      last = now
      const el = scroller.current
      if (el && el !== bound) rebind(el)
      if (el && (dirty || pending)) {
        dirty = false
        const bottom = el.scrollHeight - el.clientHeight
        // 视线锚点：最末一个元素所在的块（末字 span 会被重挂载换掉，块不会）。
        // 它被顶下去多少 = 上方插进了多大一块。
        if (anchor?.isConnected && stick.current) {
          const moved = anchor.getBoundingClientRect().top + el.scrollTop - anchorTop
          if (moved > INSERT_PX) {
            el.scrollTop += moved
            if (ours) ours.current = el.scrollTop
          }
        }
        anchor = lastLeaf(el)?.parentElement ?? null
        anchorTop = anchor ? anchor.getBoundingClientRect().top + el.scrollTop : 0
        if (target >= 0 && bottom > target + 0.5) pending = true
        target = bottom
        if (pending && stick.current) {
          const gap = bottom - el.scrollTop
          if (gap > 0.5) {
            const before = el.scrollTop
            el.scrollTop += reduce ? gap : gap * (1 - Math.exp(-dt / TAU_MS))
            if (ours) ours.current = el.scrollTop
            // 写不动了就是到底：剩下的那点余距是 clientHeight 取整的零头，
            // 把它一直当欠账，这一钩子会在落定之后每帧白读一次布局（实测 240 次 / 4 秒）
            if (el.scrollTop === before) pending = false
          } else pending = false
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      mo.disconnect()
    }
  }, [scroller, stick, ours])
}

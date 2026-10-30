import { useEffect, useRef, useState } from 'react'

/**
 * 流式匀滑：到达节奏 ≠ 上屏节奏。
 *
 * 模型（这里是适配层）按 token 吐字——一次 1–4 字、间隔有抖动、句末还会停一下。
 * 把每次到达直接当成一次上屏，界面就跟着网络的呼吸一顿一顿。这一层把缓冲里的字
 * 按时间匀出去，token 的抖动被抹平成一条匀速的流。
 *
 * 两个要点：
 * - 用「字数/秒」配时间累加器推进，不是「每帧 N 字」——后者在 60Hz / 120Hz / 掉帧时
 *   速度不一样，屏上的字距会跟着刷新率变；按时间推进在什么屏幕上都是同一条流。
 * - 速度跟着积压走（积压越多走得越快，并有上限），于是突然来一大块（批量到达、
 *   后台标签页被节流后回前台）会自己加速追平，而永远不会越读越 lag。
 * 停止 / 落定 / 文本被截短（改写重发）一律直接对齐全文——半截字留在屏上是错的，不是动画。
 * 减少动效时同样直接对齐（⑦ 全局规则的 JS 侧对应）。
 */
const MIN_CPS = 22
/** 积压每字折算成的字数/秒：积压 4 字 ≈ 88 字/秒。 */
const BACKLOG_GAIN = 22
const MAX_CPS = 260

export function useSmoothStreamText(target: string, streaming: boolean): string {
  const [shown, setShown] = useState(target)
  const targetRef = useRef(target)
  targetRef.current = target
  const shownLenRef = useRef(target.length)
  const reduceRef = useRef<boolean | null>(null)
  if (reduceRef.current === null) {
    reduceRef.current = typeof window === 'undefined' ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
  }

  // 不流式（落定 / 停止 / 翻历史）：直接对齐全文。渲染期改状态 + 这一次返回 target，
  // 于是半截字不会有一帧出现在屏上。
  if (!streaming && shown !== target) {
    shownLenRef.current = target.length
    setShown(target)
  }

  useEffect(() => {
    if (!streaming || reduceRef.current) return
    let raf = 0
    let last = performance.now()
    let carry = 0
    const tick = (now: number) => {
      const dt = Math.min(100, now - last)
      last = now
      const full = targetRef.current
      const n = Math.min(shownLenRef.current, full.length)
      const backlog = full.length - n
      if (backlog > 0) {
        const cps = Math.min(MAX_CPS, Math.max(MIN_CPS, backlog * BACKLOG_GAIN))
        carry += (dt * cps) / 1000
        const step = Math.min(backlog, Math.floor(carry))
        if (step > 0) {
          carry -= step
          shownLenRef.current = n + step
          setShown(full.slice(0, n + step))
        }
      } else {
        carry = 0
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [streaming])

  return streaming && !reduceRef.current ? shown : target
}

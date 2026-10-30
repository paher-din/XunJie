import { useCallback, useEffect, useRef, useState } from 'react'
import type { ButtonHTMLAttributes } from 'react'
import type { SproutTool } from '../brand/artwork'
import { MOTION_DURATION } from '../brand/motion'
import { MascotSvg } from './Mascot'

export interface CompanionCue { key: string; motion: 'invite' | 'celebrate'; delay?: number }

/** 首页闲置小动作轮换：换妆造（道具）穿插偶尔挥手 / 轻跳；节奏松，靠余光可察觉但不抢注意力。 */
const AMBIENT_ACTS: { tool: SproutTool; cue?: CompanionCue['motion']; holdMs: number }[] = [
  { tool: 'none', holdMs: 7000 },
  { tool: 'glasses', holdMs: 6000 },
  { tool: 'none', cue: 'invite', holdMs: 7000 },
  { tool: 'pencil', holdMs: 6000 },
  { tool: 'none', holdMs: 8000 },
  { tool: 'pointer', cue: 'invite', holdMs: 7000 },
  { tool: 'none', holdMs: 7000 },
  { tool: 'chalk', holdMs: 6000 },
  { tool: 'none', cue: 'celebrate', holdMs: 8000 },
]

/** Product events own the gesture; the mascot owns articulation and reduced motion. */
export function CompanionButton({ attention = false, working = false, tool = 'none', cue, ambient = false,
  children, ...button }: ButtonHTMLAttributes<HTMLButtonElement> & {
  attention?: boolean; working?: boolean; tool?: SproutTool; cue?: CompanionCue
  /** 闲置时轮换小动作与妆造；忙碌、对话打开、页面隐藏或减少动效时保持安静待命。 */
  ambient?: boolean
}) {
  const context = `${attention}:${working}:${tool}`
  const [feedback, setFeedback] = useState<{ motion: CompanionCue['motion']; context: string; replay: number } | null>(null)
  const [ambientIdx, setAmbientIdx] = useState(0)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const lastGreeting = useRef(-Infinity)
  const lastCue = useRef<string | undefined>(undefined)
  const revision = useRef(0)
  const play = useCallback((motion: CompanionCue['motion']) => {
    clearTimeout(timer.current)
    setFeedback({ motion, context, replay: ++revision.current })
    timer.current = setTimeout(() => setFeedback(null), MOTION_DURATION[motion])
  }, [context])
  useEffect(() => () => clearTimeout(timer.current), [])
  useEffect(() => {
    clearTimeout(timer.current)
    setFeedback(null)
  }, [context])
  useEffect(() => {
    if (!cue || cue.key === lastCue.current) return
    if (attention || working || document.hidden) { lastCue.current = cue.key; return }
    const pending = setTimeout(() => {
      lastCue.current = cue.key
      if (!document.hidden) { lastGreeting.current = performance.now(); play(cue.motion) }
    }, cue.delay ?? 0)
    return () => clearTimeout(pending)
  }, [cue?.key, cue?.motion, cue?.delay, attention, working, play])
  useEffect(() => {
    if (!ambient || attention || working) return
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
    let timer: ReturnType<typeof setTimeout>
    const advance = (i: number) => {
      timer = setTimeout(() => {
        if (!document.hidden) {
          const next = (i + 1) % AMBIENT_ACTS.length
          setAmbientIdx(next)
          const act = AMBIENT_ACTS[next]
          const now = performance.now()
          if (act.cue && now - lastGreeting.current >= 8000) {
            lastGreeting.current = now
            play(act.cue)
          }
          i = next
        }
        advance(i)
      }, AMBIENT_ACTS[i].holdMs)
    }
    advance(ambientIdx)
    return () => clearTimeout(timer)
    // ambientIdx 只作起步；轮换由闭包推进，不重复订阅
  }, [ambient, attention, working, play]) // eslint-disable-line react-hooks/exhaustive-deps
  const greet = () => {
    const now = performance.now()
    if (attention || working || feedback?.context === context || now - lastGreeting.current < 8000) return
    lastGreeting.current = now
    play('invite')
  }
  const gesture = feedback?.context === context ? feedback : null
  return <button {...button} type={button.type ?? 'button'}
    onPointerEnter={event => { button.onPointerEnter?.(event); if (event.pointerType === 'mouse') greet() }}
    onFocus={event => { button.onFocus?.(event); if (event.currentTarget.matches(':focus-visible')) greet() }}>
    <MascotSvg tool={working ? 'glasses' : (ambient && !attention ? AMBIENT_ACTS[ambientIdx].tool : tool)} motion={gesture?.motion ?? (attention || working ? 'think' : 'idle')} replay={gesture?.replay ?? revision.current} />
    {children}
  </button>
}

import { Icon, IconText } from '../../icons'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

/**
 * 左侧竖向胶囊导航 + gooey 弹出（形态与动效在 docs/prototypes/workspace/taskinfo.html 定稿）。
 * 分层实现，避免「色块→卡片→内容」串行换场的卡顿：
 * - crisp 内容层：真卡片始终在 DOM 里，自身用 WAAPI 从按钮位置果冻形变飞出/飞回，文字全程清晰；
 * - goo 剪影层：只在飞行期叠加液滴（SVG blur+contrast filter），舞台裁到动画包围盒而非全屏，
 *   液滴在落定前淡出，不与真卡竞争。
 * 动画与内容并行推进，无交换帧；prefers-reduced-motion 时退化为直接显隐。
 */

const JELLY = 'cubic-bezier(.3,.9,.25,1)'
const EASE_BACK = 'cubic-bezier(.5,0,.75,.4)'
const PASTEL = ['#c9b8f5', '#a9e7d8', '#f9e2a0', '#f5c8d8']
const ROW_H = 52
const ROW_GAP = 10
const POP_LEFT = 62
const OPEN_MS = 440
const CLOSE_MS = 300
/** 液滴相对真卡的滞后与收缩：始终藏在卡内，只在卡片间缝隙经 goo filter 融合成液桥 */
const LAG_MS = 35
const SHRINK = 0.94

/** 打开几何关键帧（crisp 与 goo 共用同一组数值，几何锁步；goo 版缩小+末尾淡出） */
function openFrames(dx: number, dy: number, sx: number, sy: number, radius: string, k: number, goo: boolean): Keyframe[] {
  const frames: Keyframe[] = [
    { transform: `translate(${dx}px,${dy}px) scale(${sx * k},${sy * k})`, borderRadius: '999px' },
    { transform: `translate(${dx * 0.42}px,${dy * 0.42}px) scale(${(sx + (1 - sx) * 0.52) * k},${(sy + (1 - sy) * 0.26) * k})`, offset: 0.4 },
    { transform: `translate(${dx * 0.06}px,${dy * 0.06}px) scale(${1.03 * k},${0.97 * k})`, borderRadius: radius, offset: 0.68 },
    { transform: `translate(0,0) scale(${k},${k})` },
  ]
  if (goo) {
    frames[0].opacity = 1
    frames.splice(3, 0, { transform: `translate(0,0) scale(${k},${k})`, opacity: 1, offset: 0.82 })
    frames[4].opacity = 0
  }
  return frames
}

/** 收回几何关键帧（同上，反向；圆角保持 radius 直到末帧才收成胶囊；
 *  goo 版与真卡零时差同形状、只在最后 18% 淡出，永远藏在卡内） */
function closeFrames(dx: number, dy: number, sx: number, sy: number, radius: string, k: number, goo: boolean): Keyframe[] {
  const frames: Keyframe[] = [
    { transform: `translate(0,0) scale(${k},${k})`, borderRadius: radius },
    { transform: `translate(${dx * 0.04}px,${dy * 0.04}px) scale(${0.97 * k},${1.03 * k})`, borderRadius: radius, offset: 0.25 },
    { transform: `translate(${dx * 0.5}px,${dy * 0.5}px) scale(${((1 - sx) * 0.5 + sx) * k},${((1 - sy) * 0.32 + sy) * k})`, borderRadius: radius, offset: 0.62 },
    { transform: `translate(${dx}px,${dy}px) scale(${sx * k},${sy * k})`, borderRadius: '999px' },
  ]
  if (goo) {
    frames[0].opacity = 1
    frames.splice(3, 0, { transform: frames[3].transform, opacity: 1, offset: 0.82 })
    frames[4].opacity = 0
  }
  return frames
}

interface Box {
  left: number
  top: number
  width: number
  height: number
}
interface BtnCenter {
  x: number
  y: number
  d: number
}

function reducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function centerOf(btn: HTMLElement): BtnCenter {
  const r = btn.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, d: r.width }
}

export interface StashItem {
  key: string
  title: string
  /** 生成卡：胶囊收纳列表显示静态快照封面 + 「已暂停」（冻结 = iframe 移除，取出才续跑）。 */
  gen?: { claimSim: boolean; version: number }
}

export function SideDock({
  taskInfo,
  stash,
  onPin,
  onOpen,
  onToast,
}: {
  /** 任务信息卡内容（TaskInfo）。 */
  taskInfo: ReactNode
  /** 已收纳卡片；点「钉住」交给 onPin，生成卡另有「打开」（在工具区重开标签）。 */
  stash: StashItem[]
  onPin: (key: string) => void
  /** 打开生成卡的工具区标签（重开视图，状态按快照续跑）。 */
  onOpen?: (key: string) => void
  onToast: (msg: string) => void
}) {
  const [open, setOpen] = useState<'task' | 'stash' | null>(null)
  /** 收纳弹出行的垂直锚点：「卡片收纳」按钮中心的视口 y（打开时快照）。 */
  const [anchorY, setAnchorY] = useState<number | null>(null)
  const taskBtnRef = useRef<HTMLButtonElement>(null)
  const stashBtnRef = useRef<HTMLButtonElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const itemEls = useRef<(HTMLElement | null)[]>([])
  const stageRef = useRef<HTMLDivElement>(null)
  const genRef = useRef(0)

  /* ---- goo 剪影层（命令式，瞬态装饰，不进 React 状态） ---- */

  function clearStage() {
    const stage = stageRef.current
    if (stage) {
      stage.innerHTML = ''
      stage.style.display = 'none'
    }
  }

  /** 把舞台裁到按钮 + 所有目标的包围盒，返回舞台原点（viewport 坐标）。 */
  function fitStage(boxes: Box[]) {
    const stage = stageRef.current!
    const pad = 36
    const left = Math.min(...boxes.map((b) => b.left)) - pad
    const top = Math.min(...boxes.map((b) => b.top)) - pad
    Object.assign(stage.style, {
      display: 'block',
      left: left + 'px',
      top: top + 'px',
      width: Math.max(...boxes.map((b) => b.left + b.width)) - left + pad + 'px',
      height: Math.max(...boxes.map((b) => b.top + b.height)) - top + pad + 'px',
    })
    return { left, top }
  }

  function playGoo(bc: BtnCenter, targets: { box: Box; radius: number; color: string }[], reverse: boolean) {
    const stage = stageRef.current
    if (!stage) return
    stage.innerHTML = ''
    const origin = fitStage([...targets.map((t) => t.box), { left: bc.x - 15, top: bc.y - 15, width: 30, height: 30 }])
    targets.forEach((t, i) => {
      const b = document.createElement('div')
      b.className = 'ws-gooblob'
      const rel = { left: t.box.left - origin.left, top: t.box.top - origin.top, width: t.box.width, height: t.box.height }
      Object.assign(b.style, {
        left: rel.left + 'px',
        top: rel.top + 'px',
        width: rel.width + 'px',
        height: rel.height + 'px',
        borderRadius: t.radius + 'px',
        background: t.color,
      })
      stage.appendChild(b)
      const dx = bc.x - origin.left - (rel.left + rel.width / 2)
      const dy = bc.y - origin.top - (rel.top + rel.height / 2)
      const sx = bc.d / rel.width
      const sy = bc.d / rel.height
      // 收回时零时差同形状：液滴完全藏在真卡剪影内，只在多卡汇聚的缝隙里融合成液桥。
      // fill 必须 both——backwards 在动画结束后不保持末帧，液滴会回弹成全尺寸色块直到舞台被清
      if (!reverse) {
        b.animate(openFrames(dx, dy, sx, sy, t.radius + 'px', SHRINK, true), {
          duration: OPEN_MS,
          delay: i * 90 + LAG_MS,
          easing: JELLY,
          fill: 'both',
        })
      } else {
        b.animate(closeFrames(dx, dy, sx, sy, t.radius + 'px', SHRINK, true), {
          duration: CLOSE_MS,
          delay: i * 45,
          easing: EASE_BACK,
          fill: 'both',
        })
      }
    })
  }

  /* ---- crisp 内容层：真卡片直接从按钮果冻飞出 ---- */

  function flyIn(el: HTMLElement, bc: BtnCenter, rect: Box, radius: string, delay: number) {
    el.getAnimations().forEach((a) => a.cancel())
    const dx = bc.x - (rect.left + rect.width / 2)
    const dy = bc.y - (rect.top + rect.height / 2)
    el.animate(openFrames(dx, dy, bc.d / rect.width, bc.d / rect.height, radius, 1, false), {
      duration: OPEN_MS,
      delay,
      easing: JELLY,
      fill: 'backwards',
    })
  }

  useLayoutEffect(() => {
    if (!open) return
    const btn = (open === 'task' ? taskBtnRef : stashBtnRef).current
    if (!btn) return
    // 弹出卡锚定胶囊按钮（容器跟随全局侧栏），不要按视口硬编码——否则侧栏在时卡片与胶囊错位
    const popLeft = Math.round(btn.getBoundingClientRect().right + 14)
    if (open === 'task') {
      const card = cardRef.current
      if (!card) return
      card.style.left = popLeft + 'px'
      card.style.top = Math.round(window.innerHeight / 2 - card.offsetHeight / 2) + 'px'
    } else {
      itemEls.current.forEach((el) => {
        if (el) el.style.left = popLeft + 'px'
      })
    }
    if (reducedMotion()) return
    genRef.current += 1
    const gen = genRef.current
    const bc = centerOf(btn)
    let blobCount = 1
    if (open === 'task') {
      const card = cardRef.current!
      const r = card.getBoundingClientRect()
      flyIn(card, bc, r, '18px', 0)
      playGoo(bc, [{ box: r, radius: 18, color: '#d9f273' }], false)
    } else {
      const targets = itemEls.current.flatMap((el, i) =>
        el ? [{ el, box: el.getBoundingClientRect(), color: PASTEL[i % PASTEL.length] }] : [],
      )
      blobCount = targets.length
      targets.forEach((t, i) => flyIn(t.el, bc, t.box, '14px', i * 90))
      playGoo(bc, targets.map((t) => ({ box: t.box, radius: 14, color: t.color })), false)
    }
    // 液滴末帧已是透明（fill:both 保持），落定后清掉舞台，避免滤镜层常驻参与合成
    window.setTimeout(() => {
      if (genRef.current === gen) clearStage()
    }, OPEN_MS + (blobCount - 1) * 90 + LAG_MS + 60)
  }, [open])

  /* ---- 关闭：真卡飞回按钮，液滴回流，结束后卸载 ---- */

  const close = (animated: boolean) => {
    const kind = open
    if (!kind) return
    genRef.current += 1
    const gen = genRef.current
    const btn = (kind === 'task' ? taskBtnRef : stashBtnRef).current
    const els = kind === 'task' ? [cardRef.current] : itemEls.current.slice()
    if (!animated || reducedMotion() || !btn || els.some((el) => !el)) {
      setOpen(null)
      clearStage()
      return
    }
    const bc = centerOf(btn)
    const targets = els.map((el, i) => ({
      el: el!,
      box: el!.getBoundingClientRect(),
      color: kind === 'task' ? '#d9f273' : PASTEL[i % PASTEL.length],
    }))
    playGoo(bc, targets.map((t) => ({ box: t.box, radius: kind === 'task' ? 18 : 14, color: t.color })), true)
    targets.forEach((t, i) => {
      t.el.getAnimations().forEach((a) => a.cancel())
      const dx = bc.x - (t.box.left + t.box.width / 2)
      const dy = bc.y - (t.box.top + t.box.height / 2)
      t.el.animate(closeFrames(dx, dy, bc.d / t.box.width, bc.d / t.box.height, kind === 'task' ? '18px' : '14px', 1, false), {
        duration: CLOSE_MS,
        delay: i * 45,
        easing: EASE_BACK,
        fill: 'forwards',
      })
    })
    window.setTimeout(
      () => {
        if (genRef.current !== gen) return
        setOpen(null)
        clearStage()
      },
      CLOSE_MS + (targets.length - 1) * 45 + LAG_MS + 30,
    )
  }

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(true)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  // 收纳卡片被钉完时自动收起
  useEffect(() => {
    if (open === 'stash' && stash.length === 0) {
      setOpen(null)
      clearStage()
    }
  }, [open, stash.length])

  function clickTask() {
    if (open === 'task') close(true)
    else setOpen('task')
  }

  function clickStash() {
    if (open === 'stash') {
      close(true)
      return
    }
    if (stash.length === 0) {
      onToast('还没有收纳的卡片——引导气泡里点「⧉ 收纳」试试')
      return
    }
    // 弹出行组垂直居中于「卡片收纳」按钮，而不是视口
    const r = stashBtnRef.current?.getBoundingClientRect()
    if (r) setAnchorY(r.top + r.height / 2)
    setOpen('stash')
  }

  const totalH = stash.length * ROW_H + (stash.length - 1) * ROW_GAP
  const top0 = Math.max(12, Math.round((anchorY ?? window.innerHeight / 2) - totalH / 2))

  return (
    <>
      <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
        <defs>
          <filter id="ws-goo">
            <feGaussianBlur in="SourceGraphic" stdDeviation="7" result="b" />
            <feColorMatrix in="b" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -8" />
          </filter>
        </defs>
      </svg>
      <nav className="ws-dock" aria-label="工作区辅助">
        <button
          ref={taskBtnRef}
          className={open === 'task' ? 'ws-dbtn on' : 'ws-dbtn'}
          data-tip="任务信息"
          aria-label="任务信息"
          onClick={clickTask}
        >
          <Icon name="clipboard-text" size={22} />
        </button>
        <button
          ref={stashBtnRef}
          className={open === 'stash' ? 'ws-dbtn on' : 'ws-dbtn'}
          data-tip="卡片收纳"
          aria-label="卡片收纳"
          onClick={clickStash}
        >
          <Icon name="archive" size={22} />
          {stash.length > 0 && <span className="ws-dock-badge">{stash.length}</span>}
        </button>
      </nav>
      <div ref={stageRef} className="ws-goostage" style={{ display: 'none' }} />
      {open && <div className="ws-popveil" onClick={() => close(true)} />}
      {open === 'task' && (
        <div ref={cardRef} className="ws-popcard">
          <button className="ws-popx" onClick={() => close(true)} aria-label="关闭">
            <Icon name="close" />
          </button>
          {taskInfo}
        </div>
      )}
      {open === 'stash' &&
        stash.map((it, i) => (
          <div
            key={it.key}
            ref={(el) => {
              itemEls.current[i] = el
            }}
            className={it.gen ? 'ws-popstash gen' : 'ws-popstash'}
            style={{ left: POP_LEFT, top: top0 + i * (ROW_H + ROW_GAP) }}
          >
            {it.gen ? (
              <>
                <span className="ws-gcover" aria-hidden="true">
                  <Icon name="play-circle" size={16} />
                  <span className="ws-gcover-meta">v{it.gen.version}</span>
                </span>
                <span className="nm">
                  {it.title}
                  <em className="ws-gpaused">已暂停</em>
                </span>
                {onOpen && (
                  <button
                    className="open"
                    onClick={() => {
                      onOpen(it.key)
                    }}
                  >
                    <IconText name="arrow-right" position="end">打开</IconText>
                  </button>
                )}
                <button className="pin" onClick={() => onPin(it.key)}>
                  <IconText name="pin" position="end">钉住</IconText>
                </button>
              </>
            ) : (
              <>
                <span className="dot" style={{ background: PASTEL[i % PASTEL.length] }} />
                <span className="nm">{it.title}</span>
                <button className="pin" onClick={() => onPin(it.key)}>
                  <IconText name="pin" position="end">钉住</IconText>
                </button>
              </>
            )}
          </div>
        ))}
    </>
  )
}

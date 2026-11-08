import type { SproutMotion, SproutTool } from './artwork'

export const MOTION_DURATION: Record<SproutMotion, number> = { none: 0, idle: 12400, think: 7600, invite: 1600, celebrate: 1660, equip: 1000 }
export type RigPart = 'root' | 'torso' | 'stem' | 'leafLeft' | 'leafRight' | 'handLeft' | 'handRight' | 'footLeft' | 'footRight' | 'face' | 'eyeLeft' | 'eyeRight'
export interface RigPose {
  lift: number; turn: number; stretch: number; lean: number; stem: number
  leafLeft: number; leafRight: number; handLeft: number; handRight: number
  footLeft: number; footRight: number; eyeX: number; eyeY: number; lidLeft: number; lidRight: number
}
export const REST: RigPose = { lift: 0, turn: 0, stretch: 1, lean: 0, stem: 0, leafLeft: 0, leafRight: 0, handLeft: 0, handRight: 0, footLeft: 0, footRight: 0, eyeX: 0, eyeY: 0, lidLeft: 1, lidRight: 1 }
type Ease = 'smooth' | 'in' | 'out' | 'linear'
type Key = readonly [ms: number, value: number, easing?: Ease]
const ease = (x: number, kind: Ease = 'smooth') => kind === 'linear' ? x : kind === 'in' ? x * x : kind === 'out' ? 1 - (1 - x) ** 2 : x * x * (3 - 2 * x)
function track(t: number, keys: readonly Key[]) {
  if (t <= keys[0][0]) return keys[0][1]
  for (let i = 1; i < keys.length; i++) {
    const [end, value, easing] = keys[i]
    const [start, previous] = keys[i - 1]
    if (t <= end) return previous + (value - previous) * ease((t - start) / (end - start), easing)
  }
  return keys[keys.length - 1][1]
}
const blinkAt = (t: number, start: number) => track(t, [[start, 1], [start + 60, .045, 'in'], [start + 92, .045], [start + 205, 1, 'out']])
function blink(t: number) {
  const phase = t % 12400
  return Math.min(blinkAt(phase, 2280), blinkAt(phase, 6660), blinkAt(phase, 6960))
}

/** Grounded base motion and finite acting are separate channels; props share their hand's joint. */
export function sampleMotion(motion: SproutMotion, elapsed: number, life: number, tool: SproutTool): RigPose {
  if (motion === 'none') return { ...REST }
  const finite = motion === 'invite' || motion === 'celebrate' || motion === 'equip'
  if (finite && elapsed >= MOTION_DURATION[motion]) return sampleMotion('idle', elapsed, life, tool)
  const p = { ...REST }
  const focused = motion === 'think'
  const baseTime = focused ? elapsed : life
  const period = focused ? MOTION_DURATION.think : 6200
  const breath = (1 - Math.cos(baseTime / period * Math.PI * 2)) / 2
  p.stretch = 1 + breath * (focused ? .009 : .016)
  p.stem = Math.sin(baseTime / period * Math.PI * 2) * .7
  p.leafLeft = Math.sin((baseTime - 100) / period * Math.PI * 2) * 1.7
  p.leafRight = Math.sin((baseTime - 240) / period * Math.PI * 2) * 2.2
  p.handLeft = Math.sin((baseTime - 160) / period * Math.PI * 2) * 1.6
  p.handRight = -Math.sin((baseTime - 280) / period * Math.PI * 2) * 1.9
  p.lidLeft = blink(focused ? elapsed % MOTION_DURATION.think : life)
  p.lidRight = blink((focused ? elapsed % MOTION_DURATION.think : life) - 7)
  if (motion === 'idle') {
    const t = life % MOTION_DURATION.idle
    // A small, occasional perk with stillness around it; not an endless whole-body wobble.
    p.leafLeft += track(t, [[0, 0], [1150, 0], [1340, -5], [1580, 2.5], [1920, -1], [2350, 0]])
    p.leafRight += track(t, [[0, 0], [1240, 0], [1450, 7.2], [1730, -3.2], [2050, 1.1], [2480, 0]])
    return p
  }
  if (focused) {
    const t = elapsed % MOTION_DURATION.think
    p.lean = track(t, [[0, 0], [420, -1.6], [2360, -1.6], [3400, -.7], [5900, -.7], [7140, 0], [7600, 0]])
    p.stem += track(t, [[0, 0], [170, 0], [640, -2], [2800, -2], [3720, .4], [6500, .4], [7420, 0]])
    p.leafLeft += track(t, [[0, 0], [250, 0], [820, -4], [2550, -4], [3200, 1], [4180, -.8], [7380, 0]])
    p.leafRight += track(t, [[0, 0], [330, 0], [980, 9], [2710, 9], [3460, -2], [4230, 2], [7560, 0]])
    p.handRight += track(t, [[0, 0], [420, -19], [2860, -19], [3900, -10], [6460, -10], [7460, 0]])
    p.eyeX = track(t, [[0, 0], [160, -6], [2670, -6], [3150, 4], [5560, 4], [6180, 0]])
    p.eyeY = track(t, [[0, 0], [160, -3], [2970, -3], [3300, 1], [6180, 0]])
  } else if (motion === 'invite' && elapsed < MOTION_DURATION.invite) {
    const t = elapsed
    p.lean += track(t, [[0, 0], [110, 1.1], [320, -1.6, 'out'], [620, -1.1], [1000, .4], [1390, 0]])
    p.stretch += track(t, [[0, 0], [115, -.013], [310, .014], [670, .008], [1150, 0]])
    p.handRight += track(t, [[0, 0], [110, 5], [290, -42, 'out'], [430, -25], [575, -47], [730, -24], [910, -36], [1230, 0]])
    p.handLeft += track(t, [[0, 0], [170, 0], [390, 10], [680, 5], [1160, 0]])
    p.stem += track(t, [[0, 0], [130, 1], [390, -2.5], [800, 1.1], [1260, 0]])
    p.leafLeft += track(t, [[0, 0], [140, 2], [370, -9], [650, 5], [980, -2.5], [1370, 0]])
    p.leafRight += track(t, [[0, 0], [215, -2], [465, 13], [760, -6], [1080, 2.3], [1550, 0]])
    p.eyeX = track(t, [[0, 0], [120, 4], [730, 4], [1270, 0]])
  } else if (motion === 'celebrate' && elapsed < MOTION_DURATION.celebrate) {
    const t = elapsed
    p.lift = track(t, [[0, 0], [145, 0], [370, -104, 'out'], [440, -108], [690, 0, 'in'], [1660, 0]])
    p.turn = track(t, [[0, 0], [145, .6], [360, -1.1], [690, 0], [1050, 0]])
    p.stretch += track(t, [[0, 0], [140, -.061, 'out'], [270, .052, 'out'], [460, .017], [660, 0], [775, -.057, 'out'], [980, .014], [1200, 0]])
    p.handLeft += track(t, [[0, 0], [140, -6], [330, 24], [470, 21], [740, -7], [1000, 3], [1420, 0]])
    p.handRight += track(t, [[0, 0], [150, 6], [360, -28], [490, -24], [760, 8], [1080, -3], [1460, 0]])
    p.footLeft = track(t, [[0, 0], [190, 0], [350, -13], [510, -7], [660, 0], [1660, 0]])
    p.footRight = track(t, [[0, 0], [220, 0], [390, 16], [540, 5], [680, 0], [1660, 0]])
    p.stem += track(t, [[0, 0], [190, 2], [370, -3], [720, 4.5], [1020, -1.5], [1390, 0]])
    p.leafLeft += track(t, [[0, 0], [145, 3], [390, -13], [650, -5], [835, 10], [1080, -4], [1430, 0]])
    p.leafRight += track(t, [[0, 0], [215, -2], [475, 16], [730, 5], [930, -11], [1210, 4], [1620, 0]])
    p.lidLeft = Math.min(p.lidLeft, blinkAt(t, 705))
    p.lidRight = Math.min(p.lidRight, blinkAt(t, 712))
  } else if (motion === 'equip' && elapsed < MOTION_DURATION.equip) {
    const t = elapsed
    // 俯身取物 → 举手亮出 → 收势回休息位；眼神先随手下探、亮出时抬起并眨眼。
    p.handLeft += track(t, [[0, 0], [120, -2], [280, -13, 'out'], [560, 15], [760, 6], [1000, 0]])
    p.handRight += track(t, [[0, 0], [120, 2], [280, 13, 'out'], [560, -15], [760, -6], [1000, 0]])
    p.lean += track(t, [[0, 0], [140, -.6], [280, -1.6], [560, .9], [800, .3], [1000, 0]])
    p.stretch += track(t, [[0, 0], [140, -.004], [280, -.016, 'out'], [560, .014], [800, .004], [1000, 0]])
    p.stem += track(t, [[0, 0], [150, .6], [300, 1.8], [580, -1.2], [820, -.4], [1000, 0]])
    p.leafLeft += track(t, [[0, 0], [140, 1.5], [300, 4], [580, -5], [800, -2], [1000, 0]])
    p.leafRight += track(t, [[0, 0], [150, -2], [310, -5], [590, 6], [810, 2.5], [1000, 0]])
    p.eyeY = track(t, [[0, 0], [160, 2], [300, 4.5], [560, -2], [820, 0], [1000, 0]])
    p.lidLeft = Math.min(p.lidLeft, blinkAt(t, 560))
    p.lidRight = Math.min(p.lidRight, blinkAt(t, 568))
  }
  // A board stays controlled; its hand must never perform the free-hand wave.
  if (tool === 'chalk') p.handRight *= .12
  if (finite) {
    // Join the actual idle phase before the state changes. Returning to a fixed
    // neutral pose would jump when the independent idle leaf perk is in progress.
    const remaining = MOTION_DURATION[motion] - elapsed
    if (remaining < 220) return blendPose(p, sampleMotion('idle', elapsed, life, tool), 1 - remaining / 220)
  }
  return p
}

export function staticPose(motion: SproutMotion, tool: SproutTool): RigPose {
  const p = { ...REST }
  if (motion === 'think') Object.assign(p, { leafLeft: -2, leafRight: 5, eyeX: -3, eyeY: -1 })
  if (motion === 'invite') Object.assign(p, { handRight: tool === 'chalk' ? -3 : -24, leafLeft: -3, leafRight: 5 })
  if (motion === 'celebrate') Object.assign(p, { leafLeft: -5, leafRight: 7, handLeft: 8, handRight: tool === 'chalk' ? -2 : -10 })
  if (motion === 'equip') Object.assign(p, { handLeft: -10, handRight: 10, lean: -1, eyeY: 3 })
  return p
}
export function blendPose(from: RigPose, to: RigPose, progress: number): RigPose {
  const t = ease(Math.max(0, Math.min(1, progress)))
  return Object.fromEntries(Object.keys(REST).map(key => {
    const k = key as keyof RigPose
    return [key, from[k] + (to[k] - from[k]) * t]
  })) as unknown as RigPose
}
const n = (value: number) => Number(value.toFixed(5))
const around = (x: number, y: number, inner: string) => `translate(${x} ${y}) ${inner} translate(${-x} ${-y})`
export function poseTransforms(p: RigPose): Record<RigPart, string> {
  const sy = p.stretch, sx = 1 / Math.sqrt(sy)
  const rigid = `scale(${n(1 / sx)} ${n(1 / sy)})`
  return {
    root: `translate(0 ${n(p.lift)}) rotate(${n(p.turn)} 650 1145)`,
    torso: around(650, 1125, `rotate(${n(p.lean)}) scale(${n(sx)} ${n(sy)})`),
    stem: around(703, 434, `${rigid} rotate(${n(p.stem)})`),
    leafLeft: `rotate(${n(p.leafLeft)} 692 406)`,
    leafRight: `rotate(${n(p.leafRight)} 711 406)`,
    handLeft: around(388, 822, `${rigid} rotate(${n(p.handLeft)})`),
    handRight: around(939, 918, `${rigid} rotate(${n(p.handRight)})`),
    footLeft: `rotate(${n(p.footLeft)} 526 1146)`,
    footRight: `rotate(${n(p.footRight)} 769 1166)`,
    face: around(689, 725, rigid),
    // Reduce the original eye stagger after straightening the body. Blink along
    // each corrected eye's own axis, preserving its original texture and highlight.
    eyeLeft: `translate(${n(p.eyeX)} ${n(p.eyeY + 11)}) ${around(594, 700, `rotate(-10) scale(1 ${n(p.lidLeft)})`)}`,
    eyeRight: `translate(${n(p.eyeX)} ${n(p.eyeY - 11)}) ${around(785, 752, `rotate(-10) scale(1 ${n(p.lidRight)})`)}`,
  }
}

import { describe, expect, it } from 'vitest'
import { blendPose, MOTION_DURATION, REST, sampleMotion, staticPose } from './motion'
import type { SproutMotion, SproutTool } from './artwork'

const motions: SproutMotion[] = ['none', 'idle', 'think', 'invite', 'celebrate', 'equip']
const tools: SproutTool[] = ['none', 'glasses', 'pencil', 'pointer', 'chalk']
describe('sprout acting contract', () => {
  it('keeps standing reactions grounded over repeated cycles', () => {
    for (const motion of ['idle', 'think', 'invite'] as const) for (let t = 0; t < 40000; t += 137) {
      const pose = sampleMotion(motion, t, t, 'none')
      expect([pose.lift, pose.footLeft, pose.footRight]).toEqual([0, 0, 0])
    }
  })
  it('makes the leaf response readable at the 54px entry size and follows left with right', () => {
    const frames = Array.from({ length: 61 }, (_, i) => sampleMotion('invite', i * 10, 0, 'none'))
    const leftPeak = frames.reduce((best, p, i) => p.leafLeft < frames[best].leafLeft ? i : best, 0)
    const rightPeak = frames.reduce((best, p, i) => p.leafRight > frames[best].leafRight ? i : best, 0)
    expect(leftPeak).toBeLessThan(rightPeak)
    const angles = frames.map(p => p.leafRight)
    const range = (Math.max(...angles) - Math.min(...angles)) * Math.PI / 180
    const tipTravel = 2 * Math.sin(range / 2) * Math.hypot(940 - 711, 100 - 406) * 54 / 1200
    expect(tipTravel).toBeGreaterThan(3)
  })
  it('leaves the floor during celebration and finishes at the original floor, without a hidden second jump', () => {
    const lift = Array.from({ length: 167 }, (_, i) => sampleMotion('celebrate', i * 10, 0, 'none').lift)
    expect(Math.min(...lift)).toBeLessThan(-90)
    const departures = lift.filter((y, i) => i > 0 && y < 0 && lift[i - 1] === 0)
    expect(departures).toHaveLength(1)
    for (const t of [MOTION_DURATION.celebrate, 5000, 18000]) {
      const pose = sampleMotion('celebrate', t, t, 'none')
      expect([pose.lift, pose.footLeft, pose.footRight]).toEqual([0, 0, 0])
    }
  })
  it('keeps the board hand controlled even during the strongest free-hand greeting', () => {
    for (let t = 0; t <= MOTION_DURATION.invite; t += 10) expect(Math.abs(sampleMotion('invite', t, t, 'chalk').handRight)).toBeLessThan(7)
  })
  it('equip dips both hands to fetch, raises them to present, and never leaves the floor', () => {
    const dip = sampleMotion('equip', 280, 280, 'none')
    expect(dip.handLeft).toBeLessThan(-8)
    expect(dip.handRight).toBeGreaterThan(8)
    const present = sampleMotion('equip', 560, 560, 'none')
    expect(present.handLeft).toBeGreaterThan(8)
    expect(present.handRight).toBeLessThan(-8)
    for (let t = 0; t <= MOTION_DURATION.equip; t += 20) {
      const pose = sampleMotion('equip', t, t, 'none')
      expect([pose.lift, pose.turn, pose.footLeft, pose.footRight]).toEqual([0, 0, 0, 0])
    }
  })
  it('returns a grounded, open-eyed representative pose for every reduced-motion state', () => {
    for (const motion of motions) for (const tool of tools) {
      const pose = staticPose(motion, tool)
      expect([pose.lift, pose.turn, pose.stretch, pose.footLeft, pose.footRight, pose.lidLeft, pose.lidRight]).toEqual([0, 0, 1, 0, 0, 1, 1])
    }
  })
  it('blends an interrupted jump from its current pose instead of snapping to a new start', () => {
    const flying = sampleMotion('celebrate', 420, 420, 'none')
    expect(blendPose(flying, REST, 0)).toEqual(flying)
    expect(blendPose(flying, REST, 1)).toEqual(REST)
    const between = blendPose(flying, REST, .5)
    expect(between.lift).toBeGreaterThan(flying.lift)
    expect(between.lift).toBeLessThan(REST.lift)
    expect(Object.values(between).every(Number.isFinite)).toBe(true)
  })
  it('settles into the current idle phase without a leaf snap at the feedback boundary', () => {
    for (const motion of ['invite', 'celebrate', 'equip'] as const) for (const tool of tools) {
      const end = MOTION_DURATION[motion]
      // Feedback can begin at any point in the independent idle clock.
      for (let phase = 0; phase < MOTION_DURATION.idle; phase += 73) {
        const before = sampleMotion(motion, end - 1, phase - 1, tool)
        const after = sampleMotion('idle', end, phase, tool)
        for (const leaf of ['leafLeft', 'leafRight'] as const) {
          expect(Math.abs(after[leaf] - before[leaf]), `${motion}/${tool} at idle ${phase}ms`).toBeLessThan(.1)
        }
      }
    }
  })
})

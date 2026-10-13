import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import registration from '../../public/brand/sprout/registration.json'
import accessories from '../../public/brand/sprout/accessories/registration.json'

function covers(path, x, y) {
  return Array.from(path.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)).some(match => Number(match[2]) === y && x >= Number(match[1]) && x < Number(match[1]) + Number(match[3]))
}
describe('approved sprout identity', () => {
  it('keeps the approved source bytes instead of another drawing or regenerated image', () => {
    const expected = { 'master.png': 'e36865cbd4a52922bbfec77c3ca4f329ddc5e6aaf44648f13f806e40415adb9f', 'props.png': '34e872e1468f9301f8634f3b72c3abb0fd3d417e3ab2679398b754f376f4ad3a' }
    for (const [name, hash] of Object.entries(expected)) {
      const bytes = readFileSync(new URL(`../../public/brand/sprout/${name}`, import.meta.url))
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(hash)
    }
  })
  it('keeps facial highlights, leaf colors, hands and feet inside the display mask', () => {
    const mask = registration.poses.none.mask
    for (const [x, y] of [[610,678],[800,735],[670,804],[480,300],[875,240],[295,800],[1000,921],[530,1150],[770,1165]]) expect(covers(mask,x,y),`lost approved pixel ${x},${y}`).toBe(true)
    expect(covers(mask,560,1253)).toBe(false)
    expect(covers(mask,875,54)).toBe(false)
  })
  it('preserves accessory bytes and clear lenses while discarding slate glow', () => {
    for (const [name, source] of Object.entries(accessories.sources)) {
      const bytes = readFileSync(new URL(`../../public/brand/sprout/accessories/${name}`, import.meta.url))
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(source.sha256)
    }
    const glasses = accessories.poses.glasses[0].mask
    expect(covers(glasses, 424, 541)).toBe(false)
    expect(covers(glasses, 1077, 541)).toBe(false)
    expect(covers(glasses, 750, 480)).toBe(true)
    const [board, chalk] = accessories.poses.chalk
    expect(covers(board.mask, 800, 500)).toBe(true)
    expect(covers(board.mask, 450, 500)).toBe(false)
    expect(covers(chalk.mask, 335, 570)).toBe(true)
  })
})

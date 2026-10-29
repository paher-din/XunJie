import { describe, expect, it } from 'vitest'
import { formatMessageTime } from './chatTime'

// 输入与参照都不带时区偏移：解析与输出同用本地时区，断言与跑测试的机器时区无关。
// 2026-10-11 是周日，本周（周一起算）= 10-05 ~ 10-11
const NOW = new Date('2026-10-11T12:00:00')

describe('消息时间戳：越近说得越少', () => {
  it('当天只给时:分', () => {
    expect(formatMessageTime('2026-10-11T09:05:33', NOW)).toBe('09:05')
  })

  it('昨天带「昨天」', () => {
    expect(formatMessageTime('2026-10-10T23:59:00', NOW)).toBe('昨天 23:59')
  })

  it('本周内给周几', () => {
    expect(formatMessageTime('2026-10-07T14:05:00', NOW)).toBe('周三 14:05')
    expect(formatMessageTime('2026-10-05T08:00:00', NOW)).toBe('周一 08:00')
  })

  it('出了本周只给月-日，跨年才带年份', () => {
    expect(formatMessageTime('2026-10-04T18:30:00', NOW)).toBe('10-04 18:30')
    expect(formatMessageTime('2026-01-04T12:00:00', NOW)).toBe('01-04 12:00')
    expect(formatMessageTime('2025-12-31T23:00:00', NOW)).toBe('2025-12-31 23:00')
  })
})

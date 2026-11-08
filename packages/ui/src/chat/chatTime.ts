const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

const pad = (n: number) => String(n).padStart(2, '0')
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
/** 一周之始取周一（中文口径）。 */
const startOfWeek = (d: Date) => {
  const s = startOfDay(d)
  return new Date(s.getFullYear(), s.getMonth(), s.getDate() - ((s.getDay() + 6) % 7))
}
/** 相差几个日历日（按日界算，绕开夏令时的 23 / 25 小时）。 */
const daysBetween = (from: Date, to: Date) =>
  Math.round((startOfDay(from).getTime() - startOfDay(to).getTime()) / 86_400_000)

/**
 * 消息时间戳：越近的时刻说得越少，年份与日期只在需要区分时才出现——
 * 当天只给时:分，昨天给「昨天」，本周内给「周几」，本年给「月-日」，跨年才给年。
 * `now` 是参照时刻，默认取当前时间（测试里给固定值）。
 */
export function formatMessageTime(iso: string, now: Date = new Date()): string {
  const d = new Date(iso)
  const hm = pad(d.getHours()) + ':' + pad(d.getMinutes())
  const dayDiff = daysBetween(now, d)
  if (dayDiff === 0) return hm
  if (dayDiff === 1) return '昨天 ' + hm
  if (d >= startOfWeek(now)) return WEEKDAYS[d.getDay()] + ' ' + hm
  const md = pad(d.getMonth() + 1) + '-' + pad(d.getDate())
  return (d.getFullYear() === now.getFullYear() ? md : d.getFullYear() + '-' + md) + ' ' + hm
}

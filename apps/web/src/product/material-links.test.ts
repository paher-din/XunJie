import { describe, expect, it } from 'vitest'
import { materialLinks } from './material-links'
describe('public material source links', () => {
  it('keeps concept and page context in a navigable HTTPS source link', () => {
    const text = '- 位宽与进位：理论 01 第 23–24 页。[课程原文件](https://elearning.fudan.edu.cn/courses/114588/files/7174035?wrap=1)'
    expect(materialLinks(text)).toEqual([{ href: 'https://elearning.fudan.edu.cn/courses/114588/files/7174035?wrap=1', label: '位宽与进位：理论 01 第 23–24 页。' }])
  })
  it('rejects executable/credential-bearing targets, deduplicates and bounds the link list', () => {
    const text = '[bad](javascript:alert(1)) [bad](https://user:password@example.test/)\n'
      + Array.from({ length: 40 }, (_, i) => `[source ${i}](https://example.test/${i})\n[source](https://example.test/${i})`).join('\n')
    const links = materialLinks(text)
    expect(links).toHaveLength(32)
    expect(links.every(link => !new URL(link.href).username && link.href.startsWith('https:'))).toBe(true)
    expect(new Set(links.map(link => link.href)).size).toBe(32)
  })
})

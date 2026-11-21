// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import CourseMarkdown from './CourseMarkdown'
import { courseMaterialOffsets } from './CourseMaterials'
import { renderedMarkdownRange, selectedMarkdownOffsets } from './courseMarkdownSelection'

function preview(text: string) {
  const root = document.createElement('div')
  root.innerHTML = renderToStaticMarkup(<CourseMarkdown text={text} />)
  return root
}

it('formats a course document with inline and display math while preserving code and escaped dollar signs', () => {
  const root = preview([
    '\uFEFF# 实验规则',
    '',
    '读数$x^2$，对照代码 `$value$` 和 \\$20。',
    '$$',
    '\\frac{1}{2} + \\sqrt{4}',
    '$$',
    '',
    '| 输入 | 结果 |',
    '| --- | --- |',
    '| A | F |',
  ].join('\r\n'))
  expect(root.querySelector('h3')?.textContent).toBe('实验规则')
  expect(root.querySelectorAll('math')).toHaveLength(2)
  expect(root.querySelector('.course-reader-math-block math')).not.toBeNull()
  expect(root.querySelector('code')?.textContent).toBe('$value$')
  expect(root.textContent).toContain('$20')
  expect(root.querySelector('table')?.textContent).toContain('结果')
})

it('keeps invalid formulas and raw HTML readable as text and opens only web source links', () => {
  const root = preview('不完整 $\\courseUnknown{A}$。\n\n<strong>原标签</strong>\n\n[外部资料](https://example.com/notes) [相对路径](./notes.md)')
  expect(root.textContent).toContain('$\\courseUnknown{A}$')
  expect(root.textContent).toContain('<strong>原标签</strong>')
  expect(root.querySelector('strong')).toBeNull()
  expect(root.querySelectorAll('a')).toHaveLength(1)
  expect(root.querySelector('a')?.getAttribute('href')).toBe('https://example.com/notes')
  expect(root.querySelector('a')?.getAttribute('rel')).toBe('noopener noreferrer')
})

it('locates a saved range in the fixed source and recovers the offset from a client that stripped the BOM', () => {
  const text = '\uFEFF# 实验\r\n这里是 🧪 原段落'
  const copy = '🧪 原段落'
  const start = text.indexOf(copy), end = start + copy.length
  expect(courseMaterialOffsets(text, { start, end, copy })).toEqual({ start, end })
  expect(courseMaterialOffsets(text, { start: start - 1, end: end - 1, copy })).toEqual({ start, end })
  expect(courseMaterialOffsets(text, { start, end, copy: '另一段' })).toBeNull()
})

it('maps a rendered selection across inline formatting back to the correct occurrence in the original', () => {
  const text = '\uFEFF# 先预测\r\n\r\n再读**先预测**并比较。\r\n再记录。'
  const root = preview(text)
  const bold = root.querySelector('strong')!
  const selection = document.createRange()
  selection.setStart(bold.firstChild!, 0)
  selection.setEnd(bold.nextSibling!, '并比较。'.length)
  const offsets = selectedMarkdownOffsets(root, text, selection)!
  expect(offsets.start).toBe(text.indexOf('**先预测') + 2)
  expect(text.slice(offsets.start, offsets.end)).toBe('先预测**并比较。')
  expect(renderedMarkdownRange(root, text, offsets.start, offsets.end)?.toString()).toBe('先预测并比较。')

  const start = text.indexOf('再记录。')
  expect(renderedMarkdownRange(root, text, start, start + '再记录。'.length)?.toString()).toBe('再记录。')
})

it('maps Markdown labels and decoded entities without selecting hidden destinations', () => {
  const text = '[**manual**](https://example.org/manual)\r\n\r\nFish &amp; Chips and `&amp;`.'
  const root = preview(text)
  const label = root.querySelector('a strong')!.firstChild!
  const selection = document.createRange()
  selection.selectNodeContents(label)
  expect(selectedMarkdownOffsets(root, text, selection)).toEqual({ start: 3, end: 9 })
  expect(renderedMarkdownRange(root, text, 3, 9)?.toString()).toBe('manual')
  const destination = text.lastIndexOf('manual')
  expect(renderedMarkdownRange(root, text, destination, destination + 6)).toBeNull()

  const paragraph = root.querySelectorAll('p')[1]
  selection.setStart(paragraph.firstChild!, 5)
  selection.setEnd(paragraph.firstChild!, 6)
  const start = text.indexOf('&amp;')
  expect(selectedMarkdownOffsets(root, text, selection)).toEqual({ start, end: start + 5 })
  expect(renderedMarkdownRange(root, text, start, start + 5)?.toString()).toBe('&')
  const literal = text.lastIndexOf('&amp;')
  expect(renderedMarkdownRange(root, text, literal, literal + 5)?.toString()).toBe('&amp;')
})

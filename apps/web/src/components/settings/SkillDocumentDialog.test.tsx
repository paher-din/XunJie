// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SkillDocumentDialog, type SkillDocumentDialogProps } from '@xunjie/ui/settings'

let root: Root
const article = () => document.querySelector('article')!
const button = (label: string) => [...document.querySelectorAll('button')]
  .find(item => (item.getAttribute('aria-label') ?? item.textContent) === label)!
async function draw(overrides: Partial<SkillDocumentDialogProps> = {}) {
  const props: SkillDocumentDialogProps = {
    open: true, name: '项目评审', content: '# 使用方法\n\n正文。', loading: false,
    onClose: vi.fn(), onRetry: vi.fn(), ...overrides,
  }
  await act(async () => root.render(<SkillDocumentDialog {...props} />))
  return props
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

it.each([
  { newline: '\n', prefix: '' }, { newline: '\r\n', prefix: '' },
  { newline: '\n', prefix: '\uFEFF' }, { newline: '\r\n', prefix: '\uFEFF' },
])('shows YAML metadata and the entire Markdown body with %j', async ({ newline, prefix }) => {
  const body = [
    '# 项目评审指南', '', '先**检查目标**，再看`README.md`。', '', '## 操作步骤', '',
    '- 阅读作品', '- 提出反馈', '', '1. 修改作品', '2. 再次检查', '', '> 保留学生自己的判断。', '',
    '### 完成条件', '', '最后一段不能丢失。', '', '---', '', '正文分隔线后的内容。', '',
    '```yaml', '---', 'name: body-example', '---', '```',
  ].join(newline)
  const metadata = ['---', 'name: review-skill', 'description: review-description', '---'].join(newline)
  const content = prefix + metadata + newline + body
  await draw({ content })
  const dialog = document.querySelector('[role="dialog"]')!
  expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('项目评审')
  expect(button('关闭技能')).toBeDefined()
  expect(dialog.textContent).not.toContain('SKILL.md')
  const codeBlocks = article().querySelectorAll('pre code')
  expect(codeBlocks[0]?.textContent).toBe(metadata.replace(/\r\n/g, '\n'))
  expect(article().querySelector('.md-pre-lang')?.textContent).toBe('yaml')
  expect([...article().querySelectorAll('.md-h')].map(item => item.textContent))
    .toEqual(['项目评审指南', '操作步骤', '完成条件'])
  expect(article().querySelector('p')?.textContent).toBe('先检查目标，再看README.md。')
  expect(article().querySelector('strong')?.textContent).toBe('检查目标')
  expect(article().querySelector('.md-code')?.textContent).toBe('README.md')
  expect([...article().querySelectorAll('li')].map(item => item.textContent))
    .toEqual(['阅读作品', '提出反馈', '修改作品', '再次检查'])
  expect(article().querySelector('blockquote')?.textContent).toBe('保留学生自己的判断。')
  expect(article().textContent).toContain('最后一段不能丢失。')
  expect(article().textContent).toContain('正文分隔线后的内容。')
  expect(codeBlocks[1]?.textContent).toBe('---\nname: body-example\n---')
})

it.each([
  ['---\nname: no-closing-delimiter\n正文', 'name: no-closing-delimiter'],
  ['先阅读\n\n---\nname: body-metadata\n---\n结尾', 'name: body-metadata'],
  ['---\nname: invalid-closing-delimiter\n--- trailing\n结尾', 'name: invalid-closing-delimiter'],
])('keeps unmatched or nonleading metadata in the body: %j', async (content, retained) => {
  await draw({ content })
  expect(article().textContent).toContain(retained)
  expect(article().querySelector('pre code')).toBeNull()
})

it.each(['---\nname: metadata-only\n---', '---\n---'])('shows metadata ending at EOF without inventing body content: %j', async content => {
  await draw({ content })
  expect(article().querySelector('pre code')?.textContent).toBe(content)
  expect(article().querySelector('p, .md-h, hr')).toBeNull()
})

it.each([3, 4, 12])('keeps embedded %i-backtick fences and HTML inert inside YAML and copies all metadata', async length => {
  const writeText = vi.fn(async (_text: string) => {})
  vi.stubGlobal('navigator', Object.create(navigator, { clipboard: { value: { writeText } } }))
  const metadata = [
    '---', 'name: fence-example', 'description: |', '  ```', `  ${'`'.repeat(length)}`,
    '  # Not a heading', '  <script>window.skillExecuted = true</script>',
    '  <img src=x onerror=alert(1)>', '  [link](https://example.com)',
    '  $(echo do-not-execute)', '  ~~~', '---',
  ].join('\n')
  await draw({ content: `${metadata}\n# 正文标题\n\n正文**仍可阅读**。` })
  expect(article().querySelectorAll('pre code')).toHaveLength(1)
  expect(article().querySelector('pre code')?.textContent).toBe(metadata)
  expect(article().querySelector('script, img, a')).toBeNull()
  expect([...article().querySelectorAll('.md-h')].map(item => item.textContent)).toEqual(['正文标题'])
  expect(article().querySelector('strong')?.textContent).toBe('仍可阅读')
  await act(async () => button('复制代码').click())
  expect(writeText).toHaveBeenLastCalledWith(metadata)
})

it('keeps code and tables intact, copies their source and exposes safe links', async () => {
  const writeText = vi.fn(async (_text: string) => {})
  vi.stubGlobal('navigator', Object.create(navigator, { clipboard: { value: { writeText } } }))
  const code = `  const result = "${'long-value-'.repeat(30)}";\n  console.log(result)`
  const table = '| 步骤 | 结果 |\n| --- | --- |\n| 阅读 | **完成** |'
  await draw({ content: `\`\`\`javascript\n${code}\n\`\`\`\n\n${table}\n\n[阅读文档](https://example.com/guide)\n\n[联系教师](mailto:teacher@example.com)` })
  expect(article().querySelector('pre code')?.textContent).toBe(code)
  expect([...article().querySelectorAll('th, td')].map(cell => cell.textContent))
    .toEqual(['步骤', '结果', '阅读', '完成'])
  expect(article().querySelector('td strong')?.textContent).toBe('完成')
  const links = [...article().querySelectorAll('a')]
  expect(links.map(link => link.getAttribute('href')))
    .toEqual(['https://example.com/guide', 'mailto:teacher@example.com'])
  expect(links[0].target).toBe('_blank')
  expect(links[0].rel).toContain('noopener')
  await act(async () => button('复制代码').click())
  expect(writeText).toHaveBeenLastCalledWith(code)
  await act(async () => button('复制表格为 Markdown').click())
  expect(writeText).toHaveBeenLastCalledWith(table)
})

it('renders raw HTML and unsafe links as inert text', async () => {
  const html = '<script>window.skillExecuted = true</script>\n\n<img src=x onerror=alert(1)>\n\n<iframe src="https://example.com"></iframe>'
  await draw({ content: `${html}\n\n[脚本](javascript:alert(1)) [数据](data:text/html;base64,PHNjcmlwdD4=) [本地文件](file:///etc/passwd) [相对路径](./guide.md)\n\n![图片说明](https://example.com/image.png)` })
  expect(article().querySelector('script, img, iframe, a')).toBeNull()
  for (const text of ['<script>window.skillExecuted = true</script>', '<img src=x onerror=alert(1)>',
    '<iframe src="https://example.com"></iframe>', '脚本', '数据', '本地文件', '相对路径', '图片说明']) {
    expect(article().textContent).toContain(text)
  }
})

it('retries a failure through loading to the document without exposing internal errors', async () => {
  let complete!: () => void
  const pending = new Promise<void>(resolve => { complete = resolve })
  const onRetry = vi.fn()
  function Reader() {
    const [state, setState] = useState({ loading: false, error: 'HTTP 500 /private/skills/source-hash', content: null as string | null })
    return <SkillDocumentDialog open name="项目评审" {...state} onClose={vi.fn()} onRetry={() => {
      onRetry()
      setState({ loading: true, error: '', content: null })
      void pending.then(() => setState({ loading: false, error: '', content: '# 重试成功\n\n完整正文' }))
    }} />
  }
  await act(async () => root.render(<Reader />))
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('暂时无法打开技能，请重试。')
  expect(document.body.textContent).not.toContain('/private/skills')
  await act(async () => button('重试').click())
  expect(onRetry).toHaveBeenCalledOnce()
  expect(document.querySelector('[aria-busy="true"]')).not.toBeNull()
  expect(document.querySelector('[role="status"]')?.textContent).toBe('正在打开技能…')
  expect(document.querySelector('[role="alert"], article')).toBeNull()
  await act(async () => { complete(); await pending })
  expect(article().textContent).toBe('重试成功完整正文')
  expect(document.querySelector('[aria-busy="true"]')).toBeNull()
})

it.each(['close', 'Escape'])('closes via %s, retains the footer action and returns focus', async method => {
  const onClose = vi.fn(), onUpdate = vi.fn()
  const trigger = document.createElement('button')
  document.body.append(trigger)
  const onReturnFocus = vi.fn(() => trigger.focus())
  function Reader() {
    const [open, setOpen] = useState(true)
    return <SkillDocumentDialog open={open} name="项目评审" content="正文" loading={false}
      onClose={() => { onClose(); setOpen(false) }} onRetry={vi.fn()} onReturnFocus={onReturnFocus}
      footer={<button type="button" onClick={onUpdate}>更新技能</button>} />
  }
  await act(async () => root.render(<Reader />))
  await act(async () => button('更新技能').click())
  expect(onUpdate).toHaveBeenCalledOnce()
  await act(async () => {
    if (method === 'close') button('关闭技能').click()
    else document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(onClose).toHaveBeenCalledOnce()
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(onReturnFocus).toHaveBeenCalledOnce()
  expect(document.activeElement).toBe(trigger)
})

import { evidenceDirectory } from './evidence'
import { test, expect, type Page } from '@playwright/test'
import { randomUUID, createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir, release } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openProductRuntime, createProductRuntimeHost, createProductLearningApplication, resolveCredential } from '@xunjie/product-runtime'
import { controlledActionReceiver } from '../../server/tests/support/action-receiver.mjs'
import { annotationPackage } from '../../../components/material-annotation/package.mjs'
import { aluPackage, aluCoursePackage } from '../../../components/alu-experiment/package.mjs'
import type { AgentConversation } from '@xunjie/contracts/agent-service'
import { fixedPdf } from '../../server/tests/fixtures/pdf-material.mjs'
import { courseTaskCard, createWorkFile, openCourseTasks, openWorkFileActions, openWorkspacePopover, renameWorkFile,
  selectProductSpace, useEmbeddedSchoolFixture } from './support/product-ui'

const postgresBin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN
test.skip(!postgresBin, 'Requires the native PostgreSQL distribution')
test.use({ trace: 'off' })
const receiver = controlledActionReceiver('ui-regression-receiver')
let root = '', endpoint = '', browserVersion = '', headless = true
let runtime: ReturnType<typeof openProductRuntime>
let host: Awaited<ReturnType<typeof createProductRuntimeHost>>
const cases: { name: string; status: string | undefined; durationMs: number }[] = []
const output = evidenceDirectory('159')
test.beforeAll(async ({ browser }, info) => {
  test.setTimeout(180_000)
  browserVersion = browser.version(); headless = info.project.use.headless !== false
  if (output) await mkdir(output, { recursive: true })
  root = await mkdtemp(join(tmpdir(), 'xj-ui159-tests-'))
  runtime = openProductRuntime({ root, resources: { nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin,
    postgresVersion: '18.6', webRoot: process.env.XUNJIE_PRODUCT_WEB_ROOT ?? fileURLToPath(new URL('../dist-runtime', import.meta.url)),
    windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) } })
  await runtime.install({ profile: 'local' })
  host = await createProductRuntimeHost({ root, createApplication: context => createProductLearningApplication(context, { receivers: [receiver] }) })
  endpoint = host.endpoint
})
test.afterEach(async ({}, info) => { cases.push({ name: info.title, status: info.status, durationMs: info.duration }) })
test.afterAll(async () => {
  await host?.stop(); await runtime?.stop()
  if (output) await writeFile(join(output, `product-ui-${process.platform}.json`), JSON.stringify({ measuredAt: new Date().toISOString(),
    platform: process.platform, arch: process.arch, osRelease: release(), node: process.version,
    browser: 'installed Chrome', browserVersion, headless, backend: 'production host, native PostgreSQL, built product UI',
    receiver: 'controlled test receiver; no real Agent or teaching outcome', cases }, null, 2))
  if (root) await rm(root, { recursive: true, force: true })
})
async function newActivity(page: Page, goal = '自主学习-' + randomUUID()) {
  await page.goto(endpoint)
  await page.getByRole('button', { name: 'Agent 对话', exact: true }).click()
  await page.getByLabel('向 Agent 提问', { exact: true }).fill(goal)
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.locator('.product-conversation h1')).toHaveText(goal)
  await page.getByRole('button', { name: '进入工作区', exact: true }).click()
  await expect(page.locator('#activity-title')).toHaveText(goal)
  return new URL(page.url()).searchParams.get('activity')!
}

async function openPersonalActivityFromHome(page: Page) {
  const goal = '自主学习-' + randomUUID()
  const response = await page.request.post(endpoint + '/api/learning/activities', {
    headers: { 'x-xj-space': 'personal' }, data: { requestId: randomUUID(), goal, question: '', references: [] },
  })
  expect(response.status()).toBe(200)
  const { activityId: id } = await response.json() as { activityId: string }
  await page.goto(endpoint)
  await selectProductSpace(page, '个人空间')
  await page.locator(`[data-activity-id="${id}"]`).click()
  await expect(page.locator('#activity-title')).toHaveText(goal)
  expect(new URL(page.url()).searchParams.get('activity')).toBe(id)
  return id
}

async function newFile(page: Page, name: string) {
  await createWorkFile(page, name)
  await page.locator('.monaco-editor textarea').focus()
}
const readWorks = async (page: Page, id: string) => (await page.request.get(endpoint + '/api/learning/workspaces/' + id,
  { headers: { 'x-xj-space': 'personal' } })).json()

test('default product entry uses shared UI and stable file identities through rename, deletion and recreation', async ({ page }) => {
  await page.addInitScript(() => {
    const fault = { refuse: false }
    Object.assign(window, { fileDeletionFault: fault })
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (value, key) {
      if (fault.refuse && this.name === 'workspaces' && value.files?.length === 0)
        throw new DOMException('Controlled refusal of deletion', 'QuotaExceededError')
      return put.call(this, value, key)
    }
  })
  const id = await openPersonalActivityFromHome(page)
  await expect(page.locator('.shell.immersive')).toBeVisible()
  const status = page.locator('.ws-commandbar').getByRole('region', { name: '工作区状态' })
  await expect(status.getByRole('status', { name: '活动进行中', exact: true })).toHaveText('进行中')
  await newFile(page, '中文.txt')
  await page.keyboard.insertText('第一份原文')
  await expect.poll(async () => (await readWorks(page, id)).files[0]?.value).toBe('第一份原文')
  await expect(status.getByText('已保存', { exact: true })).toBeVisible()
  await expect(status.getByTitle(/作品已保存到本机/)).toBeVisible()
  const first = (await readWorks(page, id)).files[0]
  await page.getByRole('button', { name: '关闭 中文.txt 的标签', exact: true }).click()
  await expect(page.getByRole('button', { name: '中文.txt', exact: true })).toHaveCount(0)
  const menu = await openWorkspacePopover(page, '文件')
  await menu.getByRole('button', { name: '中文.txt', exact: true }).click()
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('第一份原文')
  await renameWorkFile(page, '中文.txt', '改名.txt')
  await expect.poll(async () => (await readWorks(page, id)).files[0]?.name).toBe('改名.txt')
  expect((await readWorks(page, id)).files[0].objectId).toBe(first.objectId)
  const row = await openWorkFileActions(page, '改名.txt')
  const [download] = await Promise.all([page.waitForEvent('download'), row.getByRole('button', { name: '导出作品备份' }).click()])
  expect(download.suggestedFilename()).toBe('循阶作品备份.json')
  await download.delete()
  await row.getByRole('button', { name: '删除', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '删除文件' })
  await page.evaluate(() => { (window as unknown as { fileDeletionFault: { refuse: boolean } }).fileDeletionFault.refuse = true })
  await dialog.getByRole('button', { name: '删除文件' }).click()
  await expect(dialog.getByRole('alert')).toContainText('本机未确认删除文件')
  await expect(page.locator('.cw-filetab.active')).toContainText('改名.txt')
  expect((await readWorks(page, id)).files[0]?.objectId).toBe(first.objectId)
  await page.evaluate(() => { (window as unknown as { fileDeletionFault: { refuse: boolean } }).fileDeletionFault.refuse = false })
  await dialog.getByRole('button', { name: '删除文件' }).click()
  await expect(dialog).toHaveCount(0)
  await expect.poll(async () => (await readWorks(page, id)).files).toHaveLength(0)
  await newFile(page, '改名.txt'); await page.keyboard.insertText('同名新作品')
  await expect.poll(async () => (await readWorks(page, id)).files[0]?.value).toBe('同名新作品')
  expect((await readWorks(page, id)).files[0].objectId).not.toBe(first.objectId)
  await page.getByRole('button', { name: '返回活动列表', exact: true }).click()
  await expect(page.locator('.brand')).toBeVisible()
  await expect(page.locator('.product-home')).toBeVisible()
  await expect(page.locator(`[data-activity-id="${id}"]`)).toBeFocused()
  await page.goBack()
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('同名新作品')
  await page.goForward()
  await expect(page.getByRole('heading', { name: '我的课程' })).toBeVisible()
  await expect(page.getByRole('button', { name: /保存|冻结|确认作品/ })).toHaveCount(0)
  await expect(page.getByText(/演示统计|热力/)).toHaveCount(0)
})

test('the workspace shows an error when an image attachment cannot be decoded', async ({ page }) => {
  await openPersonalActivityFromHome(page)
  await page.getByRole('button', { name: '打开对话', exact: true }).click()
  const composer = page.getByRole('complementary', { name: '问题与引用', exact: true })
  await expect(composer.getByRole('textbox', { name: '你的问题', exact: true })).toBeEnabled()
  await composer.locator('input[type=file]').setInputFiles({ name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('not a PNG') })
  await expect(page.getByText('无法读取这张图片。', { exact: true })).toBeVisible()
})

test('PDF page turns preload and reuse a transient next-page preview', async ({ page }) => {
  await openPersonalActivityFromHome(page)
  const requestedPages: number[][] = []
  let releaseNextPage = () => {}
  const holdNextPage = new Promise<void>(resolve => { releaseNextPage = resolve })
  await page.route('**/api/learning/pdf/*/read', async route => {
    const { pages, preview } = route.request().postDataJSON() as { pages: number[]; preview?: boolean }
    expect(preview).toBe(true)
    requestedPages.push(pages)
    if (pages[0] === 2) await holdNextPage
    await route.continue()
  })

  try {
    await page.getByRole('tab', { name: '学习资料', exact: true }).click()
    await page.getByRole('group', { name: '资料分类' }).getByRole('button', { name: '个人 PDF', exact: true }).click()
    await page.getByRole('region', { name: '个人 PDF', exact: true }).locator('input[type=file]')
      .setInputFiles({ name: '翻页讲义.pdf', mimeType: 'application/pdf', buffer: fixedPdf() })
    const reader = page.getByRole('region', { name: 'PDF 阅读区', exact: true })
    const cover = reader.getByRole('img', { name: 'PDF 第 1 页固定页图', exact: true })
    const secondPage = reader.getByRole('img', { name: 'PDF 第 2 页固定页图', exact: true })
    const reading = reader.locator('.pdf-reading')
    await expect(cover).toBeVisible()
    const firstReadingId = await reading.getAttribute('data-pdf-reading-id')
    expect(firstReadingId).toBeTruthy()
    await expect.poll(() => requestedPages).toEqual([[1], [2]])
    await expect(reader).toHaveAttribute('aria-busy', 'false')

    await reader.getByRole('button', { name: '下一页', exact: true }).click()
    await expect(reader.getByRole('status').filter({ hasText: '正在读取第 2 页…' })).toBeVisible()
    await expect(cover).toBeVisible()
    await expect(secondPage).toHaveCount(0)
    await expect(reading).toHaveAttribute('data-pdf-reading-id', firstReadingId!)
    releaseNextPage()

    await expect(secondPage).toBeVisible()
    await reader.getByRole('button', { name: '上一页', exact: true }).click()
    await expect(cover).toBeVisible()
    await expect(reading).toHaveAttribute('data-pdf-reading-id', firstReadingId!)
    expect(requestedPages).toEqual([[1], [2]])
  } finally {
    releaseNextPage()
  }
})

test('PDF region references show one fit stop when the fit stops overlap', async ({ page }) => {
  await page.setViewportSize({ width: 1320, height: 850 })
  await openPersonalActivityFromHome(page)
  await page.getByRole('tab', { name: '学习资料', exact: true }).click()
  await page.getByRole('group', { name: '资料分类' }).getByRole('button', { name: '个人 PDF', exact: true }).click()
  await page.getByRole('region', { name: '个人 PDF', exact: true }).locator('input[type=file]')
    .setInputFiles({ name: '选区缩放.pdf', mimeType: 'application/pdf', buffer: fixedPdf() })

  const reader = page.getByRole('region', { name: 'PDF 阅读区', exact: true })
  const zoom = reader.getByRole('group', { name: 'PDF 缩放', exact: true })
  const slider = zoom.getByRole('slider', { name: 'PDF 缩放比例', exact: true })
  const stops = zoom.locator('.pdf-zoom-stop')
  await expect(slider).toBeEnabled()
  await expect(stops).toHaveCount(2)
  await expect(reader.getByRole('button', { name: 'PDF 工具侧栏', exact: true })).toHaveAttribute('aria-expanded', 'true')
  await reader.getByRole('button', { name: '框选区域', exact: true }).click()
  const frame = (await reader.locator('.pdf-page-image').boundingBox())!
  await page.mouse.move(frame.x + frame.width * .13, frame.y + frame.height * .15)
  await page.mouse.down()
  await page.mouse.move(frame.x + frame.width * .79, frame.y + frame.height * .34, { steps: 10 })
  await page.mouse.up()
  await reader.getByRole('button', { name: '引用所选区域', exact: true }).click()

  const citation = page.getByRole('button', { name: '定位引用 1：选区缩放.pdf · 第 1 页选区', exact: true })
  await expect(citation).toBeVisible()
  const fitRegion = zoom.getByRole('button', { name: '适合选区', exact: true })
  await expect(stops).toHaveCount(1)
  await fitRegion.click()
  await expect(fitRegion).toHaveAttribute('aria-pressed', 'true')
  const fitted = Number(await slider.inputValue())
  await slider.press('ArrowLeft')
  await expect(slider).toHaveValue(String(fitted - 1))
  await reader.getByRole('button', { name: '完整页', exact: true }).click()
  await expect(stops).toHaveCount(2)
  await citation.click()
  await expect(fitRegion).toBeVisible()
  await expect(stops).toHaveCount(1)
})

test('personal notes keep text and formatting while typing common Markdown', async ({ page }) => {
  await openPersonalActivityFromHome(page)
  await page.getByRole('tab', { name: '学习资料', exact: true }).click()
  await page.getByRole('button', { name: '个人笔记', exact: true }).click()
  const notes = page.getByRole('region', { name: '个人笔记', exact: true })
  await notes.getByRole('button', { name: '添加笔记', exact: true }).click()
  await notes.getByLabel('个人笔记名称').fill('Markdown 键盘验收')
  await notes.getByLabel('个人笔记正文').fill('待替换')
  await notes.getByRole('button', { name: '保存笔记', exact: true }).click()
  await notes.getByRole('button', { name: 'Markdown 键盘验收', exact: true }).click()
  const note = page.getByRole('region', { name: '个人笔记阅读区', exact: true })
  await note.getByRole('button', { name: '编辑笔记', exact: true }).click()
  const editor = note.getByRole('textbox', { name: '更新个人笔记正文', exact: true })
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
  await editor.press(`${modifier}+a`)
  await page.keyboard.press('Backspace')

  const lines = [
    '# Heading', '', 'Mix **bold** *italic* ~~strike~~ `code` [site](https://example.com) $x^2$ done.', '',
    'Read &amp; \\* ![alt label](https://example.com/image).', '',
    '- First', 'Second', '', '8. Eight', 'Nine', '', '- [x] Complete', 'Pending', '', '> Quote one', 'Quote two', '',
    '```js', 'let result = 42;', '```', '', '$$', 'y^2 + 1', '$$', '', '---', '', 'Paragraph after blocks.',
  ]
  for (const [index, line] of lines.entries()) {
    if (index) await page.keyboard.press('Enter')
    if (line) await page.keyboard.type(line)
  }

  await expect(editor.getByRole('heading', { name: 'Heading', exact: true })).toBeVisible()
  await expect(editor.locator('strong')).toHaveText('bold')
  await expect(editor.locator('em')).toHaveText('italic')
  await expect(editor.locator('s')).toHaveText('strike')
  await expect(editor.locator('.personal-note-link')).toHaveText('site')
  await expect(editor.locator('.personal-note-literal')).toHaveText(['&', '*', 'alt label'])
  await expect(editor.locator('ol[start="8"] li')).toHaveText(['Eight', 'Nine'])
  await expect(editor.locator('li input[checked]')).toHaveCount(1)
  await expect(editor.locator('li input:not([checked])')).toHaveCount(1)
  await expect(editor.locator('blockquote')).toContainText('Quote two')
  await expect(editor.locator('pre code')).toHaveText('let result = 42;')
  await expect(editor.locator('math')).toHaveCount(2)
  await expect(editor.locator('hr')).toHaveCount(1)

  const visibleSyntax = editor.locator('.personal-note-syntax')
  await expect(visibleSyntax).toHaveCount(0)
  await editor.locator('strong').click()
  await expect(visibleSyntax).toHaveText(['**', '**'])
  await expect(editor.locator('strong')).toHaveText('bold')
  await editor.locator('em').click()
  await expect(visibleSyntax).toHaveText(['*', '*'])
  await note.getByRole('button', { name: '取消', exact: true }).focus()
  await expect(visibleSyntax).toHaveCount(0)

  await editor.locator('strong').dblclick()
  await page.keyboard.press(`${modifier}+i`)
  await expect(editor.locator('strong em, em strong')).toHaveText('bold')
  await page.keyboard.press(`${modifier}+i`)
  await expect(editor.locator('strong')).toHaveText('bold')
  await expect(editor.locator('strong em, em strong')).toHaveCount(0)

  const quote = editor.locator('blockquote p')
  const secondLine = await quote.evaluate(paragraph => {
    const text = paragraph.firstChild!
    const range = paragraph.ownerDocument.createRange()
    range.setStart(text, text.textContent!.indexOf('Quote two') + 3)
    range.collapse(true)
    const rect = range.getBoundingClientRect()
    return { x: rect.left, y: (rect.top + rect.bottom) / 2 }
  })
  await page.mouse.click(secondLine.x, secondLine.y)
  await page.keyboard.insertText('※')
  await expect(editor.locator('.cm-line').filter({ hasText: 'Quo※te two' })).toBeVisible()
  await page.keyboard.press(`${modifier}+z`)

  await editor.press(`${modifier}+End`)
  await page.keyboard.press('Shift+Home')
  await page.keyboard.press(`${modifier}+b`)
  await expect(editor.locator('strong')).toHaveText(['bold', 'Paragraph after blocks.'])
  await page.keyboard.press(`${modifier}+z`)
  await expect(editor.locator('strong')).toHaveText('bold')
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.keyboard.type('| Left | Right |')
  await page.keyboard.press('Enter')
  const table = editor.getByRole('table')
  const first = table.getByRole('textbox', { name: '第 1 行第 1 列', exact: true })
  await expect(first).toBeFocused()
  await first.fill('first cell')
  await first.press('Tab')
  const last = table.getByRole('textbox', { name: '第 1 行第 2 列', exact: true })
  await expect(last).toBeFocused()
  await last.fill('second cell')
  await last.press('Tab')
  const next = table.getByRole('textbox', { name: '第 2 行第 1 列', exact: true })
  await expect(next).toBeFocused()
  await next.fill('new row')
  await next.press('Enter')
  await editor.press(`${modifier}+End`)
  await page.keyboard.type('After table')
  await expect(editor.locator('.cm-line').filter({ hasText: 'After table' })).toBeVisible()
  await note.getByRole('button', { name: '保存新版本', exact: true }).click()
  await expect(note.getByText('第 2 版', { exact: true })).toBeVisible()
  await expect(note.getByRole('heading', { name: 'Heading', exact: true })).toBeVisible()
  await expect(note.getByRole('link', { name: 'site', exact: true })).toHaveAttribute('href', 'https://example.com/')
  await expect(note.getByRole('cell', { name: 'new row', exact: true })).toBeVisible()
  await expect(note.locator('p').filter({ hasText: 'After table' })).toBeVisible()
})

test('personal material rows open by name and removing a PDF preserves its existing citation', async ({ page }) => {
  await openPersonalActivityFromHome(page)
  const learningTab = page.getByRole('tab', { name: '学习资料', exact: true })
  await learningTab.click()
  const categories = page.getByRole('group', { name: '资料分类' })
  await categories.getByRole('button', { name: '个人笔记', exact: true }).click()
  const notes = page.getByRole('region', { name: '个人笔记', exact: true })
  await notes.getByRole('button', { name: '添加笔记', exact: true }).click()
  await notes.getByLabel('个人笔记名称').fill('界面验收笔记')
  const noteIntro = '# 我的笔记\n\n请看**「关键结论」**再继续，记住**（ALU）**的公式 $x^2$。\n\n$$\n\\frac{1}{2}\n$$'
  const noteTable = '| 左列 | 右列 |\n| :--- | ---: |\n| 左侧内容 | 右侧内容 |'
  const sections = Array.from({ length: 16 }, (_, index) => `## 第 ${index + 1} 节\n\n这里记录本节的学习过程。`)
  const wrappedParagraph = '核对光标位置：' + '这里的中文正文会在编辑器内自然折行。'.repeat(10)
  await notes.getByLabel('个人笔记正文').fill([noteIntro, noteTable, ...sections, wrappedParagraph].join('\n\n'))
  await notes.getByRole('button', { name: '保存笔记', exact: true }).click()
  const noteMenu = notes.getByRole('button', { name: '界面验收笔记的更多操作', exact: true })
  await noteMenu.press('Enter')
  await expect(page.getByRole('menuitem', { name: '更新', exact: true })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: '移除', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(noteMenu).toBeFocused()
  await notes.getByRole('button', { name: '界面验收笔记', exact: true }).click()
  const noteReader = page.getByRole('region', { name: '个人笔记阅读区' })
  await expect(noteReader.getByRole('heading', { name: '我的笔记' })).toBeVisible()
  const emphasized = noteReader.locator('strong').filter({ hasText: '「关键结论」' })
  await expect(emphasized).toBeVisible()
  await expect(emphasized).toHaveCSS('font-weight', '600')
  await expect(noteReader.locator('strong').filter({ hasText: '（ALU）' })).toBeVisible()
  await expect(noteReader.locator('math')).toHaveCount(2)
  await expect(noteReader.getByRole('button', { name: '查看原文', exact: true })).toHaveCount(0)

  await noteReader.getByRole('button', { name: '编辑笔记', exact: true }).click()
  const editor = noteReader.getByRole('textbox', { name: '更新个人笔记正文', exact: true })
  await editor.press('Control+End')
  const wrappedLine = editor.locator('.cm-line').filter({ hasText: '核对光标位置：' })
  await wrappedLine.scrollIntoViewIfNeeded()
  const offset = 86
  const hit = await wrappedLine.evaluate((line, offset) => {
    const range = line.ownerDocument.createRange()
    range.setStart(line.firstChild!, offset)
    range.collapse(true)
    const rect = range.getBoundingClientRect()
    return { x: rect.left, y: (rect.top + rect.bottom) / 2, top: line.getBoundingClientRect().top }
  }, offset)
  expect(hit.y - hit.top).toBeGreaterThan(30)
  expect(await editor.evaluate(element => element.parentElement!.scrollTop)).toBeGreaterThan(0)
  await page.mouse.click(hit.x, hit.y)
  await page.keyboard.insertText('※')
  await expect(wrappedLine).toHaveText(wrappedParagraph.slice(0, offset) + '※' + wrappedParagraph.slice(offset))
  await noteReader.getByRole('button', { name: '取消', exact: true }).click()

  await noteReader.getByRole('button', { name: '编辑笔记', exact: true }).click()
  const table = editor.getByRole('table')
  await table.getByRole('cell', { name: '左侧内容' }).click()
  const firstCell = table.getByRole('textbox', { name: '第 1 行第 1 列' })
  await expect(firstCell).toBeFocused()
  await expect(table.getByRole('columnheader', { name: '左列' })).toBeVisible()
  await expect(table.getByRole('cell', { name: '右侧内容' })).toBeVisible()
  await firstCell.fill('**本格更新** | $y^2$')
  await firstCell.press('Tab')
  await expect(table.locator('td strong')).toHaveText('本格更新')
  await expect(table.locator('td math')).toHaveCount(1)
  const secondCell = table.getByRole('textbox', { name: '第 1 行第 2 列' })
  await expect(secondCell).toBeFocused()
  await secondCell.fill('右侧也更新')
  await noteReader.getByRole('button', { name: '保存新版本', exact: true }).click()
  await expect(noteReader.getByText('第 2 版', { exact: true })).toBeVisible()
  const savedTable = noteReader.getByRole('table')
  await expect(savedTable.getByRole('cell', { name: '右侧也更新' })).toHaveAttribute('align', 'right')
  await expect(savedTable.locator('td strong')).toHaveText('本格更新')

  const pdfTab = categories.getByRole('button', { name: '个人 PDF', exact: true })
  await pdfTab.click()
  const library = page.getByRole('region', { name: '个人 PDF', exact: true })
  const reader = page.getByRole('region', { name: 'PDF 阅读区', exact: true })
  const pdfName = '待移除的讲义.pdf'
  await library.locator('input[type=file]').setInputFiles({ name: pdfName, mimeType: 'application/pdf', buffer: fixedPdf() })
  const pageImage = reader.getByRole('img', { name: 'PDF 第 1 页固定页图', exact: true })
  await expect(pageImage).toBeVisible()
  const reading = reader.locator('.pdf-reading')
  const readingId = await reading.getAttribute('data-pdf-reading-id')
  expect(readingId).toBeTruthy()
  const tools = reader.getByRole('button', { name: 'PDF 工具侧栏', exact: true })
  if (await tools.getAttribute('aria-expanded') !== 'true') await tools.click()
  await reader.getByRole('button', { name: '引用此页', exact: true }).click()
  const citation = page.getByRole('button', { name: /^定位引用 \d+：待移除的讲义\.pdf/ })
  await expect(citation).toBeVisible()
  await expect(reading).toHaveAttribute('data-pdf-reading-id', readingId!)
  await reader.getByRole('button', { name: '返回 PDF 列表', exact: true }).click()
  await library.getByRole('button', { name: pdfName + '的更多操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '移除', exact: true }).click()
  await expect(library.getByRole('button', { name: pdfName, exact: true })).toHaveCount(0)
  await library.getByRole('button', { name: '刷新 PDF 列表', exact: true }).click()
  await expect(library.getByText('还没有添加 PDF。', { exact: false })).toBeVisible()

  await citation.click()
  await expect(pageImage).toBeVisible()
  await expect(reader.locator('.pdf-reading')).toHaveAttribute('data-pdf-reading-id', readingId!)
  await reader.getByRole('button', { name: '返回 PDF 列表', exact: true }).click()
  await expect(library.getByRole('button', { name: pdfName, exact: true })).toHaveCount(0)
})

test('browser history cannot bypass a refused local protection transaction', async ({ page }) => {
  await page.addInitScript(() => {
    const fault = { refuse: false }; Object.assign(window, { productUiQuota: fault })
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args) {
      if (fault.refuse) throw new DOMException('Controlled quota refusal', 'QuotaExceededError')
      return Reflect.apply(put, this, args)
    }
  })
  const id = await newActivity(page)
  await newFile(page, '离开保护.txt')
  await page.keyboard.insertText('已有正文')
  await expect.poll(async () => (await readWorks(page, id)).files[0]?.value).toBe('已有正文')
  await page.evaluate(() => { (window as unknown as { productUiQuota: { refuse: boolean } }).productUiQuota.refuse = true })
  await page.keyboard.insertText('仍在内存')
  await expect(page.getByRole('button', { name: '导出当前作品' })).toBeVisible()
  await page.goBack()
  await expect(page).toHaveURL(new RegExp('activity=' + id))
  await expect(page.getByLabel('可复制的当前原文')).toHaveValue('已有正文仍在内存')
  await page.evaluate(() => { (window as unknown as { productUiQuota: { refuse: boolean } }).productUiQuota.refuse = false })
  await page.goBack()
  await expect(page.locator('.product-conversation')).toBeVisible()
  await page.goForward()
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('已有正文仍在内存')
  await expect.poll(async () => (await readWorks(page, id)).files[0]?.value).toBe('已有正文仍在内存')
})

test('selection, fixed send and later input survive the integrated discussion panel and reload', async ({ page }) => {
  const created = await page.request.post(endpoint + '/api/learning/activities', {
    headers: { 'x-xj-space': 'personal' },
    data: { requestId: randomUUID(), goal: '固定发送回归', question: '', references: [] },
  })
  expect(created.status()).toBe(200)
  const { activityId: id } = await created.json()
  await page.goto(endpoint + '/?space=personal&activity=' + id)
  await expect(page.locator('#activity-title')).toHaveText('固定发送回归')
  await newFile(page, '依据.c'); await page.keyboard.insertText('// 固定选择甲')
  await expect.poll(async () => (await readWorks(page, id)).files[0]?.value).toBe('// 固定选择甲')
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
  const askSelection = page.getByRole('button', { name: '询问 Agent', exact: true })
  await askSelection.click()
  await expect(page.getByRole('region', { name: '上下文引用' }).locator('li')).toHaveCount(1)
  const input = page.getByRole('textbox', { name: '你的问题', exact: true })
  await input.fill('问题甲')
  let releaseAccept!: () => void
  const hold = new Promise<void>(resolve => { releaseAccept = resolve })
  const pending = page.waitForRequest(request => request.method() === 'POST' && /\/agent-sessions\/[^/]+\/inputs$/.test(request.url()))
  await page.route('**/agent-sessions/*/inputs', async route => {
    await hold
    await route.continue()
  })
  try {
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    const sent = await pending
    await input.fill('发送后继续输入乙')
    await page.locator('.monaco-editor textarea').focus()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End')
    await page.keyboard.insertText('\n// 作品乙')
    await expect(page.getByRole('region', { name: '上下文引用' }).locator('li')).toHaveCount(1)
    releaseAccept()
    const response = await sent.response()
    expect(response?.status()).toBe(200)
    const submitted = sent.postDataJSON()
    const headers = await sent.allHeaders()
    const receipt = await page.request.get(sent.url().replace(/\/inputs$/, '/requests/' + submitted.requestId),
      { headers: Object.fromEntries(Object.entries(headers).filter(([name]) => name.startsWith('x-xj-'))) })
    expect(receipt.status()).toBe(200)
    const accepted = (await receipt.json()).input.context.action
    expect(accepted.scope.activityId).toBe(id)
    expect(accepted.draft.question).toBe('问题甲')
    expect(accepted.works[0].value).toBe('// 固定选择甲')
    expect(accepted.draft.references[0].copy).toBe('// 固定选择甲')
    await expect(input).toHaveValue('发送后继续输入乙')
    await expect.poll(async () => (await readWorks(page, id)).files[0]?.value).toContain('// 作品乙')
    await page.reload()
    const openConversation = page.getByRole('button', { name: '打开对话', exact: true })
    await expect(input.or(openConversation).first()).toBeVisible()
    if (await openConversation.isVisible()) await openConversation.click()
    await expect(input).toHaveValue('发送后继续输入乙')
    await expect(page.locator('.monaco-editor .view-lines')).toContainText('// 作品乙')
  } finally { releaseAccept() }
})

test('course content and shared navigation keep usable widths, theme and keyboard focus', async ({ page }) => {
  const control = await resolveCredential(root, 'control')
  const manage = async (path: string, data: unknown) => {
    const response = await page.request.post(endpoint + '/api/learning/manage/' + path, { headers: { authorization: 'Bearer ' + control }, data })
    expect(response.status()).toBe(200); return response.json()
  }
  const courseId = randomUUID(), taskId = randomUUID(), releaseId = randomUUID(), materialId = randomUUID()
  const bytes = Buffer.from('可选择的课程材料，中文原文保持不变。')
  const pdfName = '随堂讲义.pdf', pdfBytes = fixedPdf(), pdfMaterialId = randomUUID()
  const deadlineAt = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const helpPolicy = { version: 1, questions: 'allowed', scope: 'course' }
  await manage('course-import', { formatVersion: 1, requestId: randomUUID(), course: { courseId, name: '课程入口回归' },
    task: { taskId, title: '实际课程任务', summary: '从固定材料进入作品' }, release: { helpPolicy,
      releaseId: randomUUID(), objectives: ['保留旧版依据'], requirements: '这是已固定的旧版要求。', materials: [], starterWorks: [], capabilities: [] }, resources: [] })
  await manage('course-import', { formatVersion: 1, requestId: randomUUID(), course: { courseId, name: '课程入口回归' },
    task: { taskId, title: '实际课程任务', summary: '从固定材料进入作品' }, release: { helpPolicy, releaseId, deadlineAt, objectives: ['保留固定依据', '验证课程结果'],
      requirements: '要求与当前作品一起容易找到。', materials: [
        { materialId, title: '课程材料', path: 'material.txt', access: 'student', mediaType: 'text/plain',
          byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
        { materialId: pdfMaterialId, title: pdfName, path: 'handout.pdf', access: 'student', mediaType: 'application/pdf',
          byteLength: pdfBytes.length, sha256: createHash('sha256').update(pdfBytes).digest('hex') },
      ], starterWorks: [], capabilities: [] },
    resources: [{ path: 'material.txt', contentBase64: bytes.toString('base64') }, { path: 'handout.pdf', contentBase64: pdfBytes.toString('base64') }] })
  const loginName = 'ui-' + randomUUID(), password = randomUUID()
  const member = await manage('members', { requestId: randomUUID(), loginName, password })
  await manage('course-access', { requestId: randomUUID(), courseId, principalId: member.principalId, active: true })
  await useEmbeddedSchoolFixture(page, endpoint, loginName, password)
  await page.setViewportSize({ width: 960, height: 900 }); await page.goto(endpoint + '/?space=school')
  await expect(page.locator('.shell')).toHaveClass(/collapsed/)
  await expect(page.locator('.main')).toHaveCSS('margin-left', '60px')
  await page.getByRole('button', { name: '切换边栏' }).click()
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.setViewportSize({ width: 960, height: 900 })
  await expect(page.locator('.shell')).not.toHaveClass(/collapsed/)
  await page.getByRole('button', { name: /外观/ }).click(); await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: /外观/ })).toBeFocused()
  const dashboard = await page.getByRole('heading', { name: '学习看板', exact: true }).elementHandle()
  await openCourseTasks(page, '课程入口回归')
  expect(await dashboard?.evaluate(element => element.isConnected)).toBe(true)
  await expect(page.locator('.course-region h2')).toContainText('课程与任务')
  await expect(page.getByRole('button', { name: '刷新任务', exact: true })).toHaveCount(0)
  const task = courseTaskCard(page, '实际课程任务')
  await expect(task.getByText('未开始', { exact: true })).toBeVisible()
  await expect(task.getByText('已逾期', { exact: true })).toBeVisible()
  await expect(task.locator('.progresslabel')).toHaveText(/任务进度.*0\/2 项\s*0%/)
  await expect(task.locator('time')).toHaveAttribute('datetime', deadlineAt)
  const search = page.getByRole('textbox', { name: '搜索任务', exact: true })
  await search.fill('不会匹配')
  await expect(task).toHaveCount(0)
  await page.getByRole('button', { name: '清除搜索', exact: true }).click()
  await expect(task).toBeVisible()
  const courseUrl = page.url()
  await task.focus(); await page.keyboard.press('Enter')
  const preview = page.getByRole('dialog', { name: '实际课程任务', exact: true })
  const centerError = (atEntrance = false) => preview.evaluate((element, atEntrance) => {
    const animation = atEntrance ? element.getAnimations()[0] : undefined
    const currentTime = animation?.currentTime ?? null
    if (animation) animation.currentTime = 0
    const rect = element.getBoundingClientRect()
    if (animation) animation.currentTime = currentTime
    return Math.max(Math.abs(rect.left + rect.width / 2 - innerWidth / 2), Math.abs(rect.top + rect.height / 2 - innerHeight / 2))
  }, atEntrance)
  expect(await centerError(true)).toBeLessThan(1)
  await expect(preview).toContainText('要求与当前作品一起容易找到。')
  await expect(preview.locator('.ws-intro-meta')).toContainText('截止')
  expect(await centerError()).toBeLessThan(1)
  await page.setViewportSize({ width: 960, height: 480 })
  await expect.poll(() => centerError()).toBeLessThan(1)
  await page.setViewportSize({ width: 960, height: 900 })
  await expect(page).toHaveURL(courseUrl)
  const version = preview.getByRole('combobox', { name: '任务发布版本', exact: true })
  await version.click()
  await preview.getByRole('option').filter({ hasNotText: '最新版本' }).click()
  await expect(preview).toContainText('这是已固定的旧版要求。')
  await page.keyboard.press('Escape')
  await expect(preview).toHaveCount(0)
  await expect(task).toBeFocused()
  await task.click()
  await expect(preview).toContainText('要求与当前作品一起容易找到。')
  await preview.getByRole('button', { name: '开始任务', exact: true }).click()
  await expect(preview).toHaveCount(0)
  const dock = page.getByRole('navigation', { name: '工作区辅助', exact: true })
  const taskInfo = dock.getByRole('button', { name: '任务信息', exact: true })
  const stash = dock.getByRole('button', { name: '卡片收纳', exact: true })
  const details = page.getByRole('complementary', { name: '目标与要求', exact: true })
  const detailsToggle = page.getByRole('button', { name: /^(收起|展开)目标与要求$/ })
  await expect(page.locator('.ws-head-utilities').getByRole('button', { name: '目标与要求', exact: true })).toHaveCount(0)
  await expect(taskInfo).toHaveAttribute('aria-expanded', 'false')
  await expect(taskInfo).toBeFocused()
  await expect(stash).toBeVisible()
  await expect(detailsToggle).toHaveAttribute('aria-expanded', 'true')
  await taskInfo.click()
  const basicInfo = page.getByRole('complementary', { name: '任务信息', exact: true })
  await expect(basicInfo).toHaveClass('ws-popcard')
  await expect(taskInfo).toHaveAttribute('aria-controls', (await basicInfo.getAttribute('id'))!)
  await expect(basicInfo.getByRole('heading', { name: '实际课程任务' })).toBeVisible()
  await expect(basicInfo).toContainText('课程入口回归')
  await expect(basicInfo.locator('time')).toHaveAttribute('datetime', deadlineAt)
  await expect(basicInfo).not.toContainText('要求与当前作品一起容易找到。')
  await expect(basicInfo.getByRole('checkbox')).toHaveCount(0)
  await expect(basicInfo.getByRole('button', { name: '课程材料', exact: true })).toHaveCount(0)
  await stash.click()
  const stashPanel = page.getByRole('complementary', { name: '卡片收纳', exact: true })
  await expect(basicInfo).toHaveCount(0)
  await expect(stashPanel).toContainText('在学习页面点「收纳」后')
  await page.keyboard.press('Escape')
  await expect(stashPanel).toHaveCount(0)
  await expect(stash).toBeFocused()
  await expect(details).toBeVisible()
  await expect(details).toContainText('要求与当前作品一起容易找到。')
  await expect(details.getByRole('heading', { name: /学习材料|PDF|个人笔记/ })).toHaveCount(0)
  await expect(details.getByRole('button', { name: '课程材料', exact: true })).toHaveCount(0)
  const firstObjective = details.getByRole('checkbox', { name: '保留固定依据', exact: true })
  await firstObjective.click()
  await expect(firstObjective).toBeChecked()
  const collapseDetails = details.getByRole('button', { name: '收起目标与要求', exact: true })
  const restoreDetails = dock.getByRole('button', { name: '展开目标与要求', exact: true })
  const workArea = page.locator('.product-workspace .ws-center')
  const expandedWidth = (await workArea.boundingBox())!.width
  await collapseDetails.click()
  await expect(details).toHaveCount(0)
  await expect(restoreDetails).toBeFocused()
  await expect.poll(async () => (await workArea.boundingBox())!.width).toBeGreaterThan(expandedWidth)
  await restoreDetails.press('Enter')
  await expect(collapseDetails).toBeFocused()
  await expect(firstObjective).toBeChecked()
  await taskInfo.click()
  await expect(basicInfo.locator('.progresslabel')).toHaveText(/任务进度\s*50%/)
  await page.keyboard.press('Escape')
  await expect(basicInfo).toHaveCount(0)
  await expect(taskInfo).toBeFocused()
  const resourceTab = page.getByRole('tab', { name: '学习资料', exact: true })
  const resourceNav = page.getByRole('group', { name: '资料分类' })
  const courseMaterialsTab = resourceNav.getByRole('button', { name: '课程材料', exact: true })
  const library = page.getByRole('region', { name: '课程材料', exact: true })
  await resourceTab.click()
  await expect(courseMaterialsTab).toHaveAttribute('aria-pressed', 'true')
  await library.getByRole('button', { name: '课程材料', exact: true }).click()
  const reader = page.getByRole('region', { name: '课程材料阅读', exact: true })
  await expect(reader).toContainText(bytes.toString())
  await expect(details).toHaveCount(0)
  await reader.getByRole('button', { name: '返回材料列表', exact: true }).click()
  await expect(library.getByRole('button', { name: '课程材料', exact: true })).toBeVisible()
  const pdfTab = resourceNav.getByRole('button', { name: '个人 PDF', exact: true })
  const pdfList = page.getByRole('region', { name: '个人 PDF', exact: true })
  const pdfReader = page.getByRole('region', { name: 'PDF 阅读区', exact: true })
  await page.route('**/api/learning/pdf/*/course', async route => {
    await route.fetch()
    await route.abort('failed')
  }, { times: 1 })
  await library.getByRole('button', { name: pdfName, exact: true }).click()
  const retryLabel = '核对并继续原请求'
  const courseRetry = library.getByRole('button', { name: retryLabel, exact: true })
  await expect(courseRetry).toBeEnabled()
  await pdfTab.click()
  await expect(pdfList.getByRole('button', { name: retryLabel, exact: true })).toHaveCount(0)
  await courseMaterialsTab.click()
  await courseRetry.click()
  await expect(courseMaterialsTab).toHaveAttribute('aria-pressed', 'true')
  await expect(pdfReader.getByRole('img', { name: 'PDF 第 1 页固定页图', exact: true })).toBeVisible()
  await expect(pdfReader.getByRole('heading', { name: pdfName, exact: true })).toBeVisible()
  await expect(pdfReader.getByRole('button', { name: '返回作品', exact: true })).toHaveCount(0)
  const pdfTools = pdfReader.getByRole('button', { name: 'PDF 工具侧栏', exact: true })
  await expect(pdfTools).toHaveAttribute('aria-expanded', 'true')
  await pdfReader.getByRole('button', { name: '引用此页', exact: true }).click()
  await pdfReader.getByRole('button', { name: '返回材料列表', exact: true }).click()
  await pdfTab.click()
  await expect(pdfList.getByRole('button', { name: '添加 PDF', exact: true })).toBeEnabled()
  await expect(pdfList.getByRole('button', { name: pdfName, exact: true })).toHaveCount(0)
  await pdfList.locator('input[type=file]').setInputFiles({ name: pdfName, mimeType: 'application/pdf', buffer: pdfBytes })
  const cover = pdfReader.getByRole('img', { name: 'PDF 第 1 页固定页图', exact: true })
  await expect(cover).toBeVisible()
  await expect(pdfTools).toHaveAttribute('aria-expanded', 'true')
  const defaultZoom = pdfReader.getByRole('button', { name: '默认', exact: true })
  const fitWidth = pdfReader.getByRole('button', { name: '适合宽度', exact: true })
  const fitPage = pdfReader.getByRole('button', { name: '适合整页', exact: true })
  const zoomSlider = pdfReader.getByRole('slider', { name: 'PDF 缩放比例' })
  await expect(defaultZoom).toHaveAttribute('aria-pressed', 'true')
  const fitWidthTip = fitWidth.locator('.pdf-zoom-stop-tip')
  await expect(fitWidthTip).toBeHidden()
  await fitWidth.hover()
  await expect(fitWidthTip).toBeVisible()
  await expect(fitWidthTip).toHaveText('适合宽度')
  await fitWidth.click()
  await expect(fitWidth).toHaveAttribute('aria-pressed', 'true')
  const expandedPdfWidth = (await cover.boundingBox())!.width
  await pdfTools.click()
  await expect(pdfTools).toHaveAttribute('aria-expanded', 'false')
  await expect.poll(async () => (await cover.boundingBox())!.width).toBeGreaterThan(expandedPdfWidth)
  await pdfTools.click()
  await expect(pdfTools).toHaveAttribute('aria-expanded', 'true')
  await defaultZoom.click()
  await pdfReader.getByRole('button', { name: '相邻两页', exact: true }).click()
  const secondPage = pdfReader.getByRole('img', { name: 'PDF 第 2 页固定页图', exact: true })
  await expect(secondPage).toBeVisible()
  await expect.poll(async () => (await secondPage.boundingBox())!.y - (await cover.boundingBox())!.y).toBeGreaterThan(30)
  await page.setViewportSize({ width: 1600, height: 900 })
  await pdfTools.click()
  await expect.poll(async () => (await secondPage.boundingBox())!.y - (await cover.boundingBox())!.y).toBe(0)
  await expect.poll(async () => (await secondPage.boundingBox())!.x - (await cover.boundingBox())!.x).toBeGreaterThan(30)
  await page.setViewportSize({ width: 960, height: 900 })
  await pdfTools.click()
  const thumbnailList = pdfReader.getByRole('navigation', { name: 'PDF 页面缩略图' })
  await expect(thumbnailList).toHaveCount(0)
  await pdfReader.getByText('页面缩略图', { exact: true }).click()
  await expect(thumbnailList.locator('canvas:not([hidden])')).toHaveCount(2)
  await thumbnailList.getByRole('button', { name: '第 2 页', exact: true }).click()
  await expect(thumbnailList.getByRole('button', { name: '第 2 页', exact: true })).toHaveAttribute('aria-current', 'page')
  await expect(pdfReader.getByText('页标签 7', { exact: true })).toBeVisible()
  await expect(zoomSlider).toBeEnabled()
  const initialZoom = Number(await zoomSlider.inputValue())
  await zoomSlider.press('ArrowRight')
  await expect(zoomSlider).toHaveValue(String(initialZoom + 1))
  await zoomSlider.press('ArrowLeft')
  await expect(zoomSlider).toHaveValue(String(initialZoom))
  await page.keyboard.press('Tab')
  await expect(fitPage).toBeFocused()
  await expect(fitPage.locator('.pdf-zoom-stop-tip')).toBeVisible()
  await fitPage.click()
  await expect(fitPage).toHaveAttribute('aria-pressed', 'true')
  const textLayer = pdfReader.locator('.pdf-page-text[data-text-state="ready"]')
  const run = textLayer.getByText('Fixed evidence: 37 volts', { exact: true })
  await expect(run).toBeVisible()
  await pdfTools.click()
  await pdfReader.locator('.pdf-reading').press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f')
  const findToggle = pdfReader.getByRole('button', { name: '查找文字', exact: true })
  const pdfSearch = pdfReader.getByRole('searchbox', { name: '当前页文字查找' })
  const findStatus = pdfReader.getByRole('search', { name: 'PDF 页内查找' }).getByRole('status')
  await expect(pdfSearch).toBeFocused()
  await expect(pdfTools).toHaveAttribute('aria-expanded', 'false')
  await pdfSearch.fill('e')
  await expect(findStatus).toHaveText('1 / 4')
  await pdfReader.getByRole('button', { name: '下一处匹配', exact: true }).click()
  await expect(findStatus).toHaveText('2 / 4')
  await pdfSearch.press('Shift+Enter')
  await expect(findStatus).toHaveText('1 / 4')
  await expect.poll(() => page.evaluate(() => CSS.highlights.get('xunjie-pdf-find')?.size)).toBe(4)
  await expect.poll(() => page.evaluate(() => CSS.highlights.get('xunjie-pdf-find-active')?.size)).toBe(1)
  await pdfSearch.press('Escape')
  await expect(pdfSearch).toBeHidden()
  await expect(findToggle).toBeFocused()
  const bounds = (await run.boundingBox())!
  await page.mouse.move(bounds.x + 1, bounds.y + bounds.height / 2)
  await page.mouse.down()
  await page.mouse.move(bounds.x + bounds.width - 1, bounds.y + bounds.height / 2, { steps: 8 })
  await page.mouse.up()
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('Fixed evidence: 37 volts')
  await page.evaluate(() => Object.defineProperty(navigator.clipboard, 'writeText', {
    configurable: true, value: async (text: string) => { document.documentElement.dataset.copiedPdfText = text },
  }))
  await pdfReader.getByRole('button', { name: '复制选中文字', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-copied-pdf-text', 'Fixed evidence: 37 volts')
  await page.evaluate(() => {
    Reflect.deleteProperty(navigator.clipboard, 'writeText')
    delete document.documentElement.dataset.copiedPdfText
  })
  await pdfTools.click()
  await pdfReader.getByRole('button', { name: '框选区域', exact: true }).click()
  await expect(textLayer).toBeHidden()
  await page.keyboard.press('Escape')
  await expect(textLayer).toBeVisible()
  await pdfTools.click()
  await expect(pdfTools).toHaveAttribute('aria-expanded', 'false')
  await pdfReader.getByRole('button', { name: '返回 PDF 列表', exact: true }).click()
  await expect(pdfList.getByRole('button', { name: pdfName, exact: true })).toBeVisible()
  const references = page.getByRole('region', { name: '上下文引用', exact: true })
  await references.getByRole('button', { name: /^定位引用 1：随堂讲义/ }).click()
  await expect(courseMaterialsTab).toHaveAttribute('aria-pressed', 'true')
  await expect(pdfReader.getByRole('heading', { name: pdfName, exact: true })).toBeVisible()
  await expect(pdfReader.getByRole('img', { name: 'PDF 第 1 页固定页图', exact: true })).toBeVisible()
  await expect(pdfTools).toHaveAttribute('aria-expanded', 'true')
  await pdfReader.getByRole('button', { name: '返回材料列表', exact: true }).click()
  await references.getByRole('button', { name: '移除引用 1', exact: true }).click()
  await page.getByRole('button', { name: '收起对话', exact: true }).click()
  const notesTab = resourceNav.getByRole('button', { name: '个人笔记', exact: true })
  const notes = page.getByRole('region', { name: '个人笔记', exact: true })
  await notesTab.click()
  await notes.getByRole('button', { name: '添加笔记', exact: true }).click()
  await notes.getByRole('textbox', { name: '个人笔记名称', exact: true }).fill('课程随记')
  const noteText = notes.getByRole('textbox', { name: '个人笔记正文', exact: true })
  await noteText.fill('在任务要求之外记录自己的思路。')
  await pdfTab.click()
  await notesTab.click()
  await expect(noteText).toHaveValue('在任务要求之外记录自己的思路。')
  await notes.getByRole('button', { name: '保存笔记', exact: true }).click()
  await expect(notes.getByText('课程随记', { exact: true })).toBeVisible()
  await notes.getByRole('button', { name: '课程随记', exact: true }).click()
  const noteReader = page.getByRole('region', { name: '个人笔记阅读区', exact: true })
  await expect(noteReader).toContainText('在任务要求之外记录自己的思路。')
  await noteReader.getByRole('button', { name: '返回笔记列表', exact: true }).click()
  await expect(notes.getByText('课程随记', { exact: true })).toBeVisible()
  await page.getByRole('tab', { name: '作品', exact: true }).click()
  await newFile(page, '中文.txt')
  const cdp = await page.context().newCDPSession(page)
  // Browser IME protocol; physical OS input is measured separately in the platform evidence.
  await cdp.send('Input.imeSetComposition', { text: '你好', selectionStart: 2, selectionEnd: 2 })
  await cdp.send('Input.insertText', { text: '你好' })
  await page.keyboard.press('Enter')
  await cdp.send('Input.imeSetComposition', { text: '世界', selectionStart: 2, selectionEnd: 2 })
  await cdp.send('Input.insertText', { text: '世界' })
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('你好')
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('世界')
  const courseActivity = new URL(page.url()).searchParams.get('activity')!
  await expect.poll(async () => (await (await page.request.get(endpoint + '/api/learning/workspaces/' + courseActivity,
    { headers: { 'x-xj-space': 'school' } })).json()).files[0]?.value).toBe('你好\n世界')
  await page.getByRole('button', { name: '提交作品', exact: true }).click()
  const submission = page.getByRole('dialog', { name: '提交作品', exact: true })
  await submission.getByRole('button', { name: '确认提交', exact: true }).click()
  await expect(submission.getByRole('region', { name: '我的提交记录', exact: true })).toContainText('学校已接收')
  await submission.getByRole('button', { name: '返回作品', exact: true }).click()
  await manage('course-import', { formatVersion: 1, requestId: randomUUID(), course: { courseId, name: '课程入口回归' },
    task: { taskId, title: '实际课程任务', summary: '从固定材料进入作品' }, release: { helpPolicy,
      releaseId: randomUUID(), objectives: ['显式选用新版'], requirements: '这是随后发布的要求。', materials: [], starterWorks: [], capabilities: [] }, resources: [] })
  await page.getByRole('button', { name: '返回活动列表', exact: true }).click()
  await expect(task).toContainText('继续任务')
  await expect(task.getByText('已提交', { exact: true })).toBeVisible()
  await expect(task.getByText('已逾期', { exact: true })).toHaveCount(0)
  await expect(task.locator('.progresslabel')).toHaveText(/任务进度.*1\/2 项\s*50%/)
  await expect(task.locator('time')).toHaveAttribute('datetime', deadlineAt)
  await task.click()
  await expect(preview).toContainText('要求与当前作品一起容易找到。')
  await version.click()
  await preview.getByRole('option').filter({ hasText: '最新版本' }).click()
  await expect(preview).toContainText('这是随后发布的要求。')
  await expect(preview.locator('.ws-intro-meta')).toContainText('无截止时间')
  await expect(preview).toContainText('当前进度 0%')
  await expect(preview.getByRole('button', { name: '开始任务', exact: true })).toBeEnabled()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '全部课程', exact: true }).click()
  await expect(page.getByRole('region', { name: '我的学习活动', exact: true })).toHaveCount(0)
  await openCourseTasks(page, '课程入口回归')
  await task.click()
  await preview.getByRole('button', { name: '继续任务', exact: true }).click()
  await expect(page).toHaveURL(url => url.searchParams.get('activity') === courseActivity)
  await expect(preview).toHaveCount(0)
  await expect(taskInfo).toBeFocused()
  await expect(firstObjective).toBeChecked()
  await detailsToggle.click()
  await expect(details).toHaveCount(0)
  await expect(detailsToggle).toHaveAccessibleName('展开目标与要求')
  await detailsToggle.press('Enter')
  await expect(details).toBeVisible()
  await expect(detailsToggle).toHaveAccessibleName('收起目标与要求')
  await detailsToggle.press('Enter')
  await expect(details).toHaveCount(0)
  await expect.poll(async () => {
    const response = await page.request.get(endpoint + '/api/learning/activities', { headers: { 'x-xj-space': 'school' } })
    const items = await response.json() as { activityId: string; course?: { taskId: string } }[]
    return items.filter(item => item.course?.taskId === taskId).map(item => item.activityId)
  }).toEqual([courseActivity])
  await page.getByRole('button', { name: '打开对话', exact: true }).click()
  await page.getByRole('button', { name: '收起对话', exact: true }).click()
  await expect(page.getByRole('button', { name: '打开对话', exact: true })).toBeFocused()
  expect(await page.locator('.ws').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  const cardTitle = '收纳回归学习卡'
  const published = await page.request.post(endpoint + '/api/learning/artifacts/' + courseActivity, {
    headers: { 'x-xj-space': 'school' }, data: { requestId: randomUUID(), payload: {
      formatVersion: 1, title: cardTitle, display: 'card', hostApiVersion: 1,
      html: '<label>我的解释<textarea></textarea></label>', css: '',
      javascript: '(async()=>{const {content}=await window.xunjie.read();const field=document.querySelector("textarea");field.value=content.answer;field.addEventListener("input",()=>window.xunjie.change({answer:field.value}));})();',
      stateVersion: 1, stateShape: { type: 'object', properties: { answer: { type: 'string', maxLength: 400 } } },
      initialState: { answer: '' }, semanticFields: [{ key: 'answer', meaning: '原回答' }], semanticObjects: [],
      requiredCapabilities: ['workspace.read', 'workspace.change'],
    } },
  })
  expect(published.status()).toBe(200)
  const { artifactId, revisionId } = await published.json()
  await page.getByRole('button', { name: '打开对话', exact: true }).click()
  const card = page.locator(`.teaching-artifact-card[data-artifact-id="${artifactId}"]`)
  await expect(card).toHaveAttribute('data-revision-id', revisionId)
  await card.getByRole('button', { name: '收纳', exact: true }).click()
  await page.getByRole('button', { name: '收起对话', exact: true }).click()
  await expect(stash.locator('.ws-dock-badge')).toHaveText('1')
  await stash.click()
  await stashPanel.getByRole('button', { name: cardTitle, exact: true }).click()
  await expect(stashPanel).toHaveCount(0)
  await expect(page.locator(`.teaching-artifact-center[data-artifact-id="${artifactId}"]`)).toHaveAttribute('data-revision-id', revisionId)
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  if (output) await page.screenshot({ path: join(output, 'course-narrow-dark.png') })
})

test('home citations open the pinned course text and PDF page, then respect course access revocation', async ({ page }) => {
  const control = await resolveCredential(root, 'control')
  async function manage(path: string, data: unknown) {
    const response = await page.request.post(endpoint + '/api/learning/manage/' + path, {
      headers: { authorization: 'Bearer ' + control }, data,
    })
    expect(response.status()).toBe(200)
    return response.json()
  }
  const courseId = randomUUID(), taskId = randomUUID(), oldRelease = randomUUID()
  const loginName = 'citation-' + randomUUID(), password = randomUUID()
  const student = await manage('members', { requestId: randomUUID(), loginName, password })
  const textBytes = Buffer.from('前缀固定讲义后缀')
  const pdfObjects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = pdfObjects.map((object, index) => {
    const offset = pdf.length
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
    return offset
  })
  const xref = pdf.length
  pdf += `xref\n0 5\n0000000000 65535 f \n${offsets.map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  const pdfBytes = Buffer.from(pdf)
  const material = (title: string, path: string, mediaType: string, bytes: Buffer) => ({
    materialId: randomUUID(), title, path, mediaType, access: 'student', sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length,
  })
  const oldText = material('原版讲义', 'old.txt', 'text/plain', textBytes)
  const oldPdf = material('原版双页讲义', 'old.pdf', 'application/pdf', pdfBytes)
  const publish = (releaseId: string, items: ReturnType<typeof material>[], contents: Buffer[]) => manage('course-import', {
    formatVersion: 1, requestId: randomUUID(), course: { courseId, name: '课程出处回归' },
    task: { taskId, title: '阅读讲义', summary: '' },
    release: { releaseId, helpPolicy: { version: 1, questions: 'allowed', scope: 'course' }, objectives: ['阅读固定版本'],
      requirements: '核对引用范围', materials: items, starterWorks: [], capabilities: [] },
    resources: items.map((item, index) => ({ path: item.path, contentBase64: contents[index]!.toString('base64') })),
  })
  await publish(oldRelease, [oldText, oldPdf], [textBytes, pdfBytes])
  const newText = Buffer.from('新版正文不可代替旧版')
  await publish(randomUUID(), [material('新版讲义', 'new.txt', 'text/plain', newText)], [newText])
  const setAccess = (active: boolean) => manage('course-access', { requestId: randomUUID(), courseId, principalId: student.principalId, active })
  await setAccess(true)
  expect((await page.request.post(endpoint + '/api/learning/login', { data: { loginName, password } })).status()).toBe(200)
  const releases = await page.request.get(endpoint + '/api/learning/releases/' + oldRelease, { headers: { 'x-xj-space': 'school' } })
  expect(releases.ok()).toBe(true)
  const { contentDigest } = await releases.json()
  const sessionId = randomUUID(), turnId = randomUUID(), stepId = randomUUID()
  const created = await page.request.post(endpoint + '/api/learning/agent-sessions', {
    headers: { 'x-xj-space': 'personal', 'x-xj-agent-contract': '3' },
    data: { requestId: randomUUID(), sessionId, scenario: 'student-assistant', title: '课程出处回归' },
  })
  expect(created.ok()).toBe(true)
  const cite = (item: typeof oldText, range: Record<string, number>) => ({ turnId, stepId, citation: {
    citationId: randomUUID(), claim: item.title, label: item.title, version: item.sha256, digest: item.sha256, range,
    source: { kind: 'course-material', courseId, taskId, releaseId: oldRelease, materialId: item.materialId,
      materialSha256: item.sha256, mediaType: item.mediaType, contentDigest },
  } })
  const conversation: AgentConversation = { sessionId, lastSeq: 1, reset: true,
    turns: [], inputs: [], questions: [], tools: [], workspaces: [],
    messages: [{ messageId: 'assistant:fixture', turnId, stepId, role: 'assistant', text: '请核对讲义。',
      createdAt: new Date().toISOString(), state: 'settled' }],
    citations: [cite(oldText, { offset: 2, length: 4 }), cite(oldPdf, { page: 2 })],
  }
  await page.route('**/agent-sessions/' + sessionId + '/conversation?*', route => route.fulfill({ json: conversation }))
  await page.goto(endpoint + '/?space=personal&view=agent&session=' + sessionId)
  const textCitation = page.getByRole('button', { name: /原版讲义/ })
  await expect(textCitation).toBeVisible()
  await textCitation.click()
  const textReader = page.getByRole('region', { name: oldText.title, exact: true })
  await expect(textReader).toContainText('固定讲义')
  await expect(textReader).not.toContainText(/前缀|后缀|新版正文/)
  await textReader.getByRole('button', { name: '返回对话' }).click()
  const pdfCitation = page.getByRole('button', { name: /原版双页讲义/ })
  const pdfResponse = page.waitForResponse(response => response.ok() && response.url().endsWith('/releases/' + oldRelease + '/materials/' + oldPdf.materialId))
  await pdfCitation.click()
  const pdfOriginal = await (await pdfResponse).json()
  expect(Buffer.from(pdfOriginal.contentBase64, 'base64')).toEqual(pdfBytes)
  const original = page.getByRole('link', { name: '打开 PDF 第 2 页' })
  await expect(original).toHaveAttribute('href', /^blob:.*#page=2$/)
  const target = await original.getAttribute('href')
  const opened = page.context().waitForEvent('page')
  await original.click()
  const pdfViewer = await opened
  await expect(pdfViewer).toHaveURL(target!)
  await pdfViewer.close()
  await setAccess(false)
  await pdfCitation.click()
  await expect(page.getByText('这份课程资料的固定版本当前无法读取，原出处仍保留。')).toBeVisible()
  await expect(original).toHaveCount(0)
  await expect(pdfCitation).toBeVisible()
})

test('retained ALU v4 runs after a new release and a home citation is revoked by local school logout', async ({ page }) => {
  test.setTimeout(180_000)
  const rootAdmin = { authorization: 'Bearer ' + await resolveCredential(root, 'control') }
  const request = async (route: string, data?: unknown, headers: Record<string, string> = {}) => {
    const url = endpoint + '/api/learning/' + route
    const response = data === undefined ? await page.request.get(url, { headers })
      : await page.request.post(url, { data, headers })
    expect(response.status(), route).toBe(200)
    return response.json()
  }
  const manage = (route: string, data: unknown) => request('manage/' + route, data, rootAdmin)
  const definition = await manage('component-import', await aluPackage())
  const latest = await aluCoursePackage()
  latest.release.components![0]!.definition = definition
  const old = structuredClone(latest)
  old.requestId = randomUUID()
  old.release.releaseId = randomUUID()
  old.release.helpPolicy = { version: 1, questions: 'allowed', scope: 'course' }
  const loginName = 'old-alu-' + randomUUID(), password = randomUUID()
  const member = await manage('members', { requestId: randomUUID(), loginName, password })
  await manage('course-import', old)
  await manage('course-access', { requestId: randomUUID(), courseId: old.course.courseId,
    principalId: member.principalId, active: true })
  const login = () => request('login', { loginName, password })
  await login()
  const namespace = (await request('context')).clientNamespace
  const school = { 'x-xj-space': 'school', 'x-xj-namespace': namespace }
  const personal = { 'x-xj-space': 'personal', 'x-xj-namespace': namespace, 'x-xj-agent-contract': '3' }
  const activity = await request('course-activities', { requestId: randomUUID(), releaseId: old.release.releaseId }, school)
  await manage('course-import', latest)
  const reopened = await request('activities/' + activity.activityId, undefined, school)
  expect(reopened.course.releaseId).toBe(old.release.releaseId)
  expect(reopened.course.components[0].definition.digest).toBe(definition.digest)
  await page.goto(endpoint + '/?space=school&activity=' + activity.activityId)
  await expect(page.locator('#activity-title')).toHaveText(old.task.title)
  await page.getByRole('tab', { name: '作品', exact: true }).click()
  const editor = page.locator('.monaco-editor .view-lines').first()
  await editor.click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.insertText('module alu(input logic [3:0] A, B, input logic M, input logic [1:0] S, input logic Cin, output logic [3:0] F, output logic Cout); assign F = ~A; assign Cout = 0; endmodule')
  await page.getByRole('tab', { name: 'ALU 实验', exact: true }).click()
  const run = page.getByRole('button', { name: '运行', exact: true }).first()
  await expect(run).toBeEnabled({ timeout: 60000 })
  const displayReceipts: { status: number; code?: string }[] = []
  page.on('response', async response => {
    if (!response.url().endsWith('/displayed')) return
    const body = await response.json()
    displayReceipts.push({ status: response.status(), ...(body.error ? { code: body.error } : {}) })
  })
  await run.click()
  const readout = page.locator('.alu-readout-value').last()
  await expect(readout).toContainText('F=1111', { timeout: 65000 })
  await readout.scrollIntoViewIfNeeded()
  const getExecution = async () => (await request('executions/' + activity.activityId + '/history', undefined, school))
    .entries.find((entry: { query: { state: string; output?: { output?: { f: string } } } }) =>
      entry.query.state === 'succeeded' && entry.query.output?.output?.f === '1111')
  await expect.poll(async () => !!await getExecution(), { timeout: 20000 }).toBe(true)
  const { action, query } = await getExecution()
  await expect.poll(() => displayReceipts, { timeout: 10000 }).toContainEqual({ status: 200 })
  expect(action.execution.instance.componentVersion).toBe(4)
  await page.getByRole('button', { name: '到主页追问', exact: true }).click()
  await expect(page).toHaveURL(url => url.searchParams.get('view') === 'agent'
    && url.searchParams.get('space') === 'personal' && !url.searchParams.has('activity'))
  await expect(page.getByText(/已固定工作区实验/)).toBeVisible()
  const fixedExperiment = await page.evaluate(namespace =>
    JSON.parse(sessionStorage.getItem('xj.agent-experiment.' + namespace) ?? 'null'), namespace)
  expect(fixedExperiment).toMatchObject({ activityId: activity.activityId, requestId: query.requestId })
  const ref = { activityId: activity.activityId, requestId: query.requestId, executionRef: query.executionRef,
    inputDigest: query.inputDigest, label: '原 ALU 观察',
    source: { kind: 'component', formatVersion: 1, ...action.scope, origin: 'execution-result',
      instanceId: action.execution.instance.instanceId, componentId: action.execution.instance.componentId,
      componentVersion: 4, definitionDigest: definition.digest, bindingKey: 'alu', objectId: query.requestId,
      contentId: query.output.contentId, requestId: query.requestId, executionRef: query.executionRef } }
  const payloads: string[] = []
  const upstream = createServer(async (incoming, response) => {
    const chunks = []
    for await (const chunk of incoming) chunks.push(chunk)
    payloads.push(Buffer.concat(chunks).toString())
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: '已核对当前依据。' }, finish_reason: 'stop' }] })
      + '\n\ndata: [DONE]\n\n')
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  try {
    const address = upstream.address()
    if (!address || typeof address === 'string') throw new Error('Fixture model has no loopback port')
    const connectionId = randomUUID()
    await request('models/connections', { requestId: randomUUID(), connectionId, expectedVersion: 0, name: 'ALU authorization fixture',
      protocol: 'chat-completions', baseUrl: `http://127.0.0.1:${address.port}/v1`, path: '/chat/completions',
      modelId: 'alu-auth-fixture', dialect: 'standard', parameterMode: 'plain', enabled: true,
      contextWindow: 128_000, maxOutputTokens: 1024, credential: { action: 'replace', value: 'synthetic-alu-auth-model' } }, personal)
    const selection = await request('models/selection', undefined, personal)
    await request('models/selection', { requestId: randomUUID(), expectedVersion: selection.version,
      source: { kind: 'personal', connectionId, owner: 'self' } }, personal)
    const sessionId = randomUUID(), route = 'agent-sessions/' + sessionId
    await request('agent-sessions', { requestId: randomUUID(), sessionId, scenario: 'student-assistant' }, personal)
    const ask = async (text: string, attach = true) => {
      const before = payloads.length
      const receipt = await request(route + '/inputs', { requestId: randomUUID(), sessionId, text,
        context: attach ? { experimentReferences: [ref] } : {} }, personal)
      await expect.poll(async () => (await request(route + '/runs/' + receipt.turnId, undefined, personal)).state,
        { timeout: 25000 }).toBe('completed')
      expect(payloads).toHaveLength(before + 1)
      const messages = JSON.parse(payloads.at(-1)!).messages as { role: string; content: unknown }[]
      return messages.filter(message => message.role !== 'system').map(message => JSON.stringify(message.content)).join('\n')
    }
    const hasVerifiedResult = (messages: string) => messages.includes('hostVerifiedStage') && messages.includes('1111')
    expect(hasVerifiedResult(await ask('登录后核对原实验'))).toBe(true)
    await request('logout', {}, school)
    const after = await ask('退出后重新核对原实验')
    expect(hasVerifiedResult(after)).toBe(false)
    expect(after.includes('原实验当前不可访问')).toBe(true)
    await login()
    expect(hasVerifiedResult(await ask('仅重新登录后核对先前上下文', false))).toBe(false)
    expect(hasVerifiedResult(await ask('重新登录并授权后核对原实验'))).toBe(true)
  } finally { upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())) }
})

test('a late browser-history activity read cannot reopen the activity after forward returns to the list', async ({ page }) => {
  const goal = '历史活动读取-' + randomUUID()
  const id = await newActivity(page, goal)
  await page.getByRole('button', { name: '返回活动列表', exact: true }).click()
  await expect(page.locator(`[data-activity-id="${id}"]`)).toContainText(goal)
  let releaseRead!: () => void, reading!: () => void, delivered!: () => void
  const held = new Promise<void>(resolve => { releaseRead = resolve })
  const started = new Promise<void>(resolve => { reading = resolve })
  const finished = new Promise<void>(resolve => { delivered = resolve })
  await page.route('**/api/learning/activities/' + id, async route => {
    const response = await route.fetch(); reading(); await held
    try { await route.fulfill({ response }) }
    catch (cause) { if (!(cause instanceof Error) || !/already handled/.test(cause.message)) throw cause }
    finally { delivered() }
  })
  try {
    await page.goBack(); await started
    await page.goForward()
    await expect(page.locator('.product-home')).toBeVisible()
    releaseRead(); await finished
    await page.unroute('**/api/learning/activities/' + id)
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await expect(page.locator('#activity-title')).toHaveCount(0)
    expect(new URL(page.url()).searchParams.has('activity')).toBe(false)
  } finally { releaseRead() }
})

test('course browser history retires both visible and in-flight release details from the other course', async ({ page }) => {
  const courses = await courseHistoryFixture(page)
  await page.goto(endpoint + '/?space=school')
  await openCourseTasks(page, '课程历史 A')
  await page.getByRole('button', { name: '全部课程', exact: true }).click()
  await openCourseTasks(page, '课程历史 B')
  await courseTaskCard(page, courses[1].title).click()
  await expect(page.getByRole('dialog', { name: courses[1].title })).toContainText('核对当前课程')
  await page.goBack()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.goBack()
  await expect(page.locator('.course-breadcrumb')).toContainText(courses[0].name)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  let releaseRead!: () => void, reading!: () => void, delivered!: () => void
  const held = new Promise<void>(resolve => { releaseRead = resolve })
  const started = new Promise<void>(resolve => { reading = resolve })
  const finished = new Promise<void>(resolve => { delivered = resolve })
  await page.route('**/api/learning/releases/' + courses[0].releaseId, async route => {
    const response = await route.fetch(); reading(); await held; await route.fulfill({ response }); delivered()
  })
  try {
    await courseTaskCard(page, courses[0].title).click(); await started
    await page.goBack(); releaseRead(); await finished
    await page.unroute('**/api/learning/releases/' + courses[0].releaseId)
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await expect(page.getByRole('dialog')).toHaveCount(0)
  } finally { releaseRead() }
})

test('an initial activity reopen cannot undo browser back to the list while its read is pending', async ({ page }) => {
  const id = await openPersonalActivityFromHome(page)
  await page.getByRole('button', { name: '返回活动列表', exact: true }).click()
  await expect(page.locator(`[data-activity-id="${id}"]`)).toBeVisible()
  await page.goto(endpoint + '/?space=personal&activity=' + id)
  await expect(page.locator('#activity-title')).toBeVisible()
  let releaseRead!: () => void, reading!: () => void, delivered!: () => void
  const held = new Promise<void>(resolve => { releaseRead = resolve })
  const started = new Promise<void>(resolve => { reading = resolve })
  const finished = new Promise<void>(resolve => { delivered = resolve })
  await page.route('**/api/learning/activities/' + id, async route => {
    const response = await route.fetch(); reading(); await held
    try { await route.fulfill({ response }) }
    catch (cause) { if (!(cause instanceof Error) || !/already handled/.test(cause.message)) throw cause }
    finally { delivered() }
  })
  try {
    await page.reload(); await started
    await page.goBack()
    await expect(page.locator('.product-home')).toBeVisible()
    releaseRead(); await finished
    await page.unroute('**/api/learning/activities/' + id)
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await expect(page.locator('#activity-title')).toHaveCount(0)
    expect(new URL(page.url()).searchParams.has('activity')).toBe(false)
  } finally { releaseRead() }
})

async function courseHistoryFixture(page: Page, withComponent = false) {
  const control = await resolveCredential(root, 'control')
  const manage = async (path: string, data: unknown) => {
    const response = await page.request.post(endpoint + '/api/learning/manage/' + path, { headers: { authorization: 'Bearer ' + control }, data })
    expect(response.status()).toBe(200); return response.json()
  }
  const loginName = 'history-' + randomUUID(), password = randomUUID()
  const member = await manage('members', { requestId: randomUUID(), loginName, password })
  const definition = withComponent ? await manage('component-import', { requestId: randomUUID(), ...await annotationPackage() }) : undefined
  const courses: { courseId: string; releaseId: string; name: string; title: string }[] = []
  for (const label of ['A', 'B']) {
    const courseId = randomUUID(), releaseId = randomUUID(), name = '课程历史 ' + label, title = '发布任务 ' + label
    await manage('course-import', { formatVersion: 1, requestId: randomUUID(), course: { courseId, name },
      task: { taskId: randomUUID(), title, summary: '' }, release: { helpPolicy: { version: 1, questions: 'allowed', scope: 'course' },  releaseId, objectives: ['固定课程依据'], requirements: '核对当前课程', materials: [], starterWorks: [], capabilities: [],
        ...(definition ? { components: [{ key: 'annotation', definition, configuration: { title: '材料标注' }, materialIds: [] }] } : {}) }, resources: [] })
    await manage('course-access', { requestId: randomUUID(), courseId, principalId: member.principalId, active: true })
    courses.push({ courseId, releaseId, name, title })
  }
  await useEmbeddedSchoolFixture(page, endpoint, loginName, password)
  return courses
}

test('component-only navigation protects an unretained action and its independent later question draft', async ({ page }) => {
  const [course] = await courseHistoryFixture(page, true)
  const created = await page.request.post(endpoint + '/api/learning/course-activities', { data: { requestId: randomUUID(), releaseId: course.releaseId } })
  expect(created.status()).toBe(200); const activity = await created.json()
  await page.goto(endpoint + '?space=school&activity=' + activity.activityId)
  await page.getByRole('tab', { name: '材料标注', exact: true }).click()
  await expect(page.frameLocator('iframe[title="材料标注"]').getByRole('button', { name: '标注选中文字' })).toBeEnabled()
  await page.getByRole('button', { name: '打开对话', exact: true }).click()
  const input = page.getByRole('textbox', { name: '你的问题', exact: true })
  await input.fill('动作中固定的问题')
  await expect(page.getByRole('button', { name: '发送问题', exact: true })).toBeEnabled()
  await page.evaluate(() => {
    Object.assign(window, { actionStorageBlocked: true })
    const original = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function(...args) {
      if (this.name === 'actions' && (window as unknown as { actionStorageBlocked: boolean }).actionStorageBlocked)
        throw new DOMException('Controlled action storage refusal', 'QuotaExceededError')
      return Reflect.apply(original, this, args)
    }
  })
  const release = receiver.holdAccept()
  try {
    await page.getByRole('button', { name: '发送问题', exact: true }).click()
    await expect(page.getByText('尚未可靠保留', { exact: true })).toBeVisible()
    await input.fill('发送后继续写的独立草稿')
    await page.getByRole('button', { name: '返回活动列表', exact: true }).click()
    await expect(page.locator('.product-workspace-notice [role="alert"]').first()).toBeVisible()
    await expect(page.locator('iframe[title="材料标注"]')).toBeVisible()
    await expect(input).toHaveValue('发送后继续写的独立草稿')
    await page.evaluate(() => { Object.assign(window, { actionStorageBlocked: false }) })
    await page.getByRole('button', { name: '返回活动列表', exact: true }).click()
    await expect(page.locator('#activity-title')).toHaveCount(0)
    await page.locator(`[data-activity-id="${activity.activityId}"]`).click()
    if (await page.getByRole('button', { name: '打开对话', exact: true }).isVisible())
      await page.getByRole('button', { name: '打开对话', exact: true }).click()
    await expect(input).toHaveValue('发送后继续写的独立草稿')
    release()
    await expect.poll(() => receiver.acceptedIds().filter(id => receiver.acceptedInput(id)?.scope.activityId === activity.activityId).length).toBe(1)
    const id = receiver.acceptedIds().find(id => receiver.acceptedInput(id)?.scope.activityId === activity.activityId)!
    expect(receiver.acceptedInput(id)!.draft.question).toBe('动作中固定的问题')
  } finally { release(); await page.evaluate(() => { Object.assign(window, { actionStorageBlocked: false }) }).catch(() => {}) }
})

test('cross-space browser history waits for the destination list before reopening its activity', async ({ page }) => {
  await courseHistoryFixture(page)
  const personalGoal = '个人历史-' + randomUUID(), schoolGoal = '学校历史-' + randomUUID()
  await newActivity(page, personalGoal)
  await page.getByRole('button', { name: '返回活动列表', exact: true }).click()
  await expect(page.locator('[data-activity-id]').filter({ hasText: personalGoal })).toBeVisible()
  await selectProductSpace(page, '学校空间')
  const created = await page.request.post(endpoint + '/api/learning/activities', { headers: { 'x-xj-space': 'school' },
    data: { requestId: randomUUID(), goal: schoolGoal, question: '', references: [] } })
  expect(created.status()).toBe(200)
  const schoolId = (await created.json()).activityId
  await page.getByRole('button', { name: '刷新任务', exact: true }).click()
  await page.locator(`[data-activity-id="${schoolId}"]`).click()
  await expect(page.locator('#activity-title')).toHaveText(schoolGoal)
  await newFile(page, '学校历史.txt'); await page.keyboard.insertText('学校空间的原文')
  await page.getByRole('button', { name: '返回活动列表', exact: true }).click()
  await expect(page.locator(`[data-activity-id="${schoolId}"]`)).toContainText(schoolGoal)
  await selectProductSpace(page, '个人空间')
  await expect(page.locator(`[data-activity-id]`).filter({ hasText: personalGoal })).toBeVisible()
  await page.evaluate(() => history.go(-2))
  await expect(page.locator('#activity-title')).toHaveText(schoolGoal)
  await expect(page.getByRole('button', { name: '学校历史.txt', exact: true })).toBeVisible()
  expect(new URL(page.url()).searchParams.get('activity')).toBe(schoolId)
  expect(new URL(page.url()).searchParams.get('space')).toBe('school')
})

test('a late older course result cannot clear the newer unknown request', async ({ page }) => {
  const courses = await courseHistoryFixture(page)
  let releaseA!: () => void, releaseB!: () => void, startedA!: () => void, startedB!: () => void, doneA!: () => void, doneB!: () => void
  const heldA = new Promise<void>(resolve => { releaseA = resolve }), heldB = new Promise<void>(resolve => { releaseB = resolve })
  const sentA = new Promise<void>(resolve => { startedA = resolve }), sentB = new Promise<void>(resolve => { startedB = resolve })
  const finishedA = new Promise<void>(resolve => { doneA = resolve }), finishedB = new Promise<void>(resolve => { doneB = resolve })
  const posted: { requestId: string; releaseId: string }[] = []
  await page.route('**/api/learning/course-activities', async route => {
    const input = route.request().postDataJSON(); posted.push(input)
    const response = await route.fetch()
    if (input.releaseId === courses[0].releaseId) {
      startedA(); await heldA; await route.fulfill({ response }); doneA()
    } else { startedB(); await heldB; await route.abort('failed'); doneB() }
  })
  try {
    await page.goto(endpoint + '/?space=school')
    await openCourseTasks(page, '课程历史 A')
    await courseTaskCard(page, courses[0].title).click()
    await page.getByRole('dialog').getByRole('button', { name: '开始任务', exact: true }).click(); await sentA
    await expect(page.getByRole('dialog').getByRole('button', { name: /正在进入学习工作区/ })).toBeDisabled()
    await expect(page.getByRole('button', { name: '核对并继续原请求', exact: true })).toHaveCount(0)
    await page.goBack()
    await openCourseTasks(page, '课程历史 B')
    await page.getByRole('button', { name: '放弃这次请求', exact: true }).click()
    await courseTaskCard(page, courses[1].title).click()
    await page.getByRole('dialog').getByRole('button', { name: '开始任务', exact: true }).click(); await sentB
    releaseA(); await finishedA
    releaseB(); await finishedB
    await expect(page.locator('[data-sonner-toast][data-type="error"]')).toContainText('暂时无法连接')
    await expect(page.getByRole('dialog').getByRole('button', { name: '开始任务', exact: true })).toHaveCount(0)
    const queried: string[] = []
    page.on('request', request => { if (request.url().includes('course-activity-results/')) queried.push(request.url().split('/').at(-1)!) })
    await page.getByRole('dialog').getByRole('button', { name: '核对并继续原请求', exact: true }).click()
    await expect(page.locator('#activity-title')).toHaveText(courses[1].title)
    expect(posted).toHaveLength(2)
    expect(queried.at(-1)).toBe(posted[1].requestId)
  } finally { releaseA(); releaseB() }
})

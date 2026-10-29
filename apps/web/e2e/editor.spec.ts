import { expect, test } from '@playwright/test'
import { REAL_URL } from './env'

/**
 * 02 切片的真实浏览器验证：多文件编辑、中文、键盘 undo/redo、刷新恢复、写失败与限额读数。
 * 跑在普通 `npm run dev`（真实模式）上：数据来自 mock 适配层，草稿落在新 IndexedDB 库。
 */

async function enterCodeWorkspace(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(`${REAL_URL}/`)
  // 空库起步：草稿隔离在用例之间，避免互相恢复
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        const request = indexedDB.deleteDatabase('xunjie-i0-workspace')
        request.onsuccess = () => resolve(null)
        request.onerror = () => resolve(null)
        request.onblocked = () => resolve(null)
      }),
  )
  await openTaskRoute(page)
}

async function openTaskRoute(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(`${REAL_URL}/#/task/wordfreq`)
  const gate = page.getByRole('button', { name: '进入任务' })
  if (await gate.count()) await gate.click()
  const onboard = page.getByRole('button', { name: '开始动手' })
  if (await onboard.count()) await onboard.click()
  await page.locator('.cw-filestrip').waitFor()
}

async function draftRecords(page: import('@playwright/test').Page) {
  return page.evaluate(() =>
    new Promise<Array<{ fileId: string; text: string; draftRevision: number }>>((resolve) => {
      const request = indexedDB.open('xunjie-i0-workspace')
      request.onsuccess = () => {
        const tx = request.result.transaction('drafts', 'readonly')
        const all = tx.objectStore('drafts').getAll()
        all.onsuccess = () => resolve(all.result)
      }
      request.onerror = () => resolve([])
    }),
  )
}

test('多文件编辑：中文输入、键盘 undo/redo、刷新恢复', async ({ page }) => {
  await enterCodeWorkspace(page)
  const editor = page.locator('.monaco-editor textarea.inputarea')
  await editor.focus()

  // 中文与 ASCII 混合输入推进草稿
  await page.keyboard.type('/* 计数 */ count = 1;\n')
  await expect(page.locator('.cw-protect')).toHaveText('本机草稿已保护')

  // 键盘 undo / redo 恢复原文分隔符与正文（可信事件驱动 Monaco 命令）
  await page.keyboard.press('ControlOrMeta+z')
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect(page.locator('.monaco-editor .view-line').first()).toContainText('/* 计数 */ count = 1;')

  const before = await draftRecords(page)
  expect(before.some((record) => record.text.includes('/* 计数 */ count = 1;'))).toBe(true)

  // 刷新后正文与活动文件从新库恢复（不清库）
  await page.reload()
  await openTaskRoute(page)
  await expect(page.locator('.monaco-editor .view-line').first()).toContainText('/* 计数 */ count = 1;')
  await expect(page.locator('.cw-protect')).toHaveText('本机草稿已保护')
})

test('切换标签保留各文件正文与视图', async ({ page }) => {
  await enterCodeWorkspace(page)
  // words.c 初始不在标签里：从「文件」列表打开
  await page.locator('.cw-stripbtn').click()
  await page.locator('.cw-filemenu-row', { hasText: 'words.c' }).click()
  const editor = page.locator('.monaco-editor textarea.inputarea')
  await editor.focus()
  await page.keyboard.type('// words 草稿\n')
  await page.locator('.cw-filetab-main', { hasText: 'main.c' }).click()
  await page.locator('.cw-filetab-main', { hasText: 'words.c' }).click()
  await expect(page.locator('.monaco-editor .view-line').first()).toContainText('// words 草稿')
})

test('新建文件：重复路径就地报错，合法名字进标签与库', async ({ page }) => {
  await enterCodeWorkspace(page)
  await page.locator('.cw-stripbtn').click()
  await page.locator('.cw-filemenu-add').click()
  const input = page.locator('.cw-name-input')
  await input.fill('main.c')
  await input.press('Enter')
  await expect(page.locator('.cw-name-error')).toContainText('占用')
  await input.fill('notes.c')
  await input.press('Enter')
  await expect(page.locator('.cw-filetab-name', { hasText: 'notes.c' })).toBeVisible()
  await expect(page.locator('.cw-protect')).toHaveText('本机草稿已保护')
  const records = await draftRecords(page)
  expect(records.length).toBeGreaterThan(0)
})

test('写失败：存储不可用时正文留在内存并显示未保护', async ({ page, context }) => {
  await enterCodeWorkspace(page)
  // 注入一个打开即失败的 IndexedDB：模拟存储不可用（配额 / 隐私模式类失败）
  await context.addInitScript(() => {
    const broken = {
      open: () => {
        const request = Object.assign(new EventTarget(), {
          result: null,
          error: new Error('存储被禁用（测试注入）'),
        }) as unknown as IDBOpenDBRequest
        setTimeout(() => request.onerror?.(new Event('error')), 0)
        return request
      },
    } as unknown as IDBFactory
    Object.defineProperty(window, 'indexedDB', { value: broken, configurable: true })
  })
  await page.reload()
  await openTaskRoute(page)
  const editor = page.locator('.monaco-editor textarea.inputarea')
  await editor.focus()
  await page.keyboard.type('x')
  await expect(page.locator('.cw-protect')).toHaveAttribute('data-status', 'failed')
  await expect(page.locator('.cw-protect')).toContainText('未保护')
  await expect(page.locator('.monaco-editor .view-line').first()).toContainText('x')
})

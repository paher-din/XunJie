import { randomUUID } from 'node:crypto'
import { test, expect } from '@playwright/test'
import { REAL_URL } from './env'

test('a late rejected activity cannot erase the next unknown submission across reload', async ({ page }) => {
  const identity = { environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(), kind: 'personal', name: '个人学习空间' }
  const school = { ...identity, spaceId: randomUUID(), kind: 'school', name: '学校学习空间' }
  const receipts: string[] = []
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/learning/**', async route => {
    const path = new URL(route.request().url()).pathname.replace('/api/learning/', '')
    if (path === 'context') return route.fulfill({ json: { profile: 'local', clientNamespace: 'learning-regression',
      identities: [{ key: 'personal', identity }, { key: 'school', identity: school }] } })
    if (path.startsWith('receipts/')) {
      receipts.push(path.slice('receipts/'.length))
      if (receipts.length === 1) {
        await held
        return route.fulfill({ status: 400, json: { error: 'invalid' } })
      }
      return route.fulfill({ json: null })
    }
    if (path === 'activities' && route.request().method() === 'POST') {
      return route.fulfill({ status: 503, json: { error: 'unavailable' } })
    }
    return route.fulfill({ json: [] })
  })
  try {
    await page.goto(REAL_URL + '/runtime.html')
    await page.getByLabel('学习目标', { exact: true }).fill('请求 A')
    await page.getByRole('button', { name: '建立学习活动', exact: true }).click()
    await expect.poll(() => receipts.length).toBe(1)
    await page.getByRole('button', { name: '学校空间', exact: true }).click()
    await page.getByRole('button', { name: '个人空间', exact: true }).click()
    await page.getByRole('button', { name: '放弃这次请求并重新填写' }).click()
    await page.getByLabel('学习目标', { exact: true }).fill('请求 B')
    await page.getByRole('button', { name: '建立学习活动', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('暂时无法连接')
    expect(receipts).toHaveLength(2)
    const rejected = page.waitForResponse(response => response.url().endsWith('/receipts/' + receipts[0]) && response.status() === 400)
    release()
    await (await rejected).finished()
    // Let the response's rejection handler run before navigating away.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await page.reload()
    await expect(page.getByLabel('学习目标', { exact: true })).toHaveValue('请求 B')
    await page.getByRole('button', { name: '核对并继续原请求' }).click()
    await expect.poll(() => receipts.length).toBe(3)
    expect(receipts[2]).toBe(receipts[1])
  } finally { release() }
})

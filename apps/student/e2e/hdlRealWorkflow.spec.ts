import { expect, test, type Locator, type Page } from '@playwright/test'
import { create, edit } from './helpers'
import { loginThroughForm } from './sessionHost'
import { runLocal } from './runServiceHelpers'
import { installHdlProtocolFixture } from './hdlProtocolFixture'

// The normal production route and public /api contract are exercised in a fresh
// browser. The whole backend here is an explicit isolated protocol substitute;
// this does not stand in for the separate PAHER/real-engine browser acceptance.
test.use({ trace: 'off' })
const bad = 'module top;\nwire led;\nassign led = ;\nendmodule\n'
const good = 'module top;\nwire led;\nassign led = 1;\nendmodule\n'
type Protocol = Awaited<ReturnType<typeof installHdlProtocolFixture>>

/** Only natural Tab traversal; Monaco's own Ctrl+M releases its documented Tab mode. */
async function keyboardTo(page: Page, target: Locator, direction: 'Tab' | 'Shift+Tab' = 'Tab') {
  await expect(target).toBeVisible()
  await expect(target).toBeEnabled()
  let monacoReleased = false
  for (let step = 0; step < 100; step++) {
    if (await target.evaluate(element => element === document.activeElement)) return
    if (!monacoReleased && await page.evaluate(() => document.activeElement?.matches('.monaco-editor textarea') ?? false)) {
      await page.keyboard.press('Control+m'); monacoReleased = true
    }
    await page.keyboard.press(direction)
  }
  const active = await page.evaluate(() => ({ tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute('aria-label') }))
  await expect(target, `键盘没有到达原控件：${JSON.stringify(active)}`).toBeFocused()
}

async function enterHdl(page: Page, protocol: Protocol) {
  expect(protocol.isolated).toBe(true)
  await page.goto(protocol.url)
  await expect(page.getByRole('heading', { name: '登录学习空间' })).toBeVisible()
  await loginThroughForm(page, protocol.loginName, protocol.password)
  await expect(page.locator('.ts-badge')).toHaveAttribute('data-status', 'ready')
  await page.getByRole('button', { name: '开始 Attempt', exact: true }).click()
  await expect(page.locator('.cw')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Core 运行', exact: true })).toHaveCount(0)
  await create(page, 'top.sv')
}
async function snapshot(page: Page, protocol: Protocol, text: string, revision: number, replace = false) {
  if (replace) {
    await page.locator('.monaco-editor textarea').first().focus()
    await page.keyboard.press('Control+a')
  }
  await edit(page, text)
  await page.getByRole('button', { name: '确认保存', exact: true }).click()
  await expect(page.locator('.ws-flow').filter({ hasText: '与草稿一致' })).toContainText(`确认作品 v${revision}`)
  await page.getByRole('button', { name: '冻结确认作品', exact: true }).click()
  await expect(page.getByText(`已冻结快照 v${revision}`, { exact: true })).toBeVisible()
  const source = protocol.head!.snapshots.at(-1)!
  expect(source.files[0]!.text).toBe(text)
  await page.getByRole('combobox', { name: 'HDL 确认快照', exact: true }).selectOption(source.snapshotId)
  return source
}
async function buildAndProgram(page: Page, protocol: Protocol) {
  await page.getByRole('button', { name: '检查并构建', exact: true }).click()
  await expect(page.locator('[aria-label="真实 HDL 构建诊断"]')).toContainText('构建成功')
  await page.getByRole('button', { name: '装载到虚拟板', exact: true }).click()
  await page.getByRole('tab', { name: '虚拟板', exact: true }).click()
  await expect(page.locator('[aria-label="真实 HDL 虚拟板"]')).toContainText('虚拟板运行中')
  await expect(page.getByRole('button', { name: '拨码开关 SW0', exact: true })).toBeEnabled()
  expect(protocol.effects.programs).toBe(1)
  return protocol.sessions[0]!
}
async function reopenBoard(page: Page) {
  await page.reload()
  await expect(page.locator('.ts-badge')).toHaveAttribute('data-status', 'ready')
  await page.getByRole('tab', { name: '虚拟板', exact: true }).click()
}

test('隔离正常 HDL 页面：.sv保存与快照、真实形状失败诊断、显式成功装载及四态输出', async ({ page }) => {
  const protocol = await installHdlProtocolFixture(page)
  await enterHdl(page, protocol)
  const original = await snapshot(page, protocol, bad, 1)
  await page.getByRole('button', { name: '检查并构建', exact: true }).click()
  const diagnostics = page.locator('[aria-label="真实 HDL 构建诊断"]')
  await expect(diagnostics).toContainText('构建失败')
  await expect(diagnostics).toContainText('第 3 行（整行定位）')
  await expect(page.getByRole('button', { name: '装载到虚拟板', exact: true })).toBeDisabled()
  expect(protocol.builds[0]!.request.snapshot.snapshotId).toBe(original.snapshotId)
  expect(protocol.effects.programs).toBe(0)
  await page.getByRole('button', { name: '查看诊断源行', exact: true }).click()
  await expect(page.locator('.monaco-editor textarea').first()).toBeAttached()
  const corrected = await snapshot(page, protocol, good, 2, true)
  expect(corrected.snapshotId).not.toBe(original.snapshotId)
  expect(protocol.head!.snapshots[0]!.files[0]!.text).toBe(bad)
  const loaded = await buildAndProgram(page, protocol)
  expect(loaded.snapshotId).toBe(corrected.snapshotId)
  await expect(page.getByRole('button', { name: /^拨码开关 SW\d+$/ })).toHaveCount(16)
  await expect(page.getByRole('button', { name: /^按下 BTN\d$/ })).toHaveCount(5)
  await expect(page.getByRole('button', { name: /^松开 BTN\d$/ })).toHaveCount(5)
  await page.getByRole('button', { name: '拨码开关 SW0', exact: true }).click()
  await expect(page.getByRole('img', { name: 'LED0: 1', exact: true })).toBeVisible()
  await expect(page.locator('[aria-label="真实 HDL 虚拟板"]')).toContainText('操作序号 1')
  await expect(page.locator('[aria-label="真实 HDL 虚拟板"]')).toContainText('模拟时间 10000 ps')
  await expect(page.locator('[aria-label="真实 HDL 虚拟板"]')).toContainText('多位同时有效')
  await expect(page.locator('[aria-label="真实 HDL 虚拟板"]')).toContainText('SEG(gfedcba)=x0z1010')
  const interaction = protocol.posts.find(post => post.kind === 'hdl.interact')!
  expect(JSON.parse(interaction.wire)).toMatchObject({ sessionId: loaded.sessionId, expectedSessionRevision: 1,
    expectedSequence: 1, inputs: { switches: '0000000000000001', buttons: '00000', resetN: '1' }, advanceCycles: 1 })
  await page.getByRole('tab', { name: '波形', exact: true }).click()
  await expect(page.locator('[aria-label="真实 HDL 有限波形"]')).toContainText('返回 1 帧')
  await expect(page.getByRole('table', { name: '原始四态采样' })).toContainText('x0z1010')
  expect(protocol.paths.every(path => !path.includes('__i0prep'))).toBe(true)
  await page.screenshot({ path: test.info().outputPath('isolated-real-mode-hdl-wave.png') })
})

test('隔离 HDL pending/失ACK/刷新：零额外装载与交互，原键原wire核对，停止请求和退出分开', async ({ page }) => {
  const protocol = await installHdlProtocolFixture(page)
  await enterHdl(page, protocol)
  await snapshot(page, protocol, good, 1)
  const loaded = await buildAndProgram(page, protocol)
  protocol.holdInputs(true)
  await page.getByRole('button', { name: '拨码开关 SW0', exact: true }).click()
  await expect(page.getByRole('button', { name: '拨码开关 SW1', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: '松开 BTN0', exact: true })).toBeDisabled()
  await expect(page.locator('[aria-label="真实 HDL 虚拟板"]')).toContainText('操作序号 0')
  await expect.poll(() => protocol.effects.interactions).toBe(1)
  const heldKey = protocol.posts.filter(post => post.kind === 'hdl.interact')[0]!.key
  expect((await runLocal(page)).commands.filter(command => command.kind === 'hdl.interact')).toHaveLength(1)
  await reopenBoard(page)
  await expect(page.locator('[aria-label="真实 HDL 虚拟板"]')).toContainText('操作序号 0')
  await expect(page.getByRole('button', { name: '拨码开关 SW1', exact: true })).toBeDisabled()
  expect(protocol.effects.programs).toBe(1)
  expect(protocol.effects.interactions).toBe(1)
  expect(protocol.posts.filter(post => post.kind === 'hdl.interact')).toHaveLength(1)
  protocol.holdInputs(false); protocol.finishInputs()
  await page.getByRole('button', { name: '核对 HDL 状态', exact: true }).click()
  await expect(page.getByRole('button', { name: '拨码开关 SW1', exact: true })).toBeEnabled()
  await expect(page.locator('[aria-label="真实 HDL 虚拟板"]')).toContainText('操作序号 1')
  protocol.dropInteractionAck()
  await page.getByRole('button', { name: '拨码开关 SW1', exact: true }).click()
  await expect(page.getByRole('button', { name: '核对原 HDL 请求', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '拨码开关 SW2', exact: true })).toBeDisabled()
  const unknown = protocol.posts.filter(post => post.kind === 'hdl.interact').at(-1)!
  expect(unknown.key).not.toBe(heldKey)
  expect(protocol.effects.interactions).toBe(2)
  await reopenBoard(page)
  await expect(page.getByRole('button', { name: '核对原 HDL 请求', exact: true })).toBeVisible()
  expect(protocol.posts.filter(post => post.kind === 'hdl.interact')).toHaveLength(2)
  expect(protocol.effects.programs).toBe(1)
  await page.getByRole('button', { name: '核对原 HDL 请求', exact: true }).click()
  await expect(page.getByRole('button', { name: '拨码开关 SW2', exact: true })).toBeEnabled()
  const replay = protocol.posts.filter(post => post.kind === 'hdl.interact').at(-1)!
  expect(replay).toMatchObject({ key: unknown.key, wire: unknown.wire })
  expect(protocol.effects.interactions).toBe(2)
  expect(protocol.sessions[0]!.sessionId).toBe(loaded.sessionId)
  expect(protocol.sessions[0]!.confirmedSequence).toBe(2)
  await page.getByRole('button', { name: '停止 HDL', exact: true }).click()
  await expect(page.locator('[aria-label="真实 HDL 虚拟板"]')).toContainText('等待确认退出')
  expect(protocol.sessions[0]!.terminationConfirmed).toBe(false)
  await expect(page.getByRole('button', { name: '拨码开关 SW2', exact: true })).toBeDisabled()
  protocol.confirmStop()
  await page.getByRole('button', { name: '核对 HDL 状态', exact: true }).click()
  await expect(page.locator('[aria-label="真实 HDL 虚拟板"]')).toContainText('已确认停止')
  await expect(page.locator('[aria-label="真实 HDL 虚拟板"]')).toContainText('操作序号 2')
  const layout = await page.evaluate(() => ({ width: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth, scrollX: window.scrollX }))
  await page.screenshot({ path: test.info().outputPath('isolated-real-mode-hdl-toolbar.png') })
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width)
  expect(layout.scrollX).toBe(0)
  await reopenBoard(page)
  await expect(page.locator('[aria-label="真实 HDL 虚拟板"]')).toContainText('已确认停止')
  await expect(page.locator('[aria-label="真实 HDL 虚拟板"]')).toContainText('模拟时间 20000 ps')
  expect(protocol.effects).toEqual({ builds: 1, programs: 1, interactions: 2, stops: 1 })
  expect(protocol.paths.every(path => !path.includes('__i0prep'))).toBe(true)
  await page.screenshot({ path: test.info().outputPath('isolated-real-mode-hdl-stopped.png') })
})

test('隔离同源正常 C 分配仍显示原 Core 入口，不能因 HDL 文件扩展名替换课程', async ({ page }) => {
  const protocol = await installHdlProtocolFixture(page)
  await page.goto(protocol.cUrl)
  await loginThroughForm(page, protocol.loginName, protocol.password)
  await expect(page.locator('.ts-badge')).toHaveAttribute('data-status', 'ready')
  await page.getByRole('button', { name: '开始 Attempt', exact: true }).click()
  await expect(page.locator('.cw')).toBeVisible()
  await create(page, 'top.sv')
  await expect(page.getByRole('button', { name: 'Core 运行', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '检查并构建', exact: true })).toHaveCount(0)
  await expect(page.locator('[aria-label="真实 HDL 虚拟板"]')).toHaveCount(0)
  expect(protocol.effects).toEqual({ builds: 0, programs: 0, interactions: 0, stops: 0 })
  expect(protocol.paths.every(path => !path.includes('__i0prep'))).toBe(true)
})

test('隔离 HDL 同快照构建与代码求助：准确selection、预算关闭原拒绝且仍可编辑保存', async ({ page }) => {
  const protocol = await installHdlProtocolFixture(page)
  await enterHdl(page, protocol)
  const frozen = await snapshot(page, protocol, bad, 1)
  await page.getByRole('button', { name: '检查并构建', exact: true }).click()
  await expect(page.locator('[aria-label="真实 HDL 构建诊断"]')).toContainText('构建失败')
  const failedBuild = protocol.builds[0]!.result!
  expect(failedBuild.snapshotId).toBe(frozen.snapshotId)
  await page.getByRole('button', { name: '就这个文件求助', exact: true }).click()
  await expect(page.getByTestId('tutoring-pane')).toHaveCount(0)
  expect(protocol.posts.filter(post => post.kind === 'help')).toHaveLength(0)
  await page.getByRole('button', { name: '引用此次构建求助', exact: true }).click()
  await expect(page.getByTestId('tutor-hdl-selection')).toContainText(failedBuild.buildId)
  await expect(page.getByTestId('tutor-hdl-selection')).toContainText(frozen.snapshotId)
  await page.getByRole('button', { name: '收起辅导', exact: true }).click()
  await page.getByRole('button', { name: '就这个文件求助', exact: true }).click()
  await expect(page.getByTestId('tutor-object')).toContainText('top.sv · 文件版本 1')
  await expect(page.getByTestId('tutor-hdl-selection')).toContainText(frozen.snapshotId)
  const question = '隔离浏览器验证：请解释这份构建第3行诊断，保留我自行修订。'
  await page.getByRole('textbox', { name: '就这个任务提问', exact: true }).fill(question)
  const declined = page.waitForResponse(response => response.request().method() === 'POST' && /\/api\/attempts\/[^/]+\/help$/.test(response.url()))
  await page.getByRole('button', { name: '发送辅导问题', exact: true }).click()
  const response = await declined
  expect(response.status()).toBe(429)
  expect((await response.json()).error.code).toBe('BUDGET_EXHAUSTED')
  const help = protocol.posts.filter(post => post.kind === 'help')
  expect(help).toHaveLength(1)
  expect(JSON.parse(help[0]!.wire)).toEqual({ expectedAttemptRevision: protocol.head!.attempt.attemptRevision,
    recoveryGeneration: expect.any(String), question,
    hdlSelection: { snapshotId: frozen.snapshotId, buildId: failedBuild.buildId },
    objectRef: { kind: 'code', attemptId: protocol.head!.attempt.attemptId, snapshotId: frozen.snapshotId,
      fileId: frozen.files[0]!.fileId, path: 'top.sv', documentVersion: 1, contentHash: frozen.files[0]!.contentHash } })
  await expect(page.getByTestId('tutor-question-status')).toHaveText('服务未接纳')
  await expect(page.getByTestId('tutoring-pane')).toContainText('辅导预算不可用，编辑和保存仍可继续')
  await expect(page.getByRole('textbox', { name: '就这个任务提问', exact: true })).toHaveValue(question)
  await expect(page.getByTestId('tutor-message')).toHaveCount(0)
  await expect(page.getByTestId('tutor-history-message')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '我先试试', exact: true })).toHaveCount(0)
  expect(protocol.posts.filter(post => /\/actions\/[^/]+\/receipts$/.test(post.path))).toHaveLength(0)
  await page.getByRole('button', { name: '收起辅导', exact: true }).click()
  await page.locator('.monaco-editor textarea').first().focus()
  await page.keyboard.press('Control+a')
  await edit(page, good)
  await page.getByRole('button', { name: '确认保存', exact: true }).click()
  await expect(page.locator('.ws-flow').filter({ hasText: '与草稿一致' })).toContainText('确认作品 v2')
  expect(protocol.head!.files[0]!.text).toBe(good)
  expect(protocol.head!.snapshots[0]!.files[0]!.text).toBe(bad)
  expect(protocol.effects).toEqual({ builds: 1, programs: 0, interactions: 0, stops: 0 })
  expect(protocol.posts.filter(post => post.kind === 'help')).toHaveLength(1)
  expect(protocol.paths.every(path => !path.includes('__i0prep'))).toBe(true)
  await page.screenshot({ path: test.info().outputPath('isolated-real-mode-hdl-model-unavailable.png') })
})

test('隔离 HDL 长 pending：虚拟时钟最多60轮读取、耗尽不循环发布、明确读取恢复', async ({ page }) => {
  await page.clock.install()
  const protocol = await installHdlProtocolFixture(page)
  await enterHdl(page, protocol)
  await snapshot(page, protocol, good, 1)
  await buildAndProgram(page, protocol)
  protocol.holdInputs(true)
  await page.getByRole('button', { name: '拨码开关 SW0', exact: true }).click()
  await expect.poll(() => protocol.effects.interactions).toBe(1)
  await expect(page.locator('[aria-label="真实 HDL 虚拟板"]')).toContainText('正在处理输入')
  await expect(page.getByRole('button', { name: '停止 HDL', exact: true })).toBeEnabled()
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1))
  const before = { ...protocol.readCounts }
  for (let round = 1; round <= 60; round++) {
    await page.clock.runFor(1000)
    await expect.poll(() => protocol.readCounts.session - before.session, { message: `第${round}轮原Session读取` }).toBe(round)
    await expect.poll(() => protocol.readCounts.job - before.job, { message: `第${round}轮读取完成原Job` }).toBe(round)
    // canStop is published only after the current authorized read has completed.
    await expect(page.getByRole('button', { name: '停止 HDL', exact: true })).toBeEnabled()
  }
  const notice = page.getByText('自动读取已暂停，请主动重新读取结果。', { exact: true })
  await expect(notice).toBeVisible()
  await expect(notice).toHaveCount(1)
  const exhausted = { ...protocol.readCounts }
  await page.clock.runFor(5000)
  expect(protocol.readCounts).toEqual(exhausted)
  expect(exhausted.session - before.session).toBe(60)
  expect(exhausted.trace - before.trace).toBe(60)
  expect(protocol.effects).toEqual({ builds: 1, programs: 1, interactions: 1, stops: 0 })
  // The page is still usable; it neither invents a result nor disables recovery.
  await expect(page.getByRole('button', { name: '停止 HDL', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: '核对 HDL 状态', exact: true })).toBeEnabled()
  await expect(page.locator('[aria-label="真实 HDL 虚拟板"]')).toContainText('操作序号 0')
  protocol.holdInputs(false); protocol.finishInputs()
  await page.getByRole('button', { name: '核对 HDL 状态', exact: true }).click()
  await expect(page.getByRole('button', { name: '拨码开关 SW1', exact: true })).toBeEnabled()
  await expect(page.locator('[aria-label="真实 HDL 虚拟板"]')).toContainText('操作序号 1')
  await expect(notice).toHaveCount(0)
  expect(protocol.effects.interactions).toBe(1)
  await page.screenshot({ path: test.info().outputPath('isolated-hdl-poll-budget-recovered.png') })
})

test('隔离 HDL 切换分配：旧Session迟到响应不能覆盖正常C页面或作品', async ({ page }) => {
  const protocol = await installHdlProtocolFixture(page)
  await enterHdl(page, protocol)
  await snapshot(page, protocol, good, 1)
  const original = await buildAndProgram(page, protocol)
  const held = protocol.holdNextSessionRead(original.sessionId)
  try {
    await page.getByRole('button', { name: '核对 HDL 状态', exact: true }).click()
    await held.arrived
    await page.goto(protocol.cUrl)
    await expect(page.locator('.ts-badge')).toHaveAttribute('data-status', 'ready')
    await page.getByRole('button', { name: '开始 Attempt', exact: true }).click()
    await expect(page.locator('.cw')).toBeVisible()
    await create(page, 'main.c')
    await edit(page, 'int main(void) { return 0; }\n')
    await page.getByRole('button', { name: '确认保存', exact: true }).click()
    await expect(page.locator('.ws-flow').filter({ hasText: '与草稿一致' })).toContainText('确认作品 v1')
    held.release(); await held.completed
    await expect(page.getByRole('button', { name: 'Core 运行', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '停止 HDL', exact: true })).toHaveCount(0)
    await expect(page.locator('[aria-label="真实 HDL 虚拟板"]')).toHaveCount(0)
    await expect(page.locator('.view-lines')).toContainText('int main(void) { return 0; }')
    await expect(page.locator('main')).not.toContainText(original.sessionId)
    expect(protocol.head!.files[0]!.path).toBe('main.c')
    expect(protocol.head!.files[0]!.text).toBe('int main(void) { return 0; }\n')
    expect(protocol.effects).toEqual({ builds: 1, programs: 1, interactions: 0, stops: 0 })
    await page.screenshot({ path: test.info().outputPath('isolated-hdl-late-read-c-assignment.png') })
  } finally { held.release() }
})

test('隔离 HDL 键盘基本路径：SW、按钮按下松开、低有效复位、推进、停止及显式构建求助', async ({ page }) => {
  const protocol = await installHdlProtocolFixture(page)
  await enterHdl(page, protocol)
  await snapshot(page, protocol, good, 1)
  const original = await buildAndProgram(page, protocol)
  await keyboardTo(page, page.getByRole('button', { name: '拨码开关 SW0', exact: true }))
  await page.keyboard.press('Space')
  await expect(page.getByRole('img', { name: 'LED0: 1', exact: true })).toBeVisible()
  await keyboardTo(page, page.getByRole('button', { name: '按下 BTN0', exact: true }))
  await page.keyboard.press('Space')
  await expect.poll(() => protocol.sessions[0]!.confirmedSequence).toBe(2)
  await keyboardTo(page, page.getByRole('button', { name: '松开 BTN0', exact: true }))
  await page.keyboard.press('Space')
  await expect.poll(() => protocol.sessions[0]!.confirmedSequence).toBe(3)
  await keyboardTo(page, page.getByRole('button', { name: '按下复位 RESET_N=0', exact: true }))
  await page.keyboard.press('Enter')
  await expect.poll(() => protocol.sessions[0]!.confirmedSequence).toBe(4)
  await keyboardTo(page, page.getByRole('button', { name: '松开复位 RESET_N=1', exact: true }))
  await page.keyboard.press('Enter')
  await expect.poll(() => protocol.sessions[0]!.confirmedSequence).toBe(5)
  await keyboardTo(page, page.getByRole('spinbutton', { name: '推进周期', exact: true }))
  await page.keyboard.press('Control+a'); await page.keyboard.insertText('2')
  await keyboardTo(page, page.getByRole('button', { name: '推进时钟', exact: true }))
  await page.keyboard.press('Enter')
  await expect.poll(() => protocol.sessions[0]!.confirmedSequence).toBe(6)
  const inputs = protocol.posts.filter(post => post.kind === 'hdl.interact').map(post => JSON.parse(post.wire))
  expect(inputs.map(input => input.expectedSequence)).toEqual([1, 2, 3, 4, 5, 6])
  expect(inputs.map(input => input.inputs.buttons)).toEqual(['00000', '00001', '00000', '00000', '00000', '00000'])
  expect(inputs.map(input => input.inputs.resetN)).toEqual(['1', '1', '1', '0', '1', '1'])
  expect(inputs[5]!.advanceCycles).toBe(2)
  expect(inputs.every(input => input.sessionId === original.sessionId)).toBe(true)
  await keyboardTo(page, page.getByRole('button', { name: '停止 HDL', exact: true }), 'Shift+Tab')
  await page.keyboard.press('Enter')
  await expect(page.locator('[aria-label="真实 HDL 虚拟板"]')).toContainText('等待确认退出')
  protocol.confirmStop()
  await keyboardTo(page, page.getByRole('button', { name: '核对 HDL 状态', exact: true }))
  await page.keyboard.press('Enter')
  await expect(page.locator('[aria-label="真实 HDL 虚拟板"]')).toContainText('已确认停止')
  await keyboardTo(page, page.getByRole('tab', { name: '设计', exact: true }), 'Shift+Tab')
  await page.keyboard.press('Enter')
  await keyboardTo(page, page.getByRole('button', { name: '引用此次构建求助', exact: true }))
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('tutor-hdl-selection')).toContainText(original.buildId)
  await keyboardTo(page, page.getByRole('textbox', { name: '就这个任务提问', exact: true }))
  await page.keyboard.insertText('隔离键盘验证：只解释明确所选构建。')
  const declined = page.waitForResponse(response => response.request().method() === 'POST' && /\/help$/.test(response.url()))
  await keyboardTo(page, page.getByRole('button', { name: '发送辅导问题', exact: true }))
  await page.keyboard.press('Enter')
  expect((await declined).status()).toBe(429)
  await expect(page.getByTestId('tutor-question-status')).toHaveText('服务未接纳')
  await expect(page.getByTestId('tutor-message')).toHaveCount(0)
  expect(protocol.effects).toEqual({ builds: 1, programs: 1, interactions: 6, stops: 1 })
  await page.screenshot({ path: test.info().outputPath('isolated-hdl-keyboard-basics.png') })
})

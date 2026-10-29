import { clickWorkspaceAction } from './workspaceControls'
import { test, expect, type Page } from '@playwright/test'
import { fixedProject, recoverRunContext } from './runHelpers'
import { revealTutorSource } from './tutoringHelpers'
import { confirmSave, create, edit, localState, openFileMenu, start, serverHead, trackBusinessWrites } from './helpers'
import type { TutorPage, TutorPayload } from '../src/workspace/tutoringContracts'

async function askCode(page: Page, question: string) {
  await clickWorkspaceAction(page, '就这个文件求助')
  await expect(page.getByTestId('tutor-object')).toContainText('sample.txt')
  await page.getByRole('textbox', { name: '就这个任务提问' }).fill(question)
  await page.getByRole('button', { name: '发送辅导问题', exact: true }).click()
}

type CodeLedger = { key: string; messages: Array<{ payload: TutorPayload }> }
async function ledgers(page: Page): Promise<CodeLedger[]> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const q = indexedDB.open('xunjie-i0-workspace', 2)
      q.onsuccess = () => resolve(q.result); q.onerror = () => reject(q.error)
    })
    try {
      const rows = await new Promise<CodeLedger[]>((resolve, reject) => {
        const q = db.transaction('metadata').objectStore('metadata').getAll()
        q.onsuccess = () => resolve(q.result); q.onerror = () => reject(q.error)
      })
      return rows.filter(r => r.key.startsWith('tutor:ledger:'))
    } finally { db.close() }
  })
}

/** Hold an actual authority response unchanged; never synthesize a successful Action or source. */
async function holdCodeReply(page: Page) {
  let release!: () => void, arrived!: (payload: TutorPayload) => void, completed!: () => void
  const hold = new Promise<void>(r => { release = r })
  const ready = new Promise<TutorPayload>(r => { arrived = r })
  const delivered = new Promise<void>(r => { completed = r })
  let held = false
  await page.route('**/__i0prep/api/attempts/*/events?*', async route => {
    const response = await route.fetch(), body = await response.json() as { data: TutorPage }
    const payload = body.data.events.find(e => e.payload?.basis?.objectRef?.kind === 'code')?.payload
    const capture = !held && !!payload
    if (capture) { held = true; arrived(payload!); await hold }
    await route.fulfill({ response })
    if (capture) completed()
  })
  return { ready, release, delivered }
}

function receiptWrites(page: Page) {
  const writes: string[] = []
  page.on('request', r => {
    if (r.method() === 'POST' && /\/actions\/[^/]+\/receipts$/.test(new URL(r.url()).pathname)) writes.push(new URL(r.url()).pathname)
  })
  return writes
}

/** Keep render evidence across the release window, including a briefly inserted old message. */
async function observeRenderedActions(page: Page) {
  await page.evaluate(() => {
    const actionIds: string[] = []
    const observer = new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue
        for (const el of [node, ...node.querySelectorAll('[data-action-id]')]) {
          const id = el.getAttribute('data-action-id')
          if (id && !actionIds.includes(id)) actionIds.push(id)
        }
      }
    })
    observer.observe(document.body, { childList: true, subtree: true })
    Object.assign(window, { i0CodeRenders: { actionIds, observer } })
  })
  return () => page.evaluate(() => {
    const observed = (window as typeof window & { i0CodeRenders: { actionIds: string[]; observer: MutationObserver } }).i0CodeRenders
    observed.observer.disconnect()
    return observed.actionIds
  })
}
test('确认文件/精确选区核对后显式求助，修改草稿后阻止旧对象发送且不自动保存',async({page})=> {
  const head=await fixedProject(page,'tutor-code-selection'), snapshot=head.snapshots[0]!, file=snapshot.files.find(f=>f.path==='sample.txt')!
  const writes:Array<{path:string;body:Record<string,unknown>}>=[]
  page.on('request',r=> {if(r.method()==='POST'&&/\/(help|sync|snapshots|runs)$/.test(new URL(r.url()).pathname))writes.push({path:new URL(r.url()).pathname,body:JSON.parse(r.postData()!)})})
  await clickWorkspaceAction(page, '就这个文件求助')
  await expect(page.getByTestId('tutor-object')).toContainText('sample.txt')
  expect(writes).toEqual([])
  await page.getByRole('button',{name:'收起辅导'}).click()
  const editor=page.locator('.monaco-editor textarea').first()
  await editor.focus();await page.keyboard.press('ControlOrMeta+a')
  await clickWorkspaceAction(page, '就所选代码求助')
  await expect(page.getByTestId('tutor-object')).toContainText('行 1–2')
  await page.getByRole('textbox',{name:'就这个任务提问'}).fill('请解释这个选区中的边界')
  await page.getByRole('button',{name:'发送辅导问题'}).click()
  await expect.poll(()=>writes.filter(r=>r.path.endsWith('/help')).length).toBe(1)
  const ref=writes.find(r=>r.path.endsWith('/help'))!.body.objectRef
  expect(ref).toEqual({kind:'code',attemptId:head.attempt.attemptId,snapshotId:snapshot.snapshotId,fileId:file.fileId,path:file.path,
    documentVersion:file.documentVersion,contentHash:file.contentHash,range:{startLine:1,startColumn:1,endLine:2,endColumn:1}})
  await expect(page.getByTestId('tutor-source')).toContainText(`原快照 ${snapshot.snapshotId}`)
  await expect(page.getByTestId('tutor-source')).toContainText('行列 1:1–2:1')
  await page.getByRole('button',{name:'收起辅导'}).click()
  await editor.focus();await page.keyboard.press('ControlOrMeta+End');await page.keyboard.insertText('// unconfirmed')
  await expect(page.locator('.cw-protect')).toHaveText('本机草稿已保护')
  await clickWorkspaceAction(page, '就所选代码求助')
  await expect(page.getByRole('status')).toContainText('草稿有未确认修改')
  await clickWorkspaceAction(page, '就项目求助')
  await expect(page.getByTestId('tutor-source')).toContainText('本机草稿已修改')
  await expect(page.getByTestId('tutor-source')).toContainText(`原快照 ${snapshot.snapshotId}`)
  expect(writes.filter(r=>!r.path.endsWith('/help'))).toEqual([])
  expect((await serverHead(page)).files).toEqual(head.files)
})
test('没有快照的代码问题只说明缺口，不偷偷确认/冻结；开放项目问题不要求代码',async({page})=> {
  await start(page,'tutor-no-snapshot');await create(page);await edit(page,'\uFEFF// 😀\r\nint x;\r// original\n')
  const writes:string[]=[];page.on('request',r=> {if(r.method()==='POST'&&/\/(help|sync|snapshots)$/.test(r.url()))writes.push(r.url())})
  await clickWorkspaceAction(page, '就这个文件求助')
  await expect(page.getByRole('status')).toContainText('求助不会自动保存')
  expect(writes).toEqual([])
  await clickWorkspaceAction(page, '就项目求助')
  await page.getByRole('textbox',{name:'就这个任务提问'}).fill('如何寻找起点？')
  await page.getByRole('button',{name:'发送辅导问题'}).click()
  await expect(page.getByTestId('tutor-message')).toHaveCount(1)
  expect(writes).toHaveLength(1)
})

test('已显示的代码回答经历原文件回收及同名重建，仍保留原来源且不定位或修改新实例', async ({ page }, testInfo) => {
  const head = await fixedProject(page, 'tutor-code-recreated')
  const snapshot = head.snapshots[0]!, original = snapshot.files.find(f => f.path === 'sample.txt')!
  await askCode(page, '请核对这份原文件，我会继续自己的作品')
  const message = page.getByTestId('tutor-message'), source = message.getByTestId('tutor-source')
  await message.scrollIntoViewIfNeeded()
  await expect(message.getByTestId('tutor-facts')).toContainText('展示：本机已发生')
  const actionId = (await message.getAttribute('data-action-id'))!
  const originalRef = (await ledgers(page)).flatMap(l => l.messages).find(m => m.payload.actionId === actionId)!.payload.basis!.objectRef!
  expect(originalRef).toEqual({ kind: 'code', attemptId: head.attempt.attemptId, snapshotId: snapshot.snapshotId,
    fileId: original.fileId, path: original.path, documentVersion: original.documentVersion, contentHash: original.contentHash })

  await page.getByRole('button', { name: '收起辅导', exact: true }).click()
  await openFileMenu(page)
  await page.locator('[data-fileid] button[aria-label="回收 sample.txt"]').click()
  await confirmSave(page, 2)
  await clickWorkspaceAction(page, '就项目求助')
  await revealTutorSource(message)
  await expect(source).toContainText(`原快照 ${snapshot.snapshotId}`)
  await expect(source).toContainText(`sample.txt · 文件版本 ${original.documentVersion}`)
  await expect(source).toContainText('原文件当前不可用；同名文件不承接这份回答。')
  await expect(message).toHaveAttribute('data-action-id', actionId)

  await page.getByRole('button', { name: '收起辅导', exact: true }).click()
  await openFileMenu(page)
  await page.getByRole('menuitem', { name: '新建文件', exact: true }).click()
  const filename = page.getByRole('textbox', { name: '新文件名' })
  await filename.fill('sample.txt'); await filename.press('Enter')
  await edit(page, 'same path, a separate work\nsecond line\n')
  await confirmSave(page, 3)
  const rebuiltHead = await serverHead(page)
  const rebuilt = rebuiltHead.files.find(f => f.path === original.path && f.lifecycle === 'active')!
  expect(rebuilt.fileId).not.toBe(original.fileId)
  expect(rebuiltHead.files.find(f => f.fileId === original.fileId)).toMatchObject({ lifecycle: 'recycled', text: original.text, contentHash: original.contentHash })
  await page.locator('.monaco-editor textarea').first().focus()
  await page.keyboard.press('ControlOrMeta+End')
  const position = (await page.locator('.cw-status').innerText()).match(/行 \d+，列 \d+/)?.[0]
  expect(position).toBeTruthy()
  const localBefore = await localState(page), writes = trackBusinessWrites(page)
  await clickWorkspaceAction(page, '就项目求助')
  await revealTutorSource(message)
  await expect(source).toContainText(`原快照 ${snapshot.snapshotId}`)
  await expect(source).toContainText(`sample.txt · 文件版本 ${original.documentVersion}`)
  await expect(source).toContainText('原文件当前不可用；同名文件不承接这份回答。')
  await expect(message).toHaveAttribute('data-action-id', actionId)
  expect((await ledgers(page)).flatMap(l => l.messages).find(m => m.payload.actionId === actionId)!.payload.basis!.objectRef).toEqual(originalRef)
  await expect(message.getByRole('button', { name: /定位|应用|替换作品/ })).toHaveCount(0)
  await page.getByRole('button', { name: '收起辅导', exact: true }).click()
  await expect(page.locator('.cw-status')).toContainText(position!)
  await expect(page.locator('.view-lines')).toContainText('same path, a separate work')
  expect((await localState(page)).drafts).toEqual(localBefore.drafts)
  expect((await serverHead(page)).files).toEqual(rebuiltHead.files)
  expect(writes.filter(w => !w.endsWith('/receipts'))).toEqual([])
  await testInfo.attach('recreated-code-source.json', { contentType: 'application/json',
    body: Buffer.from(JSON.stringify({ actionId, originalRef, rebuiltFileId: rebuilt.fileId, position }, null, 2)) })
})

test('旧代码回答在同一页面切换当前Attempt并重读后才到达，不混入新尝试', async ({ page, context }) => {
  const oldHead = await fixedProject(page, 'tutor-code-old-attempt')
  const held = await holdCodeReply(page), receipts = receiptWrites(page)
  try {
    await askCode(page, '旧Attempt的问题不得进入新Attempt')
    const old = await held.ready
    expect(old.basis!.objectRef!.attemptId).toBe(oldHead.attempt.attemptId)
    await expect(page.getByTestId('tutor-message')).toHaveCount(0)
    const other = await context.newPage()
    const nextHead = await fixedProject(other, 'tutor-code-new-attempt'), nextUrl = other.url()
    expect(nextHead.attempt.attemptId).not.toBe(oldHead.attempt.attemptId)
    await other.close()
    // Change only the existing dev scenario selector, then use the normal reload control.
    // The document and its pending old HTTP promise survive; no new public protocol is introduced.
    await page.evaluate(url => history.replaceState(history.state, '', url), nextUrl)
    await clickWorkspaceAction(page, '重新读取')
    await expect(page.locator('.cw')).toBeVisible()
    expect((await serverHead(page)).attempt.attemptId).toBe(nextHead.attempt.attemptId)
    await clickWorkspaceAction(page, '就项目求助')
    await expect(page.getByTestId('tutor-history')).toContainText('暂无可回取')
    const rendered = await observeRenderedActions(page)
    held.release(); await held.delivered
    await askCode(page, '这是新Attempt的独立代码问题')
    await expect(page.getByTestId('tutor-message')).toHaveCount(1)
    await expect(page.getByTestId('tutor-source')).toContainText(`原快照 ${nextHead.snapshots[0]!.snapshotId}`)
    await expect(page.locator(`[data-action-id="${old.actionId}"]`)).toHaveCount(0)
    await expect(page.getByTestId('tutoring-pane')).not.toContainText(String(old.basis!.objectRef!.snapshotId))
    const current = (await ledgers(page)).flatMap(l => l.messages)
    expect(current).toHaveLength(1)
    expect(current.some(m => m.payload.actionId === old.actionId)).toBe(false)
    expect(current.every(m => m.payload.basis?.objectRef?.attemptId === nextHead.attempt.attemptId)).toBe(true)
    expect(await rendered()).toEqual([current[0]!.payload.actionId])
    expect(receipts.some(path => path.includes(`/actions/${old.actionId}/`))).toBe(false)
  } finally { held.release() }
})

test('原代际代码正文在恢复并重读后迟到，不展示或补回执，新的显式代码求助仍可用', async ({ page }) => {
  const head = await fixedProject(page, 'tutor-code-generation')
  const held = await holdCodeReply(page), receipts = receiptWrites(page)
  try {
    await askCode(page, '仅属于原代际的代码回答')
    const old = await held.ready
    await expect(page.getByTestId('tutor-message')).toHaveCount(0)
    const rotated = await recoverRunContext(page)
    expect(rotated.status).toBe(200); expect(rotated.after).not.toBe(rotated.before)
    expect(old.generation).toBe(rotated.before)
    await clickWorkspaceAction(page, '重新读取')
    await expect(page.locator('.cw')).toBeVisible()
    await clickWorkspaceAction(page, '就项目求助')
    await expect(page.getByTestId('tutor-history')).toContainText('暂无可回取')
    const rendered = await observeRenderedActions(page)
    held.release(); await held.delivered
    await askCode(page, '在新代际重新核对原确认代码')
    await expect(page.getByTestId('tutor-message')).toHaveCount(1)
    await expect(page.getByTestId('tutor-source')).toContainText(`原快照 ${head.snapshots[0]!.snapshotId}`)
    await expect(page.locator(`[data-action-id="${old.actionId}"]`)).toHaveCount(0)
    const messages = (await ledgers(page)).flatMap(l => l.messages)
    expect(messages.some(m => m.payload.actionId === old.actionId)).toBe(false)
    expect(messages).toHaveLength(1)
    expect(messages[0]!.payload.generation).toBe(rotated.after)
    expect(await rendered()).toEqual([messages[0]!.payload.actionId])
    expect(receipts.some(path => path.includes(`/actions/${old.actionId}/`))).toBe(false)
    expect((await serverHead(page)).files).toEqual(head.files)
  } finally { held.release() }
})

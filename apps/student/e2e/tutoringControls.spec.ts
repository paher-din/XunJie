import { test, expect, type Page } from '@playwright/test'
import { create, edit, openFileMenu, start as startWorkspace, sceneUrl, localState } from './helpers'
import { fixedProject, selectRun, recoverRunContext } from './runHelpers'

const panel = (page: Page) => page.getByTestId('tutoring-controls')
async function closePanel(page:Page) {
  await page.getByRole('button',{name:'关闭',exact:true}).click()
  await expect(panel(page)).toHaveCount(0)
}
async function start(page:Page,name:string) {
  await startWorkspace(page,name)
  await page.getByRole('button',{name:'任务信息',exact:true}).click()
  await expect(panel(page)).toBeVisible()
}
async function head(page: Page) {
  return page.evaluate(async () => {
    const headers = { 'x-i0prep-scenario': new URLSearchParams(location.search).get('scenario')! }
    const context = (await (await fetch('/__i0prep/context', { headers })).json()).data
    return (await (await fetch(`/__i0prep/api/attempts/${context.refs.attemptId}`, { headers })).json()).data
  })
}
function requests(page: Page) {
  const posts: Array<{ key: string; body: string }> = []
  page.on('request', r => {
    if (r.method() === 'POST' && /\/attempts\/[^/]+\/controls$/.test(r.url())) {
      posts.push({ key: r.headers()['idempotency-key']!, body: r.postData()! })
    }
  })
  return posts
}
async function saveFile(page: Page, text = 'int main(void) { return 0; }\n') {
  await closePanel(page)
  await create(page); await edit(page, text)
  await page.getByRole('button', { name: '确认保存', exact: true }).click()
  await expect(page.locator('.ws-flow')).toContainText('确认作品 v1')
  await page.getByRole('button',{name:'任务信息',exact:true}).click()
}

test('固定帮助政策和三个控制分别可查，默认提醒关闭，键盘操作不激活 ready', async ({ page }) => {
  const posts = requests(page)
  await page.goto(sceneUrl('controls-defaults'))
  await expect(page.locator('.ts-badge')).toHaveAttribute('data-status','ready')
  await page.getByRole('button',{name:'任务信息',exact:true}).click()
  await expect(panel(page)).toContainText('不提供整份可直接提交的答案')
  await expect(panel(page)).toContainText('限定检查状态尚未核对')
  expect(posts).toHaveLength(0)
  await closePanel(page)
  await page.getByRole('button', { name: '开始 Attempt', exact: true }).click()
  await page.getByRole('button',{name:'任务信息',exact:true}).click()
  await expect(panel(page)).toContainText('当前未处于限定帮助检查')
  await expect(panel(page).getByRole('switch', { name: '里程碑提醒', exact: true })).toHaveAttribute('aria-checked', 'false')
  const before = await head(page)
  const capture = panel(page).getByRole('switch', { name: '过程采集', exact: true })
  await capture.focus(); await page.keyboard.press('Space')
  await expect(capture).toHaveAttribute('aria-checked', 'false')
  await expect(panel(page)).toContainText('控制已确认')
  const reminder = panel(page).getByRole('switch', { name: '里程碑提醒', exact: true })
  await reminder.focus(); await page.keyboard.press('Enter')
  await expect(reminder).toHaveAttribute('aria-checked', 'true')
  const after = await head(page)
  expect(after.attempt.status).toBe(before.attempt.status)
  expect(after.attempt.decisionEpoch).toBe(before.attempt.decisionEpoch)
  expect(after.attempt.captureRevision).toBe(before.attempt.captureRevision + 1)
  expect(JSON.parse(posts[0]!.body).control).toEqual({ kind: 'capture', value: false })
  expect(JSON.parse(posts[1]!.body).control).toEqual({ kind: 'reminders', value: true })
})

test('关闭采集仍确认作品；恢复不追认暂停期间的旧过程', async ({ page }) => {
  await start(page, 'controls-capture-save'); await saveFile(page)
  const before = await head(page)
  await panel(page).getByRole('switch', { name: '过程采集', exact: true }).click()
  await expect(panel(page).getByRole('switch', { name: '过程采集', exact: true })).toHaveAttribute('aria-checked', 'false')
  await expect(panel(page)).toContainText('属于功能数据')
  await closePanel(page)
  await edit(page, '// paused capture save\n')
  await page.getByRole('button', { name: '确认保存', exact: true }).click()
  await expect(page.locator('.ws-flow')).toContainText('确认作品 v2')
  expect((await localState(page)).workspace!.files[0]!.text).toContain('paused capture save')
  await page.getByRole('button',{name:'任务信息',exact:true}).click()
  await panel(page).getByRole('switch', { name: '过程采集', exact: true }).click()
  await expect(panel(page).getByRole('switch', { name: '过程采集', exact: true })).toHaveAttribute('aria-checked', 'true')
  await expect(panel(page).getByTestId('tutor-coverage')).toContainText('采集空窗')
  // Synthetic stale process arrives through the original sync HTTP, not a fabricated UI coverage fact.
  const result = await page.evaluate(async oldCaptureRevision => {
    const headers = { 'x-i0prep-scenario': new URLSearchParams(location.search).get('scenario')! }
    const c = (await (await fetch('/__i0prep/context', { headers })).json()).data
    const session = (await (await fetch('/__i0prep/api/session', { headers })).json()).data
    const h = (await (await fetch(`/__i0prep/api/attempts/${c.refs.attemptId}`, { headers })).json()).data
    const file = h.files[0]
    const response = await fetch(`/__i0prep/api/attempts/${c.refs.attemptId}/sync`, { method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', 'x-csrf-token': session.csrfToken, 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ recoveryGeneration: c.recoveryGeneration, expectedWorkspaceRevision: h.attempt.workspaceRevision,
        clientId: 'stale-process-control-test', clientSeq: 1, process: { captureRevision: oldCaptureRevision },
        operations: [{ kind: 'update', fileId: file.fileId, baseVersion: file.documentVersion, text: file.text }] }) })
    return { status: response.status, data: (await response.json()).data }
  }, before.attempt.captureRevision)
  expect(result.status).toBe(200)
  expect(result.data.result.process).toEqual({ status: 'not_collected', reason: 'stale_capture_revision' })
})

test('暂停尝试保留已有文件保存，个人恢复不改变采集或提醒', async ({ page }) => {
  await start(page, 'controls-pause-save'); await saveFile(page)
  const before = await head(page)
  await panel(page).getByRole('button', { name: '暂停尝试', exact: true }).click()
  await expect(panel(page).getByRole('button', { name: '恢复尝试', exact: true })).toBeEnabled()
  await closePanel(page)
  await openFileMenu(page)
  await expect(page.getByRole('menuitem',{name:'新建文件',exact:true})).toBeDisabled()
  await page.keyboard.press('Escape')
  await edit(page, '// save while paused\n')
  await page.getByRole('button', { name: '确认保存', exact: true }).click()
  await expect(page.locator('.ws-flow')).toContainText('确认作品 v2')
  expect((await head(page)).attempt.status).toBe('paused')
  await page.getByRole('button',{name:'任务信息',exact:true}).click()
  await panel(page).getByRole('button', { name: '恢复尝试', exact: true }).click()
  await expect(panel(page).getByRole('button', { name: '暂停尝试', exact: true })).toBeEnabled()
  const after = await head(page)
  expect(after.attempt.collecting).toBe(before.attempt.collecting)
  expect(after.attempt.reminders).toBe(before.attempt.reminders)
  expect(after.attempt.decisionEpoch).toBe(before.attempt.decisionEpoch + 1)
})

test('当前尝试或分配暂停立即禁用已配置的运行按钮，恢复后按当前许可再开放',async({page})=> {
  const saved=await fixedProject(page,'controls-current-run-permission'),snapshot=saved.snapshots[0]!
  await selectRun(page,snapshot.snapshotId,snapshot.files.find(f=>f.path==='main.c')!.fileId,'')
  const run=page.getByRole('button',{name:'运行此快照',exact:true}),runs:string[]=[]
  page.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith('/runs'))runs.push(r.postData()!)})
  await expect(run).toBeEnabled()
  await page.getByRole('button',{name:'任务信息',exact:true}).click()
  await panel(page).getByRole('button',{name:'暂停尝试',exact:true}).click()
  await expect(panel(page).getByRole('button',{name:'恢复尝试',exact:true})).toBeEnabled()
  await expect(run).toBeDisabled()
  await closePanel(page)
  await page.getByRole('checkbox',{name:'sample.txt',exact:true}).focus();await page.keyboard.press('Enter')
  expect(runs).toEqual([])
  await page.getByRole('button',{name:'任务信息',exact:true}).click()
  await panel(page).getByRole('button',{name:'恢复尝试',exact:true}).click()
  await expect(run).toBeEnabled()
  // Published assignment pause is a UI-consumer negative case, not a teacher authorization proof.
  await page.route('**/api/assignments/*',async route=> {
    const response=await route.fetch(),envelope=await response.json()
    envelope.data.active=false;envelope.data.status='paused';envelope.data.assignmentRevision++
    await route.fulfill({response,json:envelope})
  })
  await panel(page).getByRole('button',{name:'重读学习控制',exact:true}).click()
  await expect(run).toBeDisabled()
  expect(runs).toEqual([])
})

test('丢控制ACK后刷新不自动发送，明确核对原键原文且只增加一次采集代际', async ({ page }) => {
  await start(page, 'controls-lost-ack')
  const posts = requests(page), before = await head(page)
  await page.route('**/api/attempts/*/controls', async route => {
    await route.fetch(); await route.abort('failed')
  })
  await panel(page).getByRole('switch', { name: '过程采集', exact: true }).click()
  await expect(panel(page).getByRole('button', { name: '核对原控制请求' })).toBeEnabled()
  expect(posts).toHaveLength(1)
  const persisted = await page.evaluate(async () => {
    const { openWorkspaceDb } = await import('/src/workspace/draftDb.ts' as string)
    const db = await openWorkspaceDb()
    return new Promise<Array<{ key: string; commands?: Array<{ wireJson: string; state: string }> }>>(resolve => {
      const tx = db.transaction('metadata', 'readonly'), request = tx.objectStore('metadata').getAll()
      request.onsuccess = () => resolve(request.result)
    })
  })
  expect(persisted.filter(row => row.key.startsWith('tutor-controls:'))[0]?.commands?.[0]).toMatchObject({ wireJson: posts[0]!.body, state: 'pending' })
  await page.unroute('**/api/attempts/*/controls')
  await page.reload()
  await expect(page.locator('.cw')).toBeVisible()
  await page.getByRole('button',{name:'任务信息',exact:true}).click()
  await expect(panel(page).getByRole('button', { name: '核对原控制请求' })).toBeEnabled()
  expect(posts).toHaveLength(1)
  await panel(page).getByRole('button', { name: '核对原控制请求' }).click()
  await expect(panel(page)).toContainText('控制已确认')
  expect(posts).toHaveLength(2); expect(posts[1]).toEqual(posts[0])
  const after = await head(page)
  expect(after.attempt.captureRevision).toBe(before.attempt.captureRevision + 1)
  expect(after.attempt.decisionEpoch).toBe(before.attempt.decisionEpoch)
})

test('公开教师暂停投影禁用个人恢复，按钮禁用只证明UI消费而非服务端授权', async ({ page }) => {
  await start(page, 'controls-teacher-projection'); await saveFile(page)
  await panel(page).getByRole('button', { name: '暂停尝试', exact: true }).click()
  await expect(panel(page).getByRole('button', { name: '恢复尝试', exact: true })).toBeEnabled()
  const posts = requests(page)
  // Response injection changes only published AssignmentView fields; no limitedCheck invention.
  await page.route('**/api/assignments/*', async route => {
    if (route.request().method() !== 'GET') return route.continue()
    const response = await route.fetch(), envelope = await response.json()
    envelope.data.active = false; envelope.data.status = 'paused'
    envelope.data.assignmentRevision++; envelope.data.reasons.individual = 'teacher pause synthetic projection'
    await route.fulfill({ response, json: envelope })
  })
  await panel(page).getByRole('button', { name: '重读学习控制' }).click()
  await expect(panel(page)).toContainText('学生恢复不能解除')
  await expect(panel(page).getByRole('button', { name: '恢复尝试', exact: true })).toBeDisabled()
  expect(posts).toHaveLength(0)
})

test('服务拒绝原控制仍保护草稿，不显示假成功且不自动重放', async ({ page }) => {
  await start(page, 'controls-refusal'); await saveFile(page)
  const posts = requests(page)
  await page.route('**/api/attempts/*/controls', route => route.fulfill({ status: 409, contentType: 'application/json',
    body: JSON.stringify({ requestId: 'synthetic-control-refusal', error: { code: 'STATE_CONFLICT', message: 'Operation unavailable in the current state.',
      retryable: false, recovery: 'Read the current state before acting.' } }) }))
  await panel(page).getByRole('button', { name: '暂停尝试', exact: true }).click()
  await expect(panel(page)).toContainText('当前阶段或教师暂停不允许')
  await expect(panel(page).getByRole('button', { name: '暂停尝试', exact: true })).toBeEnabled()
  expect(posts).toHaveLength(1)
  await closePanel(page)
  await edit(page, '// still editable\n')
  await page.getByRole('button', { name: '确认保存', exact: true }).click()
  await expect(page.locator('.ws-flow')).toContainText('确认作品 v2')
  expect((await localState(page)).workspace!.files[0]!.text).toContain('still editable')
  expect(posts).toHaveLength(1)
})
test('实际关闭采集和提醒后仍可主动求助，帮助失败不会切换三个控制',async({page})=> {
  await start(page,'controls-explicit-help')
  await panel(page).getByRole('switch',{name:'过程采集',exact:true}).click()
  await expect(panel(page).getByRole('switch',{name:'过程采集',exact:true})).toHaveAttribute('aria-checked','false')
  await expect(panel(page).getByRole('switch',{name:'里程碑提醒',exact:true})).toHaveAttribute('aria-checked','false')
  await closePanel(page)
  await page.getByRole('button',{name:'就项目求助'}).click()
  await page.getByRole('textbox',{name:'就这个任务提问'}).fill('我先自行尝试，只给一点提示')
  await page.getByRole('button',{name:'发送辅导问题'}).click()
  await expect(page.getByTestId('tutor-message')).toHaveCount(1)
  const after=await head(page)
  expect(after.attempt.collecting).toBe(false);expect(after.attempt.reminders).toBe(false)
})

test('已收到但未展示的合成提醒在关闭后取消，再开启不复活旧内容，原主动帮助保留',async({page})=> {
  await start(page,'controls-cancel-old-reminder');await closePanel(page)
  await page.getByRole('button',{name:'就项目求助',exact:true}).click()
  await page.getByRole('textbox',{name:'就这个任务提问'}).fill('先给一个项目提示，提醒样例另属合成准备数据')
  await page.getByRole('button',{name:'发送辅导问题',exact:true}).click()
  await expect(page.getByTestId('tutor-facts')).toContainText('展示：本机已发生')
  const original=await page.getByTestId('tutor-message').getAttribute('data-action-id')
  await page.getByRole('button',{name:'收起辅导',exact:true}).click()
  await page.getByRole('button',{name:'任务信息',exact:true}).click()
  const toggle=panel(page).getByRole('switch',{name:'里程碑提醒',exact:true})
  await toggle.click();await expect(toggle).toHaveAttribute('aria-checked','true')
  const seeded=await page.evaluate(async()=> {
    const headers={'x-i0prep-scenario':new URLSearchParams(location.search).get('scenario')!}
    const session=(await(await fetch('/__i0prep/api/session',{headers})).json()).data
    const response=await fetch('/__i0prep/tutor-script',{method:'POST',headers:{...headers,'Content-Type':'application/json','x-csrf-token':session.csrfToken},
      body:JSON.stringify({kind:'pending-reminder'})})
    if(!response.ok)throw new Error('Synthetic reminder sample unavailable')
    return (await response.json()).data as {jobId:string;actionId:string;content:string}
  })
  const facts=()=>page.evaluate(async actionId=> {
    const db=await new Promise<IDBDatabase>((r,j)=>{const q=indexedDB.open('xunjie-i0-workspace',2);q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error)})
    try {
      const rows=await new Promise<Array<{key:string;messages?:Array<{payload:{actionId:string};shown:boolean;facts:{received?:{state:string};displayed?:unknown}}> }>>((r,j)=>{
        const q=db.transaction('metadata').objectStore('metadata').getAll();q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error)
      })
      return rows.filter(row=>row.key.startsWith('tutor:ledger:')).flatMap(row=>row.messages??[]).find(m=>m.payload.actionId===actionId)
    } finally {db.close()}
  },seeded.actionId)
  await expect.poll(async()=> (await facts())?.facts.received?.state).toBe('confirmed')
  expect((await facts())?.shown).toBe(false);expect((await facts())?.facts.displayed).toBeUndefined()
  const receipts:string[]=[]
  page.on('request',r=>{if(r.method()==='POST'&&r.url().includes(`/actions/${seeded.actionId}/receipts`))receipts.push(r.postData()!)})
  const before=await head(page)
  await toggle.click();await expect(toggle).toHaveAttribute('aria-checked','false')
  const stopped=await page.evaluate(async jobId=> {
    const headers={'x-i0prep-scenario':new URLSearchParams(location.search).get('scenario')!}
    return (await(await fetch(`/__i0prep/api/jobs/${jobId}`,{headers})).json()).data
  },seeded.jobId)
  expect(stopped.purpose).toBe('reminder');expect(stopped.stopRequested).toBe(true);expect(stopped.status).toBe('succeeded')
  await toggle.click();await expect(toggle).toHaveAttribute('aria-checked','true')
  expect((await head(page)).attempt.decisionEpoch).toBe(before.attempt.decisionEpoch)
  await closePanel(page)
  await page.getByRole('button',{name:'就项目求助',exact:true}).click()
  await page.getByRole('button',{name:'重新读取辅导',exact:true}).click()
  await expect(page.getByTestId('tutor-message')).toHaveCount(1)
  await expect(page.getByTestId('tutor-message')).toHaveAttribute('data-action-id',original!)
  await expect(page.getByTestId('tutoring-pane')).not.toContainText(seeded.content)
  expect(receipts.some(body=>/displayed|acknowledged/.test(body))).toBe(false)
})

test('另一标签基于旧显示再次设相同采集值，发送前用新revision且不新增采集代际',async({page,context})=> {
  await start(page,'controls-two-tabs-same-value')
  const other=await context.newPage()
  try {
    await other.goto(page.url());await expect(other.locator('.cw')).toBeVisible()
    await other.getByRole('button',{name:'任务信息',exact:true}).click()
    const second=panel(other).getByRole('switch',{name:'过程采集',exact:true})
    await expect(second).toHaveAttribute('aria-checked','true')
    // Prep initialization creates a fresh synthetic session for the new tab. Align the first
    // tab's in-memory CSRF with that actual shared cookie before exercising the control path.
    await page.evaluate(async()=> {
      const headers={'x-i0prep-scenario':new URLSearchParams(location.search).get('scenario')!}
      const session=(await(await fetch('/__i0prep/api/session',{headers})).json()).data
      const {setCsrfToken}=await import('/src/workspace/http.ts' as string)
      setCsrfToken(session.csrfToken)
    })
    const before=await head(other),firstPosts=requests(page),secondPosts=requests(other)
    let live=false
    // Preserve an actual older public projection on the second page. Its explicit command must still re-read authority.
    await other.route('**/__i0prep/api/attempts/*',async route=> {
      if(route.request().method()!=='GET')return route.continue()
      const response=await route.fetch(),envelope=await response.json()
      if(!live)envelope.data=before
      await route.fulfill({response,json:envelope})
    })
    const first=panel(page).getByRole('switch',{name:'过程采集',exact:true})
    await first.click();await expect(first).toHaveAttribute('aria-checked','false')
    const changed=await head(page)
    await expect(second).toHaveAttribute('aria-checked','true')
    live=true;await second.click()
    await expect(second).toHaveAttribute('aria-checked','false')
    await expect(panel(other)).toContainText('控制已确认')
    expect(firstPosts).toHaveLength(1);expect(secondPosts).toHaveLength(1)
    expect(JSON.parse(firstPosts[0]!.body).control).toEqual({kind:'capture',value:false})
    expect(JSON.parse(secondPosts[0]!.body).control).toEqual({kind:'capture',value:false})
    expect(JSON.parse(secondPosts[0]!.body).expectedAttemptRevision).toBe(changed.attempt.attemptRevision)
    expect(secondPosts[0]!.key).not.toBe(firstPosts[0]!.key)
    const after=await head(other)
    expect(after.attempt.captureRevision).toBe(changed.attempt.captureRevision)
    expect(after.attempt.decisionEpoch).toBe(before.attempt.decisionEpoch)
  } finally {await other.close()}
})

test('旧代际控制ACK晚于恢复和新控制，不改新值、不重贴旧键或清除新确认',async({page})=> {
  await fixedProject(page,'controls-generation-held-ack')
  await page.getByRole('button',{name:'任务信息',exact:true}).click()
  const posts=requests(page)
  let held=false,release!:()=>void,arrived!:()=>void,delivered!:()=>void
  const hold=new Promise<void>(r=>{release=r}),ready=new Promise<void>(r=>{arrived=r}),finished=new Promise<void>(r=>{delivered=r})
  await page.route('**/__i0prep/api/attempts/*/controls',async route=> {
    const response=await route.fetch()
    if(!held){held=true;arrived();await hold;await route.fulfill({response});delivered()}
    else await route.fulfill({response})
  })
  try {
    await panel(page).getByRole('switch',{name:'过程采集',exact:true}).click()
    await ready
    const rotated=await recoverRunContext(page);expect(rotated.status).toBe(200);expect(rotated.after).not.toBe(rotated.before)
    await closePanel(page)
    await page.getByRole('button',{name:'重新读取',exact:true}).click()
    await expect(page.locator('.cw')).toBeVisible()
    await page.getByRole('button',{name:'任务信息',exact:true}).click()
    const current=panel(page).getByRole('switch',{name:'过程采集',exact:true})
    await expect(current).toHaveAttribute('aria-checked','false')
    await current.click();await expect(current).toHaveAttribute('aria-checked','true')
    await expect(panel(page)).toContainText('控制已确认')
    release();await finished
    await expect(current).toHaveAttribute('aria-checked','true')
    expect(posts).toHaveLength(2)
    expect(JSON.parse(posts[0]!.body).recoveryGeneration).toBe(rotated.before)
    expect(JSON.parse(posts[1]!.body).recoveryGeneration).toBe(rotated.after)
    expect(posts[1]!.key).not.toBe(posts[0]!.key)
    await expect(panel(page).getByRole('button',{name:'核对原控制请求',exact:true})).toHaveCount(0)
  } finally {release()}
})

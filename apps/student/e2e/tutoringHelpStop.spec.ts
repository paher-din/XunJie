import { test, expect, type Page } from '@playwright/test'
import { start, create, edit } from './helpers'
async function script(page:Page,kind:string) {
  await page.evaluate(async kind=> {
    const headers={'x-i0prep-scenario':new URLSearchParams(location.search).get('scenario')!}
    const session=(await(await fetch('/__i0prep/api/session',{headers})).json()).data
    const r=await fetch('/__i0prep/tutor-script',{method:'POST',headers:{...headers,'Content-Type':'application/json','x-csrf-token':session.csrfToken},body:JSON.stringify({kind})})
    if(!r.ok) throw new Error('synthetic tutor script failed')
  },kind)
}
test('限定检查权威重读阻止旧页面发送，未知状态不放行，结束后显式求助仍可用',async({page})=> {
  await start(page,'tutor-limited-check')
  const help:string[]=[];page.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith('/help'))help.push(r.postData()!)})
  await page.getByRole('button',{name:'就项目求助'}).click()
  await page.getByRole('textbox',{name:'就这个任务提问'}).fill('检查期间不得发送')
  await expect(page.getByRole('button',{name:'发送辅导问题'})).toBeEnabled()
  // Change the same dev authority immediately before sending, without a stale UI refresh.
  await script(page,'limited-check')
  await page.getByRole('button',{name:'发送辅导问题'}).click()
  await expect(page.getByTestId('tutor-help-limit')).toContainText('限定检查进行中')
  await expect(page.getByRole('button',{name:'发送辅导问题'})).toBeDisabled()
  expect(help).toEqual([])
  await script(page,'check-ended')
  await page.route('**/__i0prep/api/attempts/*',async route=> {
    if(route.request().method()!=='GET')return route.continue()
    const response=await route.fetch(),envelope=await response.json()
    delete envelope.data.limitedCheck
    await route.fulfill({response,json:envelope})
  })
  await page.getByRole('button',{name:'重新读取辅导',exact:true}).click()
  await expect(page.getByTestId('tutor-help-limit')).toContainText('状态尚未确认')
  await page.getByRole('textbox',{name:'就这个任务提问'}).press('Enter')
  expect(help).toEqual([])
  await page.unroute('**/__i0prep/api/attempts/*')
  await page.getByRole('button',{name:'重新读取辅导',exact:true}).click()
  await expect(page.getByRole('button',{name:'发送辅导问题'})).toBeEnabled()
  await page.getByRole('button',{name:'发送辅导问题'}).click()
  await expect(page.getByTestId('tutor-message')).toHaveCount(1)
  expect(help).toHaveLength(1)
})
test('求助丢ACK尚无Job时可明确停止，核对原键后取消原Job而不只屏蔽正文',async({page})=> {
  await start(page,'tutor-unknown-stop');await script(page,'running')
  const helpKeys:string[]=[],cancels:string[]=[]
  page.on('request',r=> {
    if(r.method()==='POST'&&r.url().endsWith('/help'))helpKeys.push(r.headers()['idempotency-key']!)
    if(r.method()==='POST'&&r.url().endsWith('/cancel'))cancels.push(new URL(r.url()).pathname)
  })
  await page.route('**/__i0prep/api/attempts/*/help',async route=>{await route.fetch();await route.abort('failed')})
  await page.getByRole('button',{name:'就项目求助'}).click()
  await page.getByRole('textbox',{name:'就这个任务提问'}).fill('未确认的原求助')
  await page.getByRole('button',{name:'发送辅导问题'}).click()
  await expect(page.getByRole('button',{name:'核对原辅导请求'})).toBeEnabled()
  await expect(page.getByTestId('tutor-job')).toHaveCount(0)
  await page.getByRole('button',{name:'停止这次帮助'}).click()
  await expect(page.getByTestId('tutoring-pane')).toContainText('已保留停止意图')
  expect(cancels).toEqual([])
  await page.unroute('**/__i0prep/api/attempts/*/help')
  await page.getByRole('button',{name:'核对原辅导请求'}).click()
  await expect(page.getByTestId('tutor-job')).toContainText('已请求停止 · cancelled')
  await expect(page.getByTestId('tutor-message')).toHaveCount(0)
  expect(helpKeys).toHaveLength(2);expect(helpKeys[1]).toBe(helpKeys[0])
  expect(cancels).toHaveLength(1)
  const result=await page.evaluate(async()=> {
    const headers={'x-i0prep-scenario':new URLSearchParams(location.search).get('scenario')!}
    const context=(await(await fetch('/__i0prep/context',{headers})).json()).data
    const records=(await(await fetch(`/__i0prep/api/attempts/${context.refs.attemptId}/teaching-records`,{headers})).json()).data
    const jobId=records.messages[0].jobId
    return{jobId,job:(await(await fetch(`/__i0prep/api/jobs/${jobId}`,{headers})).json()).data}
  })
  expect(cancels[0]).toContain(`/jobs/${result.jobId}/cancel`)
  expect(result.job.stopRequested).toBe(true)
})
test('替换help和旧Job取消均丢ACK，分别核对原命令后不会把旧取消改贴新Job或永久阻塞',async({page})=> {
  await start(page,'tutor-two-unknown-jobs');await script(page,'running')
  const keys:Array<{path:string;key:string}>=[]
  page.on('request',r=>{if(r.method()==='POST'&&/\/(help|cancel)$/.test(r.url()))keys.push({path:new URL(r.url()).pathname,key:r.headers()['idempotency-key']!})})
  await page.getByRole('button',{name:'就项目求助'}).click()
  await page.getByRole('textbox',{name:'就这个任务提问'}).fill('原 Job A')
  await page.getByRole('button',{name:'发送辅导问题'}).click()
  await expect(page.getByTestId('tutor-job')).toContainText('running')
  const old=await page.evaluate(async()=> {
    const db=await new Promise<IDBDatabase>(r=>{const q=indexedDB.open('xunjie-i0-workspace',2);q.onsuccess=()=>r(q.result)})
    const rows=await new Promise<Array<{key:string;job?:{jobId:string}}>>(r=>{const q=db.transaction('metadata').objectStore('metadata').getAll();q.onsuccess=()=>r(q.result)});db.close()
    const jobId=rows.find(r=>r.key.startsWith('tutor:ledger:'))!.job!.jobId
    const headers={'x-i0prep-scenario':new URLSearchParams(location.search).get('scenario')!}
    return{jobId,wire:await(await fetch(`/__i0prep/api/jobs/${jobId}`,{headers})).json()}
  })
  // Delay the actual earlier authorized Job A read across replacement, rather than invent its state.
  const oldJobUrl=`**/__i0prep/api/jobs/${old.jobId}`
  await page.route(oldJobUrl,route=>route.fulfill({status:200,json:old.wire}))
  await page.route('**/__i0prep/api/attempts/*/help',async route=>{await route.fetch();await route.abort('failed')})
  await page.getByRole('textbox',{name:'就这个任务提问'}).fill('替换 Job B')
  await page.getByRole('button',{name:'替换并发送'}).click()
  await expect(page.getByRole('button',{name:'核对原辅导请求'})).toBeEnabled()
  const oldCancelUrl=`**/__i0prep/api/jobs/${old.jobId}/cancel`
  await page.route(oldCancelUrl,async route=>{await route.fetch();await route.abort('failed')})
  await page.getByRole('button',{name:'停止这次帮助'}).click()
  await expect.poll(()=>keys.filter(k=>k.path.endsWith(`/jobs/${old.jobId}/cancel`)).length).toBe(1)
  await page.unroute(oldJobUrl);await page.unroute(oldCancelUrl);await page.unroute('**/__i0prep/api/attempts/*/help')
  await expect(page.getByRole('button',{name:'核对原辅导请求'})).toBeEnabled()
  await page.getByRole('button',{name:'核对原辅导请求'}).click()
  await expect(page.getByTestId('tutor-job')).toContainText('已请求停止 · cancelled')
  const newJobText=await page.getByTestId('tutor-job').textContent()
  expect(newJobText).not.toContain(old.jobId)
  await page.getByRole('button',{name:'核对原辅导请求'}).click()
  await expect(page.getByRole('button',{name:'核对原辅导请求'})).toHaveCount(0)
  await expect(page.getByTestId('tutor-job')).toHaveText(newJobText!)
  await expect(page.getByTestId('tutor-message')).toHaveCount(0)
  const oldCancels=keys.filter(k=>k.path.endsWith(`/jobs/${old.jobId}/cancel`))
  expect(oldCancels).toHaveLength(2);expect(oldCancels[1]).toEqual(oldCancels[0])
  await page.getByRole('textbox',{name:'就这个任务提问'}).fill('新的明确求助')
  await expect(page.getByRole('button',{name:'发送辅导问题'})).toBeEnabled()
})
test('学生明确替换产生新键，新epoch不续旧回答；停止丢ACK仍沿原取消核对',async({page})=> {
  await start(page,'tutor-replace');await script(page,'running')
  const helpKeys:string[]=[],cancelKeys:string[]=[]
  page.on('request',r=> { if(r.method()==='POST'&&r.url().endsWith('/help'))helpKeys.push(r.headers()['idempotency-key']!);if(r.method()==='POST'&&r.url().endsWith('/cancel'))cancelKeys.push(r.headers()['idempotency-key']!) })
  await page.getByRole('button',{name:'就项目求助'}).click()
  await page.getByRole('textbox',{name:'就这个任务提问'}).fill('原问题')
  await page.getByRole('button',{name:'发送辅导问题'}).click()
  await expect(page.getByTestId('tutor-job')).toContainText('running')
  await page.getByRole('textbox',{name:'就这个任务提问'}).fill('替换后的问题')
  await script(page,'normal')
  await page.getByRole('button',{name:'替换并发送'}).click()
  await expect(page.getByTestId('tutor-message')).toHaveCount(1)
  expect(new Set(helpKeys).size).toBe(2)
  await page.getByTestId('tutor-message').scrollIntoViewIfNeeded()
  await expect(page.getByTestId('tutor-facts')).toContainText('展示：本机已发生')
  await page.route('**/__i0prep/api/jobs/*/cancel',async route=> {const response=await route.fetch();await route.abort('failed');await page.unroute('**/__i0prep/api/jobs/*/cancel');expect(response.ok()).toBe(true)})
  await page.getByRole('button',{name:'停止这次帮助'}).click()
  await expect(page.getByRole('button',{name:'核对原辅导请求'})).toBeEnabled()
  await page.getByRole('button',{name:'核对原辅导请求'}).click()
  await expect(page.getByTestId('tutor-job')).toContainText('已请求停止 · succeeded')
  expect(cancelKeys).toHaveLength(2);expect(cancelKeys[1]).toBe(cancelKeys[0])
  await expect(page.getByTestId('tutor-message')).toHaveCount(1)
  expect(helpKeys).toHaveLength(2)
})
test('非法正文不展示不报displayed，故障仍可保存；模型失败显示公开失败',async({page})=> {
  await start(page,'tutor-invalid-body')
  const receipts:string[]=[]
  page.on('request',r=> {if(r.method()==='POST'&&r.url().endsWith('/receipts'))receipts.push(r.postData()!)})
  await page.route('**/__i0prep/api/attempts/*/events?*',async route=> {
    const response=await route.fetch(),value=await response.json()
    for(const event of value.data.events)if(event.payload)event.payload.contentHash='0'.repeat(64)
    await route.fulfill({response,json:value})
  })
  await page.getByRole('button',{name:'就项目求助'}).click()
  await page.getByRole('textbox',{name:'就这个任务提问'}).fill('项目问题')
  await page.getByRole('button',{name:'发送辅导问题'}).click()
  await expect(page.getByTestId('tutoring-pane')).toContainText('内容不可用')
  await expect(page.getByTestId('tutor-message')).toHaveCount(0)
  expect(receipts).toEqual([])
  await page.getByRole('button',{name:'收起辅导'}).click()
  await create(page);await edit(page,'int main(void){return 0;}')
  await page.getByRole('button',{name:'确认保存',exact:true}).click()
  await expect(page.locator('.ws-flow')).toContainText('确认作品 v1')
  await page.unroute('**/__i0prep/api/attempts/*/events?*')
  await script(page,'failed')
  await page.getByRole('button',{name:'就项目求助'}).click()
  await page.getByRole('textbox',{name:'就这个任务提问'}).fill('又一个问题')
  await page.getByRole('button',{name:'发送辅导问题'}).click()
  await expect(page.getByTestId('tutor-job')).toContainText('failed')
})
test('替换求助的旧ACK跨越明确停止不能释放屏障，也不把新内容先展示再取消',async({page})=> {
  await start(page,'tutor-late-help-stop');await script(page,'running')
  await page.getByRole('button',{name:'就项目求助'}).click()
  await page.getByRole('textbox',{name:'就这个任务提问'}).fill('原帮助')
  await page.getByRole('button',{name:'发送辅导问题'}).click()
  await expect(page.getByTestId('tutor-job')).toContainText('running')
  let release!:()=>void,arrived!:()=>void
  const hold=new Promise<void>(r=>{release=r}),ready=new Promise<void>(r=>{arrived=r})
  await page.route('**/__i0prep/api/attempts/*/help',async route=> {const response=await route.fetch();arrived();await hold;await route.fulfill({response})})
  await script(page,'normal')
  await page.getByRole('textbox',{name:'就这个任务提问'}).fill('替换帮助')
  await page.getByRole('button',{name:'替换并发送'}).click()
  await ready
  const receipts:string[]=[]
  page.on('request',r=>{if(r.url().endsWith('/receipts'))receipts.push(r.postData()!)})
  await page.getByRole('button',{name:'停止这次帮助'}).click()
  release()
  await expect(page.getByTestId('tutor-job')).toContainText('已请求停止')
  await expect(page.getByTestId('tutor-message')).toHaveCount(0)
  expect(receipts.some(body=>body.includes('displayed'))).toBe(false)
})

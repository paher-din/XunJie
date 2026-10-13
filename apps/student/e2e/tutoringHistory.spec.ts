import {test,expect,type Page} from '@playwright/test'
import {start} from './helpers'
import type {TutorHistoryAction,TutorHistoryQuestion,TutorHistoryReply} from '../src/workspace/tutoringContracts'
type HistoryWire={messages:Array<TutorHistoryQuestion|TutorHistoryReply>;actions:TutorHistoryAction[]}
async function history(page:Page):Promise<HistoryWire> {
  return page.evaluate(async()=> {
    const headers={'x-i0prep-scenario':new URLSearchParams(location.search).get('scenario')!}
    const context=(await(await fetch('/__i0prep/context',{headers})).json()).data
    const response=await fetch(`/__i0prep/api/attempts/${context.refs.attemptId}/teaching-records`,{headers})
    if(!response.ok)throw new Error(`Historical GET failed ${response.status}`)
    return (await response.json()).data
  })
}
async function ask(page:Page,question='核对这次原问题') {
  await page.getByRole('button',{name:'就项目求助',exact:true}).click()
  await page.getByRole('textbox',{name:'就这个任务提问'}).fill(question)
  await page.getByRole('button',{name:'发送辅导问题',exact:true}).click()
}
async function shown(page:Page) {
  await ask(page)
  await expect(page.getByTestId('tutor-message')).toHaveCount(1)
  await page.getByTestId('tutor-message').scrollIntoViewIfNeeded()
  await expect.poll(async()=>(await history(page)).actions.some(a=>a.receipts.some(r=>r.receiptKind==='displayed'))).toBe(true)
  return history(page)
}
async function openHistory(page:Page) {
  await expect(page.locator('.cw')).toBeVisible()
  await page.getByRole('button',{name:'就项目求助',exact:true}).click()
  await expect(page.getByTestId('tutor-history-message')).toHaveCount(1)
}
const receiptWrites=(page:Page) => {
  const writes:string[]=[]
  page.on('request',r=>{if(r.method()==='POST'&&/\/actions\/[^/]+\/receipts$/.test(r.url()))writes.push(r.postData()!)} )
  return writes
}
test('不同client合法回取shown原文/原Job，只读历史无新Delivery或三类回执',async({page,context})=> {
  await start(page,'history-cross-channel');const before=await shown(page)
  const other=await context.newPage(),writes=receiptWrites(other)
  await other.goto(page.url());await openHistory(other)
  await expect(other.getByTestId('tutor-message')).toHaveCount(0)
  await expect(other.getByTestId('tutor-history-message')).toContainText(before.actions[0]!.jobId)
  await expect(other.getByTestId('tutor-history-message')).toContainText('核对这次原问题')
  await expect(other.getByTestId('tutor-history-message').getByRole('button',{name:'我先试试'})).toHaveCount(0)
  await other.getByRole('button',{name:'刷新教学历史',exact:true}).click()
  await expect(other.getByTestId('tutor-history-message')).toHaveCount(1)
  const after=await history(other)
  expect(after.actions[0]!.deliveries).toEqual(before.actions[0]!.deliveries)
  expect(after.actions[0]!.receipts).toEqual(before.actions[0]!.receipts)
  expect(writes).toEqual([])
})
test('已失效shown正文及依据修订作为历史保留，不复活当前候选',async({page,context})=> {
  await start(page,'history-revised');const before=await shown(page)
  const status=await page.evaluate(async()=> {
    const headers={'x-i0prep-scenario':new URLSearchParams(location.search).get('scenario')!}
    const session=(await(await fetch('/__i0prep/api/session',{headers})).json()).data
    return (await fetch('/__i0prep/tutor-script',{method:'POST',headers:{...headers,'Content-Type':'application/json','x-csrf-token':session.csrfToken},
      body:JSON.stringify({kind:'history-revised'})})).status
  });expect(status).toBe(200)
  const other=await context.newPage(),writes=receiptWrites(other);await other.goto(page.url());await openHistory(other)
  await expect(other.getByTestId('tutor-history-message')).toContainText('原状态：stale · 依据后来修订')
  await expect(other.getByTestId('tutor-message')).toHaveCount(0)
  const after=await history(other);expect(after.actions[0]!.messageId).toBe(before.actions[0]!.messageId)
  expect(after.actions[0]!.receipts).toEqual(before.actions[0]!.receipts);expect(writes).toEqual([])
})
test('received-only且停止的正文不在公共历史中，新通道仍无正文',async({page,context})=> {
  await start(page,'history-not-shown')
  let release!:()=>void,arrived!:()=>void
  const hold=new Promise<void>(r=>{release=r}),ready=new Promise<void>(r=>{arrived=r});let held=false
  await page.route('**/__i0prep/api/attempts/*/events?*',async route=> {
    const response=await route.fetch(),body=await response.json()
    if(!held&&body.data.events.some((e:{payload?:unknown})=>!!e.payload)){held=true;arrived();await hold}
    await route.fulfill({response})
  })
  await ask(page);await ready;await page.getByRole('button',{name:'收起辅导'}).click();release()
  const localReceived=()=>page.evaluate(async()=> {
    const db=await new Promise<IDBDatabase>(r=>{const q=indexedDB.open('xunjie-i0-workspace',2);q.onsuccess=()=>r(q.result)})
    const rows=await new Promise<Array<{key:string;messages?:Array<{facts:{received?:{state:string};displayed?:unknown}}> }>>(r=> {
      const q=db.transaction('metadata').objectStore('metadata').getAll();q.onsuccess=()=>r(q.result)
    });db.close();return rows.filter(r=>r.key.startsWith('tutor:ledger:')).flatMap(r=>r.messages??[])
  })
  await expect.poll(async()=>(await localReceived())[0]?.facts.received?.state).toBe('confirmed')
  expect((await localReceived())[0]!.facts.displayed).toBeUndefined()
  await page.getByRole('button',{name:'停止这次帮助'}).click()
  const before=await history(page);expect(before.actions).toEqual([]);expect(before.messages.every(m=>m.authorKind==='student')).toBe(true)
  const other=await context.newPage(),writes=receiptWrites(other);await other.goto(page.url());await expect(other.locator('.cw')).toBeVisible()
  await other.getByRole('button',{name:'就项目求助'}).click()
  await expect(other.getByTestId('tutor-history')).toContainText('暂无可回取')
  await expect(other.getByTestId('tutor-history-question')).toContainText('核对这次原问题')
  await expect(other.getByTestId('tutor-message')).toHaveCount(0);expect(writes).toEqual([])
})
test('同authority负例：shape/hash/scope/Job/received-only非法响应不展示历史也不补回执',async({page,context})=> {
  await start(page,'history-invalid');await shown(page)
  const other=await context.newPage(),writes=receiptWrites(other)
  let fault='none'
  await other.route('**/__i0prep/api/attempts/*/teaching-records',async route=> {
    const response=await route.fetch(),envelope=await response.json(),raw=envelope.data as HistoryWire
    if(fault==='shape')envelope.data={messages:null,actions:[]}
    if(fault==='hash')(raw.messages.find(m=>m.authorKind==='model') as TutorHistoryReply).envelope.body.content+='篡改'
    if(fault==='scope')raw.actions[0]!.scope.studentId='other-account'
    if(fault==='job')raw.actions[0]!.jobId='wrong-original-job'
    if(fault==='received')raw.actions[0]!.receipts=raw.actions[0]!.receipts.map(r=>({...r,receiptKind:'received'}))
    await route.fulfill({response,json:envelope})
  })
  await other.goto(page.url());await openHistory(other)
  for(const kind of ['shape','hash','scope','job','received']) {
    fault=kind;await other.getByRole('button',{name:'刷新教学历史'}).click()
    await expect(other.getByTestId('tutor-history')).toContainText('教学历史不可回取')
    await expect(other.getByTestId('tutor-history-message')).toHaveCount(0)
  }
  expect(writes).toEqual([])
})
test('刷新缓存待重新授权；正常回取后退出账号，真实401清空历史而缓存不冒充许可',async({page,context})=> {
  await start(page,'history-reauthorize');await shown(page)
  const other=await context.newPage(),writes=receiptWrites(other);await other.goto(page.url());await openHistory(other)
  let release!:()=>void,arrived!:()=>void;let held=false
  const hold=new Promise<void>(r=>{release=r}),ready=new Promise<void>(r=>{arrived=r})
  await other.route('**/__i0prep/api/attempts/*/teaching-records',async route=> {
    const response=await route.fetch();if(!held){held=true;arrived();await hold}await route.fulfill({response})
  })
  await other.reload();await ready;await expect(other.locator('.cw')).toBeVisible()
  await other.getByRole('button',{name:'就项目求助'}).click()
  await expect(other.getByTestId('tutor-history-message')).toHaveCount(0)
  await expect(other.getByTestId('tutor-history')).toContainText('正在核对历史读取权限')
  release();await expect(other.getByTestId('tutor-history-message')).toHaveCount(1)
  await other.unroute('**/__i0prep/api/attempts/*/teaching-records')
  const logout=await other.evaluate(async()=> {
    const headers={'x-i0prep-scenario':new URLSearchParams(location.search).get('scenario')!}
    const session=(await(await fetch('/__i0prep/api/session',{headers})).json()).data
    return (await fetch('/__i0prep/api/logout',{method:'POST',headers:{...headers,'x-csrf-token':session.csrfToken}})).status
  });expect(logout).toBe(200)
  await other.getByRole('button',{name:'刷新教学历史'}).click()
  await expect(other.getByTestId('tutor-history')).toContainText('UNAUTHENTICATED')
  await expect(other.getByTestId('tutor-history-message')).toHaveCount(0)
  expect(writes).toEqual([])
})

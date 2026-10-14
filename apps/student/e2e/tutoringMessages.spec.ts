import { chromium, test, expect, type Page } from '@playwright/test'
import { createServer } from 'node:net'
import { createHash } from 'node:crypto'
import { start, setFault } from './helpers'
import type { TutorPayload, TutorPage, TutorHistoryAction } from '../src/workspace/tutoringContracts'
interface ObservedTutorLedger { key:string;clientId:string;cursor:number
  messages:Array<{payload:TutorPayload;shown:boolean;facts:Partial<Record<'received'|'displayed'|'acknowledged',
    {key:string;state:string;wireJson:string}>>}>
  commands:Array<{key:string;wireJson:string;state:string;kind:string}> }
async function ask(page: Page, question='帮我找到一个起点') {
  await page.getByRole('button',{name:'就项目求助',exact:true}).click()
  await page.getByRole('textbox',{name:'就这个任务提问'}).fill(question)
  await page.getByRole('button',{name:'发送辅导问题',exact:true}).click()
}
async function tutorLedger(page: Page) {
  return page.evaluate(async ()=> {
    const db = await new Promise<IDBDatabase>((resolve,reject)=> { const r=indexedDB.open('xunjie-i0-workspace',2);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error) })
    const rows = await new Promise<ObservedTutorLedger[]>(resolve=> {
      const r=db.transaction('metadata').objectStore('metadata').getAll();r.onsuccess=()=>resolve(r.result)
    });db.close();return rows.filter(r=>r.key.startsWith('tutor:ledger:'))
  })
}
async function tutorRecords(page:Page):Promise<{actions:TutorHistoryAction[]}> {
  return page.evaluate(async()=> {
    const headers={'x-i0prep-scenario':new URLSearchParams(location.search).get('scenario')!}
    const context=(await(await fetch('/__i0prep/context',{headers})).json()).data
    const response=await fetch(`/__i0prep/api/attempts/${context.refs.attemptId}/teaching-records`,{headers})
    if(!response.ok)throw new Error('Synthetic history read refused')
    return (await response.json()).data
  })
}
/** Abort real native transactions after put succeeds but before transaction complete. */
async function abortTutorWrites(page:Page,kind:'page'|'help') {
  await page.evaluate(kind=> {
    const nativePut=IDBObjectStore.prototype.put
    Object.assign(window,{tutorAbortCount:0})
    IDBObjectStore.prototype.put=function(value:unknown,key?:IDBValidKey) {
      const request=key===undefined?nativePut.call(this,value):nativePut.call(this,value,key)
      const ledger=value as ObservedTutorLedger
      if(this.name==='metadata'&&typeof ledger?.key==='string'&&ledger.key.startsWith('tutor:ledger:')&&
        (kind==='page'?ledger.messages.length>0:ledger.commands.some(c=>c.kind==='help'&&c.state==='pending'))) {
        request.addEventListener('success',()=> {
          const state=window as typeof window&{tutorAbortCount:number}
          state.tutorAbortCount++;this.transaction.abort()
        })
      }
      return request
    }
  },kind)
}
test('教学页真实IDB事务中止：正文/游标/待received一起回滚，刷新回取原Delivery',async({page})=> {
  await start(page,'tutor-journal-abort')
  await expect.poll(async()=> (await tutorLedger(page)).length).toBe(1)
  const before=(await tutorLedger(page))[0]!, receipts:string[]=[],help:string[]=[],payloads:TutorPayload[]=[]
  page.on('request',r=> {
    if(r.method()==='POST'&&r.url().endsWith('/receipts'))receipts.push(r.postData()!)
    if(r.method()==='POST'&&r.url().endsWith('/help'))help.push(r.postData()!)
  })
  await page.route('**/__i0prep/api/attempts/*/events?*',async route=> {
    const response=await route.fetch(),body=await response.json()
    payloads.push(...body.data.events.filter((e:{payload?:TutorPayload})=>e.payload).map((e:{payload:TutorPayload})=>e.payload))
    await route.fulfill({response})
  })
  await abortTutorWrites(page,'page');await ask(page)
  await expect(page.getByTestId('tutoring-pane')).toContainText('辅导记录没有保存到本机')
  expect(await page.evaluate(()=> (window as typeof window&{tutorAbortCount:number}).tutorAbortCount)).toBeGreaterThan(0)
  const failed=(await tutorLedger(page))[0]!
  expect(failed.cursor).toBe(before.cursor);expect(failed.messages).toEqual([])
  await expect(page.getByTestId('tutor-message')).toHaveCount(0)
  expect(receipts).toEqual([]);expect(help).toHaveLength(1)
  const original=payloads[0]!
  expect(original.actionId).toBeTruthy();expect(original.deliveryId).toBeTruthy()
  await page.reload();await expect(page.locator('.cw')).toBeVisible()
  await expect.poll(async()=> (await tutorLedger(page))[0]?.messages[0]?.facts.received?.state).toBe('confirmed')
  const recovered=(await tutorLedger(page))[0]!
  expect(recovered.clientId).toBe(before.clientId)
  expect(recovered.cursor).toBeGreaterThan(before.cursor)
  expect(recovered.messages[0]!.payload).toEqual(original)
  expect(JSON.parse(receipts[0]!)).toMatchObject({clientId:before.clientId,
    contentHash:original.contentHash,deliveryId:original.deliveryId,receiptKind:'received'})
  expect(help).toHaveLength(1)
  await page.getByRole('button',{name:'就项目求助'}).click()
  await expect(page.getByTestId('tutor-message')).toHaveCount(1)
})
test('help真实IDB事务中止后问题保留、零POST；刷新不补发失败意图',async({page})=> {
  await start(page,'tutor-help-journal-abort')
  await expect.poll(async()=> (await tutorLedger(page)).length).toBe(1)
  const help:string[]=[];page.on('request',r=> {if(r.method()==='POST'&&r.url().endsWith('/help'))help.push(r.postData()!)})
  await abortTutorWrites(page,'help');await ask(page,'本机存储失败时保留的问题')
  await expect(page.getByTestId('tutoring-pane')).toContainText('辅导记录没有保存到本机')
  await expect(page.getByRole('textbox',{name:'就这个任务提问'})).toHaveValue('本机存储失败时保留的问题')
  expect(await page.evaluate(()=> (window as typeof window&{tutorAbortCount:number}).tutorAbortCount)).toBeGreaterThan(0)
  expect((await tutorLedger(page))[0]!.commands).toEqual([])
  expect(help).toEqual([])
  await page.reload();await expect(page.locator('.cw')).toBeVisible()
  await page.getByRole('button',{name:'就项目求助'}).click()
  await expect(page.getByRole('button',{name:'重新读取辅导',exact:true})).toBeEnabled()
  expect((await tutorLedger(page))[0]!.commands).toEqual([]);expect(help).toEqual([])
})
for(const kind of ['received','displayed','acknowledged'] as const) {
  test(`${kind}回执丢ACK：原clientReceiptId/键/正文重发，刷新不增加服务事实`,async({page})=> {
    await start(page,`tutor-${kind}-lost-ack`)
    const requests:Array<{key:string;wire:string;path:string}>=[]
    let dropping=true
    await page.route('**/__i0prep/api/actions/*/receipts',async route=> {
      const r=route.request(),body=JSON.parse(r.postData()!)
      if(body.receiptKind!==kind)return route.continue()
      requests.push({key:r.headers()['idempotency-key']!,wire:r.postData()!,path:new URL(r.url()).pathname})
      const response=await route.fetch()
      expect(response.ok()).toBe(true)
      if(dropping)await route.abort('failed');else await route.fulfill({response})
    })
    await ask(page)
    await page.getByTestId('tutor-message').scrollIntoViewIfNeeded()
    await expect(page.getByTestId('tutor-facts')).toContainText('展示：本机已发生')
    await page.getByRole('button',{name:'我先试试',exact:true}).click()
    await expect.poll(()=>requests.length).toBeGreaterThan(0)
    await expect.poll(async()=> (await tutorLedger(page))[0]?.messages[0]?.facts[kind]?.state).toBe('pending')
    await expect.poll(async()=> (await tutorRecords(page)).actions[0]?.receipts.length).toBe(3)
    const before=(await tutorRecords(page)).actions[0]!.receipts
    const original=(await tutorLedger(page))[0]!.messages[0]!.facts[kind]!
    expect(requests.every(r=>r.key===original.key&&r.wire===original.wireJson)).toBe(true)
    dropping=false
    await page.getByRole('button',{name:'重新读取辅导',exact:true}).click()
    await expect.poll(async()=> (await tutorLedger(page))[0]?.messages[0]?.facts[kind]?.state).toBe('confirmed')
    expect(requests.length).toBeGreaterThan(1)
    expect(requests.every(r=>r.key===requests[0]!.key&&r.wire===requests[0]!.wire&&r.path===requests[0]!.path)).toBe(true)
    expect((await tutorRecords(page)).actions[0]!.receipts).toEqual(before)
    await page.reload();await expect(page.locator('.cw')).toBeVisible()
    await page.getByRole('button',{name:'就项目求助'}).click()
    await expect(page.getByRole('button',{name:'重新读取辅导',exact:true})).toBeEnabled()
    const restored=(await tutorLedger(page))[0]!.messages[0]!.facts[kind]!
    expect(restored).toMatchObject({key:original.key,wireJson:original.wireJson,state:'confirmed'})
    expect((await tutorRecords(page)).actions[0]!.receipts).toEqual(before)
    await expect(page.getByTestId('tutor-message')).toHaveCount(1)
  })
}
test('visible且展开的面板：消息未滚入区域零displayed，实际滚入后才展示',async({page})=> {
  await start(page,'tutor-offscreen')
  let release!:()=>void,arrived!:()=>void,held=false,reads=0
  const hold=new Promise<void>(r=>{release=r}),ready=new Promise<void>(r=>{arrived=r})
  const receipts:string[]=[]
  page.on('request',r=> {if(r.method()==='POST'&&r.url().endsWith('/receipts'))receipts.push(JSON.parse(r.postData()!).receiptKind)})
  await page.route('**/__i0prep/api/attempts/*/events?*',async route=> {
    const response=await route.fetch(),body=await response.json();reads++
    if(!held&&body.data.events.some((e:{payload?:unknown})=>e.payload)){held=true;arrived();await hold}
    await route.fulfill({response})
  })
  // A real long question makes the following answer fall below the existing scroll viewport.
  await ask(page,'隔离检查：请只给一点提示，我会自己构造反例。\n'.repeat(80));await ready
  await page.locator('.ws-chatbody').evaluate(el=>{el.scrollTop=0})
  release()
  await expect.poll(async()=> (await tutorLedger(page))[0]?.messages[0]?.facts.received?.state).toBe('confirmed')
  await expect(page.getByTestId('tutoring-pane')).toBeVisible()
  const geometry=()=>page.getByTestId('tutor-message').evaluate(el=> {
    const scroller=el.closest('.ws-chatbody')!,a=el.getBoundingClientRect(),b=scroller.getBoundingClientRect()
    return{visible:document.visibilityState,messageTop:a.top,viewportBottom:b.bottom}
  })
  const outside=await geometry();expect(outside.visible).toBe('visible');expect(outside.messageTop).toBeGreaterThanOrEqual(outside.viewportBottom)
  const initialReads=reads
  await expect.poll(()=>reads).toBeGreaterThan(initialReads)
  expect((await tutorLedger(page))[0]!.messages[0]!.facts.displayed).toBeUndefined()
  expect(receipts).toEqual(['received'])
  await page.getByTestId('tutor-message').scrollIntoViewIfNeeded()
  await expect.poll(async()=> (await tutorLedger(page))[0]?.messages[0]?.facts.displayed?.state).toBe('confirmed')
  expect(receipts).toEqual(['received','displayed'])
  expect((await tutorLedger(page))[0]!.messages[0]!.facts.acknowledged).toBeUndefined()
})
test('同Action正文冲突不覆盖原已展示内容或回执，显示冲突原因',async({page})=> {
  await start(page,'tutor-content-conflict');await ask(page)
  await expect.poll(async()=> (await tutorLedger(page))[0]?.messages[0]?.facts.displayed?.state).toBe('confirmed')
  const original=(await tutorLedger(page))[0]!.messages[0]!,receipts:string[]=[]
  const conflict='合成传输故障：同一 Action 的正文被错误改写。'
  page.on('request',r=> {if(r.method()==='POST'&&r.url().endsWith('/receipts'))receipts.push(r.postData()!)})
  await page.route('**/__i0prep/api/attempts/*/events?*',async route=> {
    const response=await route.fetch(),body=await response.json()
    // Explicit corrupt transport response, not an authority success or a new source field.
    for(const event of body.data.events as TutorPage['events'])if(event.payload?.actionId===original.payload.actionId) {
      event.payload.content=conflict;event.payload.contentHash=createHash('sha256').update(conflict,'utf8').digest('hex')
    }
    await route.fulfill({response,json:body})
  })
  await page.getByRole('button',{name:'重新读取辅导',exact:true}).click()
  await expect(page.getByTestId('tutoring-pane')).toContainText('新收到的辅导正文与原记录不一致，这次未接纳')
  const after=(await tutorLedger(page))[0]!.messages[0]!
  expect(after.payload).toEqual(original.payload);expect(after.facts).toEqual(original.facts)
  expect(after.shown).toBe(true);expect(after).toMatchObject({valid:false})
  await expect(page.getByTestId('tutor-message')).toHaveCount(1)
  await expect(page.getByTestId('tutor-message')).toContainText(original.payload.content!)
  await expect(page.getByTestId('tutor-message')).not.toContainText(conflict)
  expect(receipts).toEqual([])
})
test('原authority正向多页和resync：从零重取、跨序号缺口、重复正文不增加回执',async({page})=> {
  await start(page,'tutor-multiple-pages')
  for(let i=0;i<3;i++) {
    await ask(page,`合成分页核对问题 ${i+1}`)
    await expect(page.getByTestId('tutor-message')).toHaveCount(i+1)
    await page.getByTestId('tutor-message').last().scrollIntoViewIfNeeded()
    await expect.poll(async()=> (await tutorLedger(page))[0]?.messages[i]?.facts.displayed?.state).toBe('confirmed')
    if(i<2)await page.getByRole('button',{name:'收起辅导'}).click()
  }
  const original=(await tutorLedger(page))[0]!,receipts:string[]=[],pages:Array<{cursor:number;page:TutorPage}>=[]
  let resync=true,begun=false,held=false,release!:()=>void,arrived!:()=>void
  const hold=new Promise<void>(r=>{release=r}),ready=new Promise<void>(r=>{arrived=r})
  page.on('request',r=> {if(r.method()==='POST'&&r.url().endsWith('/receipts'))receipts.push(r.postData()!)})
  await page.route('**/__i0prep/api/attempts/*/events?*',async route=> {
    const url=new URL(route.request().url()),cursor=Number(url.searchParams.get('afterServerSeq'))
    if(!begun&&cursor!==0)return route.continue()
    begun=true;url.searchParams.set('limit','1')
    if(resync) {resync=false;url.searchParams.set('decisionEpoch',String(original.messages.at(-1)!.payload.basis!.decisionEpoch-1))}
    // The existing authority computes both pagination and the mismatched-epoch resync.
    const response=await route.fetch({url:url.toString()}),body=await response.json()
    pages.push({cursor,page:body.data})
    if(!held&&!body.data.resyncRequired&&body.data.hasMore) {held=true;arrived();await hold}
    await route.fulfill({response})
  })
  await page.getByRole('button',{name:'重新读取辅导',exact:true}).click();await ready
  expect(pages[0]!.page.resyncRequired).toBe(true);expect(pages[0]!.page.events).toEqual([])
  expect(receipts).toEqual([])
  release()
  await expect(page.getByRole('button',{name:'重新读取辅导',exact:true})).toBeEnabled()
  const completed=pages.findIndex((p,i)=>i>0&&!p.page.hasMore)
  expect(completed).toBe(3)
  const replay=pages.slice(1,completed+1)
  expect(replay.map(p=>p.cursor)).toEqual([0,replay[0]!.page.nextServerSeq,replay[1]!.page.nextServerSeq])
  expect(replay.map(p=>p.page.hasMore)).toEqual([true,true,false])
  const sequences=replay.map(p=>p.page.events[0]!.serverSeq)
  expect(sequences[1]!-sequences[0]!).toBeGreaterThan(1)
  const after=(await tutorLedger(page))[0]!
  expect(after.cursor).toBe(replay.at(-1)!.page.nextServerSeq)
  expect(after.messages.map(m=>m.payload)).toEqual(original.messages.map(m=>m.payload))
  expect(after.messages.map(m=>m.facts)).toEqual(original.messages.map(m=>m.facts))
  await expect(page.getByTestId('tutor-message')).toHaveCount(3)
  expect(receipts).toEqual([])
})
test('只丢教学ledger后刷新领取新通道，从零读取且不复用旧Delivery/游标',async({page})=> {
  await start(page,'tutor-ledger-loss');await ask(page)
  await expect.poll(async()=> (await tutorLedger(page))[0]?.messages[0]?.facts.displayed?.state).toBe('confirmed')
  const before=(await tutorLedger(page))[0]!
  await page.getByRole('button',{name:'收起辅导'}).click()
  const writes:string[]=[],reads:Array<{clientId:string|null;cursor:string|null}>=[]
  page.on('request',r=> {
    if(r.method()==='POST'&&/\/(help|receipts)$/.test(new URL(r.url()).pathname))writes.push(r.url())
    if(r.method()==='GET'&&new URL(r.url()).pathname.endsWith('/events')) {
      const query=new URL(r.url()).searchParams;reads.push({clientId:query.get('clientId'),cursor:query.get('afterServerSeq')})
    }
  })
  await page.evaluate(async key=> {
    const db=await new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open('xunjie-i0-workspace',2);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})
    const tx=db.transaction('metadata','readwrite')
    const done=new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error)})
    tx.objectStore('metadata').delete(key);await done;db.close()
  },before.key)
  reads.length=0
  await page.reload();await expect(page.locator('.cw')).toBeVisible()
  await expect.poll(async()=> (await tutorLedger(page)).length).toBe(1)
  await expect.poll(async()=> (await tutorLedger(page))[0]?.clientId).not.toBe(before.clientId)
  const after=(await tutorLedger(page))[0]!
  expect(after.messages).toEqual([])
  await expect.poll(()=>reads.some(r=>r.clientId===after.clientId&&r.cursor==='0')).toBe(true)
  expect(reads.every(r=>r.clientId!==before.clientId)).toBe(true)
  await page.getByRole('button',{name:'就项目求助'}).click()
  await expect(page.getByTestId('tutor-message')).toHaveCount(0)
  await expect(page.getByTestId('tutor-history-message')).toHaveCount(1)
  expect(writes).toEqual([])
})
test('未展示内容丢教学ledger后，新通道从零取得新Delivery，不冒用旧通道回执',async({page})=> {
  await start(page,'tutor-unshown-ledger-loss')
  let release!:()=>void,arrived!:()=>void,held=false
  const hold=new Promise<void>(r=>{release=r}),ready=new Promise<void>(r=>{arrived=r})
  await page.route('**/__i0prep/api/attempts/*/events?*',async route=> {
    const response=await route.fetch(),body=await response.json()
    if(!held&&body.data.events.some((e:{payload?:unknown})=>e.payload)){held=true;arrived();await hold}
    await route.fulfill({response})
  })
  await ask(page);await ready;await page.getByRole('button',{name:'收起辅导'}).click();release()
  await expect.poll(async()=> (await tutorLedger(page))[0]?.messages[0]?.facts.received?.state).toBe('confirmed')
  const before=(await tutorLedger(page))[0]!,message=before.messages[0]!,receipts:Array<{path:string;body:Record<string,unknown>}>=[]
  expect(message.shown).toBe(false);expect(message.facts.displayed).toBeUndefined()
  page.on('request',r=> {if(r.method()==='POST'&&r.url().endsWith('/receipts'))receipts.push({path:new URL(r.url()).pathname,body:JSON.parse(r.postData()!)})})
  await page.evaluate(async key=> {
    const db=await new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open('xunjie-i0-workspace',2);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})
    const tx=db.transaction('metadata','readwrite'),done=new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error)})
    tx.objectStore('metadata').delete(key);await done;db.close()
  },before.key)
  await page.reload();await expect(page.locator('.cw')).toBeVisible()
  await expect.poll(async()=> (await tutorLedger(page))[0]?.messages[0]?.facts.received?.state).toBe('confirmed')
  const after=(await tutorLedger(page))[0]!,current=after.messages[0]!
  expect(after.clientId).not.toBe(before.clientId)
  expect(current.payload).toMatchObject({actionId:message.payload.actionId,contentHash:message.payload.contentHash,content:message.payload.content})
  expect(current.payload.deliveryId).not.toBe(message.payload.deliveryId)
  expect(current.facts.received!.key).not.toBe(message.facts.received!.key)
  expect(receipts).toHaveLength(1)
  expect(receipts[0]!.path).toContain(`/actions/${message.payload.actionId}/receipts`)
  expect(receipts[0]!.body).toMatchObject({clientId:after.clientId,deliveryId:current.payload.deliveryId,receiptKind:'received'})
  expect(current.facts.displayed).toBeUndefined();expect((await tutorRecords(page)).actions).toEqual([])
})
test('完整正文→可见展示→明确回应，重读/刷新只保留一份和原通道',async({page},testInfo)=> {
  await start(page,'tutor-receipts')
  const writes:string[]=[];page.on('request',r=>{ if(r.method()==='POST'&&r.url().endsWith('/help'))writes.push(r.postData()!) })
  await expect(page.getByRole('button',{name:'就项目求助'})).toBeVisible()
  expect(writes).toEqual([])
  await ask(page)
  await expect(page.getByTestId('tutor-message')).toHaveCount(1)
  await expect(page.getByTestId('tutor-facts')).toContainText('展示：本机已发生')
  expect(writes).toHaveLength(1)
  await expect(page.getByTestId('tutor-facts')).toContainText('回应：未回应')
  await page.getByRole('button',{name:'我先试试',exact:true}).click()
  await expect(page.getByTestId('tutor-facts')).toContainText('回应：明确回应')
  const before=(await tutorLedger(page))[0]!
  const facts=before.messages[0]!.facts
  expect(Object.keys(facts).sort()).toEqual(['acknowledged','displayed','received'])
  await page.reload()
  await expect(page.locator('.cw')).toBeVisible()
  await page.getByRole('button',{name:'就项目求助'}).click()
  await expect(page.getByTestId('tutor-message')).toHaveCount(1)
  await expect.poll(async()=> (await tutorLedger(page))[0]?.clientId).toBe(before.clientId)
  expect((await tutorLedger(page))[0]!.messages[0]!.facts).toEqual(facts)
  expect(writes).toHaveLength(1)
  await page.getByTestId('tutoring-pane').evaluate(async el=>{await Promise.all(el.getAnimations().map(animation=>animation.finished))})
  await page.getByTestId('tutor-message').scrollIntoViewIfNeeded()
  await page.screenshot({path:testInfo.outputPath('tutoring-preparation.png'),fullPage:true})
})
test('收起面板只收到，未展示；已succeeded仍能停止未展示内容',async({page})=> {
  await start(page,'tutor-not-shown')
  await ask(page)
  await page.getByRole('button',{name:'收起辅导'}).click()
  await expect.poll(async()=> (await tutorLedger(page))[0]?.messages.length).toBe(1)
  const ledger=(await tutorLedger(page))[0]!
  expect(ledger.messages[0]!.facts.displayed).toBeUndefined()
  await page.getByRole('button',{name:'停止这次帮助'}).click()
  await page.getByRole('button',{name:'就项目求助'}).click()
  await expect(page.getByTestId('tutor-job')).toContainText('已请求停止 · succeeded')
  await page.reload();await expect(page.locator('.cw')).toBeVisible()
  await page.getByRole('button',{name:'就项目求助'}).click()
  const stopped=(await tutorLedger(page))[0]!
  expect(stopped.messages[0]!.shown).toBe(false)
  await expect(page.getByTestId('tutor-message')).toHaveCount(0)
})
test('求助丢ACK以原键原正文核对，不自动补发或重复生成',async({page})=> {
  await start(page,'tutor-drop-ack')
  await setFault(page,'drop-ack')
  const sent:Array<{key:string|null;body:string|null}>=[]
  page.on('request',r=> { if(r.method()==='POST'&&r.url().endsWith('/help'))sent.push({key:r.headers()['idempotency-key']??null,body:r.postData()}) })
  await ask(page)
  await expect(page.getByRole('button',{name:'核对原辅导请求'})).toBeEnabled()
  expect(sent).toHaveLength(1)
  await setFault(page,'none')
  await page.getByRole('textbox',{name:'就这个任务提问'}).fill('修改但不发送的新问题')
  await page.getByRole('button',{name:'核对原辅导请求'}).click()
  await expect(page.getByTestId('tutor-message')).toHaveCount(1)
  expect(sent).toHaveLength(2);expect(sent[1]).toEqual(sent[0])
  expect((await tutorLedger(page))[0]!.commands.filter(c=>c.kind==='help')).toHaveLength(1)
})
test('新标签使用独立delivery通道，不把已展示历史缓存当跨客户端回取',async({page,context})=> {
  await start(page,'tutor-other-channel');await ask(page)
  await expect(page.getByTestId('tutor-facts')).toContainText('展示：本机已发生')
  const original=(await tutorLedger(page))[0]!.clientId
  const other=await context.newPage();await other.goto(page.url());await expect(other.locator('.cw')).toBeVisible()
  await other.getByRole('button',{name:'就项目求助'}).click()
  await expect.poll(async()=> (await tutorLedger(other)).length).toBe(2)
  expect((await tutorLedger(other)).map(r=>r.clientId)).toContain(original)
  await expect(other.getByTestId('tutor-message')).toHaveCount(0)
})
test('received回执在途时已经发生的可见展示，停止后仍保留历史及迟到展示回执',async({page})=> {
  await start(page,'tutor-observed-stop')
  let release!:()=>void,arrived!:()=>void
  const hold=new Promise<void>(r=>{release=r}),ready=new Promise<void>(r=>{arrived=r})
  let held=false
  await page.route('**/__i0prep/api/actions/*/receipts',async route=> {
    if(!held&&JSON.parse(route.request().postData()!).receiptKind==='received') {
      held=true;const response=await route.fetch();arrived();await hold;await route.fulfill({response})
    }else await route.continue()
  })
  await ask(page);await ready
  await page.getByTestId('tutor-message').scrollIntoViewIfNeeded()
  await expect(page.getByTestId('tutor-facts')).toContainText('展示：本机已发生')
  await page.getByRole('button',{name:'停止这次帮助'}).click()
  release()
  await expect(page.getByTestId('tutor-job')).toContainText('已请求停止')
  await expect(page.getByTestId('tutor-message')).toHaveCount(1)
  await expect.poll(async()=> (await tutorLedger(page))[0]!.messages[0]!.facts.displayed?.state).toBe('confirmed')
})
test('已重读的新暂停优先于迟到旧教学页，旧正文不展示',async({page})=> {
  await start(page,'tutor-late-control')
  let release!:()=>void,arrived!:()=>void
  const hold=new Promise<void>(r=>{release=r}),ready=new Promise<void>(r=>{arrived=r})
  let held=false
  await page.route('**/__i0prep/api/attempts/*/events?*',async route=> {
    const response=await route.fetch(),body=await response.json()
    if(!held&&body.data.events.some((e:{payload?:unknown})=>!!e.payload)) {held=true;arrived();await hold}
    await route.fulfill({response})
  })
  await ask(page);await ready
  await page.getByRole('button',{name:'收起辅导'}).click()
  await page.getByRole('button',{name:'任务信息',exact:true}).click()
  await page.getByRole('button',{name:'暂停尝试',exact:true}).click()
  await expect(page.getByRole('button',{name:'恢复尝试',exact:true})).toBeEnabled()
  release()
  await page.getByRole('button',{name:'关闭',exact:true}).click()
  await page.getByRole('button',{name:'就项目求助'}).click()
  await expect(page.getByTestId('tutor-message')).toHaveCount(0)
  expect((await tutorLedger(page))[0]!.messages.some(m=>m.shown)).toBe(false)
})
test('window.open复制sessionStorage仍领取独立通道；原标签刷新继续原通道',async({page,context})=> {
  await start(page,'tutor-cloned-storage');await ask(page)
  await expect(page.getByTestId('tutor-facts')).toContainText('展示：本机已发生')
  const original=(await tutorLedger(page))[0]!.clientId
  const opened=context.waitForEvent('page')
  await page.evaluate(()=>{window.open(location.href,'_blank')})
  const other=await opened
  await expect(other.locator('.cw')).toBeVisible()
  await other.getByRole('button',{name:'就项目求助'}).click()
  await expect.poll(async()=> (await tutorLedger(other)).length).toBe(2)
  await expect(other.getByTestId('tutor-message')).toHaveCount(0)
  const cloneId=await other.evaluate(()=>Object.keys(sessionStorage).filter(k=>k.startsWith('tutor:channel:')).map(k=>sessionStorage.getItem(k))[0])
  expect(cloneId).not.toBe(original)
  await other.close();await page.bringToFront();await page.reload()
  await expect(page.locator('.cw')).toBeVisible()
  await expect.poll(async()=>await page.evaluate(()=>Object.keys(sessionStorage).filter(k=>k.startsWith('tutor:channel:')).map(k=>sessionStorage.getItem(k))[0])).toBe(original)
})
test('受控可见性反例：隐藏时收到正文不报展示，恢复后才产生displayed',async({page})=> {
  await start(page,'tutor-hidden-tab')
  let release!:()=>void,arrived!:()=>void
  const hold=new Promise<void>(r=>{release=r}),ready=new Promise<void>(r=>{arrived=r})
  let held=false
  await page.route('**/__i0prep/api/attempts/*/events?*',async route=> {
    const response=await route.fetch(),value=await response.json()
    if(!held&&value.data.events.some((e:{payload?:unknown})=>!!e.payload)){held=true;arrived();await hold}
    await route.fulfill({response})
  })
  await ask(page);await ready
  // This harness kept both real targets visible. Inject only the visibility condition,
  // retaining actual DOM/IntersectionObserver, the same HTTP page and real receipt requests.
  // This is a controlled browser counterexample, not proof of physical tab backgrounding.
  await page.evaluate(()=> {
    Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'})
    document.dispatchEvent(new Event('visibilitychange'))
  })
  release()
  await expect.poll(async()=> (await tutorLedger(page))[0]?.messages.length).toBe(1)
  expect((await tutorLedger(page))[0]!.messages[0]!.facts.displayed).toBeUndefined()
  await page.evaluate(()=> {
    Reflect.deleteProperty(document,'visibilityState')
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await page.getByTestId('tutor-message').scrollIntoViewIfNeeded()
  await expect(page.getByTestId('tutor-facts')).toContainText('展示：本机已发生')
})

test('原生后台标签收到正文不报展示；实际切回前台后仅报一次displayed',async({},testInfo)=> {
  // Normal Playwright connections emulate focus. CDP without defaults preserves
  // the existing native context and trusted browser visibility transitions.
  const port=await new Promise<number>((resolve,reject)=> {
    const listener=createServer();listener.on('error',reject)
    listener.listen(0,'127.0.0.1',()=> {
      const address=listener.address()
      if(!address||typeof address==='string') {listener.close();reject(new Error('No CDP port'));return}
      listener.close(error=>error?reject(error):resolve(address.port))
    })
  })
  const server=await chromium.launchServer({headless:false,args:[`--remote-debugging-port=${port}`],
    ...(process.env.XUNJIE_E2E_BROWSER_CHANNEL?{channel:process.env.XUNJIE_E2E_BROWSER_CHANNEL}:{})})
  let release:(()=>void)|undefined
  try {
    const browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`,{noDefaults:true})
    const context=browser.contexts()[0]!,page=await context.newPage()
    const receipts:Array<{at:number;path:string;contentHash:string;receiptKind:string}>=[]
    const responses:Array<{status:number;receiptKind:string}>=[],reads:Promise<void>[]=[]
    page.on('request',r=> {
      if(r.method()==='POST'&&/\/actions\/[^/]+\/receipts$/.test(new URL(r.url()).pathname)) {
        const body=r.postDataJSON() as {contentHash:string;receiptKind:string}
        receipts.push({at:Date.now(),path:new URL(r.url()).pathname,contentHash:body.contentHash,receiptKind:body.receiptKind})
      }
    })
    page.on('response',r=> {
      if(r.request().method()==='POST'&&/\/actions\/[^/]+\/receipts$/.test(new URL(r.url()).pathname))
        reads.push(r.json().then(body=> {responses.push({status:r.status(),receiptKind:body.data.receiptKind})}))
    })
    await start(page,'tutor-native-hidden')
    await page.evaluate(()=> {
      const events:Array<{state:string;trusted:boolean;at:number}>=[]
      Object.assign(window,{i0NativeVisibility:events})
      document.addEventListener('visibilitychange',event=>events.push({state:document.visibilityState,trusted:event.isTrusted,at:Date.now()}))
    })
    const visibility=()=>page.evaluate(()=>({state:document.visibilityState,hidden:document.hidden,
      events:(window as typeof window&{i0NativeVisibility:Array<{state:string;trusted:boolean;at:number}>}).i0NativeVisibility}))
    let held=false,payload!:{actionId:string;contentHash:string}
    const hold=new Promise<void>(r=> {release=r})
    await page.route('**/__i0prep/api/attempts/*/events?*',async route=> {
      const response=await route.fetch(),body=await response.json()
      const message=body.data.events.find((e:{payload?:unknown})=>!!e.payload)
      if(!held&&message) {held=true;payload=message.payload;await hold}
      await route.fulfill({response})
    })
    await ask(page);await expect.poll(()=>held).toBe(true)
    const other=await context.newPage();await other.goto('about:blank');await other.bringToFront()
    await expect.poll(async()=> (await visibility()).state).toBe('hidden')
    expect((await visibility()).events.some(e=>e.state==='hidden'&&e.trusted)).toBe(true)
    const windowId=async(target:Page)=> {
      const session=await context.newCDPSession(target),root=await browser.newBrowserCDPSession()
      const info=await session.send('Target.getTargetInfo')
      const window=await root.send('Browser.getWindowForTarget',{targetId:info.targetInfo.targetId})
      await session.detach();await root.detach();return window.windowId
    }
    expect(await windowId(page)).toBe(await windowId(other));release!()
    await expect.poll(async()=> (await tutorLedger(page))[0]?.messages[0]?.facts.received?.state).toBe('confirmed')
    expect(await page.getByTestId('tutor-message').count()).toBe(1)
    // Cross a polling interval while the actual tab is hidden; no synthetic events.
    await new Promise(resolve=>setTimeout(resolve,3100))
    const hidden=await visibility(),hiddenMessage=(await tutorLedger(page))[0]!.messages[0]!
    expect(hidden.state).toBe('hidden');expect(hidden.hidden).toBe(true)
    expect(hiddenMessage.facts.displayed).toBeUndefined();expect(hiddenMessage.facts.acknowledged).toBeUndefined()
    expect(receipts.map(r=>r.receiptKind)).toEqual(['received'])
    await page.bringToFront();await expect.poll(async()=> (await visibility()).state).toBe('visible')
    await page.getByTestId('tutor-message').scrollIntoViewIfNeeded()
    await expect.poll(async()=> (await tutorLedger(page))[0]?.messages[0]?.facts.displayed?.state).toBe('confirmed')
    const visible=await visibility(),transition=[...visible.events].reverse().find(e=>e.state==='visible'&&e.trusted)
    expect(transition).toBeDefined()
    const displayed=receipts.filter(r=>r.receiptKind==='displayed');expect(displayed).toHaveLength(1)
    expect(displayed[0]!.at).toBeGreaterThanOrEqual(transition!.at)
    expect(displayed[0]!.contentHash).toBe(payload.contentHash)
    expect(displayed[0]!.path).toContain(`/actions/${encodeURIComponent(payload.actionId)}/receipts`)
    expect((await tutorLedger(page))[0]!.messages[0]!.facts.acknowledged).toBeUndefined()
    await Promise.all(reads);expect(responses).toHaveLength(2)
    expect(responses.every(r=>r.status===200||r.status===201)).toBe(true)
    await testInfo.attach('native-visibility-and-receipts.json',{contentType:'application/json',
      body:Buffer.from(JSON.stringify({browser:browser.version(),hidden,visible,payload,receipts,responses},null,2))})
  } finally {release?.();await server.close()}
})

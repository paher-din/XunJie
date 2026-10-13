import { test, expect, type Page } from '@playwright/test'
import { start, setFault } from './helpers'
async function ask(page: Page, question='帮我找到一个起点') {
  await page.getByRole('button',{name:'就项目求助',exact:true}).click()
  await page.getByRole('textbox',{name:'就这个任务提问'}).fill(question)
  await page.getByRole('button',{name:'发送辅导问题',exact:true}).click()
}
async function tutorLedger(page: Page) {
  return page.evaluate(async ()=> {
    const db = await new Promise<IDBDatabase>((resolve,reject)=> { const r=indexedDB.open('xunjie-i0-workspace',2);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error) })
    const rows = await new Promise<Array<{ key:string;clientId:string;messages:Array<{shown:boolean;facts:Record<string,{key:string;state:string;wireJson:string}>}>;commands:Array<{key:string;wireJson:string;state:string;kind:string}>}>>(resolve=> {
      const r=db.transaction('metadata').objectStore('metadata').getAll();r.onsuccess=()=>resolve(r.result)
    });db.close();return rows.filter(r=>r.key.startsWith('tutor:ledger:'))
  })
}
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

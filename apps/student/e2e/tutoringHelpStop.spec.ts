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

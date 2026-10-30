import { test,expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { create,edit } from './helpers'

// The temporary self-signed certificate is an isolated test condition. Normal
// application TLS verification and OS/browser trust stores are never changed.
test.use({ignoreHTTPSErrors:true,trace:'off'})
test('正常构建连接实际教学HTTPS/SQLite/原worker，公开求助正文与历史回取',async({page})=> {
  test.skip(!process.env.XUNJIE_E2E_SERVICE_NODE,'Requires the approved teaching runtime and native dependencies')
  const password=randomBytes(32).toString('base64url')
  const port=await new Promise<number>((resolvePort,reject)=> {
    const listener=createServer();listener.on('error',reject)
    listener.listen(0,'127.0.0.1',()=> {
      const address=listener.address()
      if(!address||typeof address==='string') {listener.close();reject(new Error('No service port'));return}
      listener.close(error=>error?reject(error):resolvePort(address.port))
    })
  })
  const teaching=resolve(import.meta.dirname,'../../server')
  const linuxPath=teaching.replace(/\\/g,'/').replace(/^([A-Za-z]):/,(_,drive:string)=>`/mnt/${drive.toLowerCase()}`)
  const node=process.env.XUNJIE_E2E_SERVICE_NODE!
  const child=process.platform==='win32'
    ?spawn('wsl.exe',['-d','Ubuntu','--cd',linuxPath,'--',node,'server/app/i0-browser-fixture.ts'],{stdio:'pipe',windowsHide:true})
    :spawn(node,['server/app/i0-browser-fixture.ts'],{cwd:teaching,stdio:'pipe'})
  const closed=new Promise<number|null>(r=>child.on('close',r))
  const ready=new Promise<{synthetic:true;base:string;assignmentId:string;otherAssignmentId:string}>((accept,reject)=> {
    let output=''
    child.on('error',reject);child.on('close',()=>reject(new Error('Isolated service exited before readiness')))
    child.stdout.on('data',(chunk:Buffer)=> {
      output+=chunk.toString('utf8')
      const end=output.indexOf('\n')
      if(end<0) return
      try {accept(JSON.parse(output.slice(0,end)))} catch {reject(new Error('Invalid service readiness'))}
    })
  })
  child.stdin.write(JSON.stringify({synthetic:true,port,password})+'\n')
  try {
    const service=await ready
    expect(service.synthetic).toBe(true)
    // A Linux listener becoming ready precedes WSL's Windows loopback forwarding.
    await expect.poll(async()=> {
      try {return (await page.context().request.get(service.base+'/health/live')).status()} catch {return 0}
    },{timeout:20000}).toBe(200)
    const login=await page.context().request.post(service.base+'/api/sessions',{
      headers:{Origin:service.base},data:{loginName:'student',password},
    })
    expect(login.status()).toBe(200)
    const writes:Array<{path:string;body:Record<string,unknown>}>=[]
    page.on('request',request=> {
      if(request.method()==='POST') writes.push({path:new URL(request.url()).pathname,body:request.postDataJSON()})
    })
    await page.goto(`${service.base}/#/task/${service.assignmentId}`)
    await expect(page.locator('.ts-badge')).toHaveAttribute('data-status','ready')
    expect(writes).toEqual([])
    await page.getByRole('button',{name:'开始 Attempt',exact:true}).click()
    await expect(page.locator('.cw')).toBeVisible()
    await create(page);await edit(page,'int main(void){return 0;}\n')
    await page.getByRole('button',{name:'确认保存',exact:true}).click()
    await expect(page.locator('.cw')).toContainText('文件版本 v1')
    const saved=writes.find(row=>row.path.endsWith('/sync'))!
    const savedAttemptId=saved.path.split('/')[3]!
    const confirmed=await page.context().request.get(`${service.base}/api/attempts/${savedAttemptId}`)
    const head=(await confirmed.json()).data
    expect(head.files[0].text).toBe('int main(void){return 0;}\n')
    expect(head.limitedCheck).toBe(false)
    await page.getByRole('button',{name:'冻结确认作品',exact:true}).click()
    await expect(page.getByText('已冻结快照 v1',{exact:true})).toBeVisible()
    await page.getByRole('button',{name:'就项目求助',exact:true}).click()
    await page.getByRole('textbox',{name:'就这个任务提问'}).fill('隔离合成验证：请给一点边界提示')
    await page.getByRole('button',{name:'发送辅导问题',exact:true}).click()
    await expect(page.getByTestId('tutor-message')).toContainText('隔离合成服务验证')
    await expect(page.getByTestId('tutor-facts')).toContainText('展示：本机已发生')
    await expect(page.getByTestId('tutor-job')).toContainText('succeeded')
    await expect(page.getByRole('button',{name:'核对原辅导请求',exact:true})).toHaveCount(0)
    const accepted=writes.filter(row=>row.path.endsWith('/help'))
    expect(accepted).toHaveLength(1)
    const attemptId=accepted[0]!.path.split('/')[3]!
    expect(attemptId).toBe(savedAttemptId)
    await expect.poll(async()=> {
      const response=await page.context().request.get(`${service.base}/api/attempts/${attemptId}/teaching-records`)
      return (await response.json()).data.actions.length
    }).toBe(1)
    const history=await page.context().request.get(`${service.base}/api/attempts/${attemptId}/teaching-records`)
    expect(history.status()).toBe(200)
    const records=(await history.json()).data
    expect(records.actions).toHaveLength(1)
    expect(records.actions[0].scope.attemptId).toBe(attemptId)
    expect(records.actions[0].receipts.some((row:{receiptKind:string})=>row.receiptKind==='displayed')).toBe(true)
    await expect(page.getByTestId('tutor-source')).toContainText(`原 Job：${records.actions[0].jobId}`)
    await page.getByRole('button',{name:'收起辅导',exact:true}).click()
    await page.getByRole('button',{name:'就这个文件求助',exact:true}).click()
    await page.getByRole('textbox',{name:'就这个任务提问'}).fill('隔离合成验证：只解释这份原快照')
    await page.getByRole('button',{name:'发送辅导问题',exact:true}).click()
    await expect(page.getByTestId('tutor-message')).toHaveCount(2)
    const latest=page.getByTestId('tutor-message').last()
    await latest.scrollIntoViewIfNeeded()
    await expect(latest.getByTestId('tutor-facts')).toContainText('展示：本机已发生')
    await expect(latest.getByTestId('tutor-source')).toContainText(`回答来源：main.c · 文件版本 1`)
    const readRecords=async()=> (await (await page.context().request.get(`${service.base}/api/attempts/${attemptId}/teaching-records`)).json()).data
    await expect.poll(async()=> (await readRecords()).actions.length).toBe(2)
    const both=await readRecords()
    expect(new Set(both.actions.map((a:{jobId:string})=>a.jobId)).size).toBe(2)
    expect(both.actions[0].contentHash).toBe(both.actions[1].contentHash)
    const code=both.actions.find((a:{basis:{objectRef?:{kind:string}}})=>a.basis.objectRef?.kind==='code')
    expect(code.basis.objectRef.fileId).toBe(head.files[0].fileId)
    await expect(latest.getByTestId('tutor-source')).toContainText(`原快照 ${code.basis.objectRef.snapshotId}`)
    await page.getByRole('button',{name:'刷新教学历史',exact:true}).click()
    await expect(page.getByTestId('tutor-history-message')).toHaveCount(2)
    const other=await page.context().newPage(),otherWrites:string[]=[]
    other.on('request',r=>{if(r.method()==='POST')otherWrites.push(new URL(r.url()).pathname)})
    await other.goto(page.url())
    await expect(other.locator('.cw')).toBeVisible()
    await other.getByRole('button',{name:'就项目求助',exact:true}).click()
    await expect(other.getByTestId('tutor-history-message')).toHaveCount(2)
    await expect(other.getByTestId('tutor-message')).toHaveCount(0)
    expect(otherWrites).toEqual([])
    expect((await readRecords()).actions.map((a:{receipts:unknown[]})=>a.receipts)).toEqual(both.actions.map((a:{receipts:unknown[]})=>a.receipts))
    await other.close()
    expect(writes.filter(row=>row.path.endsWith('/help'))).toHaveLength(2)
    expect(writes.some(row=>row.path.startsWith('/__i0prep/'))).toBe(false)
    expect(await page.locator('body').textContent()).not.toContain('PRIVATE_BODY')
    await page.getByRole('button',{name:'收起辅导',exact:true}).click()
    let release!:()=>void,arrived!:()=>void,delivered!:()=>void,held=false
    const hold=new Promise<void>(r=>{release=r}),atAuthority=new Promise<void>(r=>{arrived=r}),finished=new Promise<void>(r=>{delivered=r})
    await page.route(`**/api/attempts/${attemptId}/controls`,async route=> {
      const response=await route.fetch()
      if(!held){held=true;arrived();await hold}
      await route.fulfill({response});delivered()
    })
    try {
      await page.getByRole('button',{name:'任务信息',exact:true}).click()
      await page.getByRole('switch',{name:'过程采集',exact:true}).click()
      await atAuthority
      const nextLogin=await page.context().request.post(service.base+'/api/sessions',{
        headers:{Origin:service.base},data:{loginName:'other',password},
      })
      expect(nextLogin.status()).toBe(200)
      expect((await page.context().request.get(`${service.base}/api/attempts/${attemptId}`)).status()).toBe(403)
      // Keep this document and the original pending HTTP promise alive across the real account switch.
      await page.evaluate(id=>{location.hash=`/task/${id}`},service.otherAssignmentId)
      await expect(page.locator('.ts-badge')).toHaveAttribute('data-status','ready')
      if(await page.getByRole('button',{name:'关闭',exact:true}).count()) {
        await page.getByRole('button',{name:'关闭',exact:true}).click()
        await expect(page.getByTestId('tutoring-controls')).toHaveCount(0)
      }
      await page.getByRole('button',{name:'开始 Attempt',exact:true}).click()
      await expect(page.locator('.cw')).toBeVisible()
      await page.getByRole('button',{name:'任务信息',exact:true}).click()
      const capture=page.getByRole('switch',{name:'过程采集',exact:true})
      await expect(capture).toHaveAttribute('aria-checked','true')
      release();await finished
      await expect(capture).toHaveAttribute('aria-checked','true')
      await capture.click();await expect(capture).toHaveAttribute('aria-checked','false')
      await expect(page.getByTestId('tutoring-controls')).toContainText('控制已确认')
      const controls=writes.filter(row=>row.path.endsWith('/controls'))
      expect(controls).toHaveLength(2)
      expect(controls[0]!.path).toBe(`/api/attempts/${attemptId}/controls`)
      expect(controls[1]!.path).not.toBe(controls[0]!.path)
      const nextAttemptId=controls[1]!.path.split('/')[3]!
      const nextHead=(await(await page.context().request.get(`${service.base}/api/attempts/${nextAttemptId}`)).json()).data
      const nextAssignment=(await(await page.context().request.get(`${service.base}/api/assignments/${service.otherAssignmentId}`)).json()).data
      expect(nextAssignment.studentId).toBe('other')
      expect(nextHead.attempt.assignmentId).toBe(service.otherAssignmentId);expect(nextHead.files).toEqual([])
      await page.getByRole('button',{name:'关闭',exact:true}).click()
      await expect(page.getByTestId('tutoring-controls')).toHaveCount(0)
      await page.getByRole('button',{name:'就项目求助',exact:true}).click()
      await expect(page.getByTestId('tutor-history')).toContainText('暂无可回取')
      await expect(page.getByTestId('tutor-message')).toHaveCount(0)
      expect(writes.filter(row=>row.path.endsWith('/help'))).toHaveLength(2)
    } finally {release()}
  } finally {
    child.stdin.end('stop\n')
    await Promise.race([closed,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Isolated service shutdown timeout')),15000))])
  }
})

import { test, expect } from '@playwright/test'
import { fixedProject } from './runHelpers'
import { create, edit, start, serverHead } from './helpers'
test('确认文件/精确选区核对后显式求助，修改草稿后阻止旧对象发送且不自动保存',async({page})=> {
  const head=await fixedProject(page,'tutor-code-selection'), snapshot=head.snapshots[0]!, file=snapshot.files.find(f=>f.path==='sample.txt')!
  const writes:Array<{path:string;body:Record<string,unknown>}>=[]
  page.on('request',r=> {if(r.method()==='POST'&&/\/(help|sync|snapshots|runs)$/.test(new URL(r.url()).pathname))writes.push({path:new URL(r.url()).pathname,body:JSON.parse(r.postData()!)})})
  await page.getByRole('button',{name:'就这个文件求助'}).click()
  await expect(page.getByTestId('tutor-object')).toContainText('sample.txt')
  expect(writes).toEqual([])
  await page.getByRole('button',{name:'收起辅导'}).click()
  const editor=page.locator('.monaco-editor textarea').first()
  await editor.focus();await page.keyboard.press('ControlOrMeta+a')
  await page.getByRole('button',{name:'就所选代码求助'}).click()
  await expect(page.getByTestId('tutor-object')).toContainText('行 1–2')
  await page.getByRole('textbox',{name:'就这个任务提问'}).fill('请解释这个选区中的边界')
  await page.getByRole('button',{name:'发送辅导问题'}).click()
  await expect.poll(()=>writes.filter(r=>r.path.endsWith('/help')).length).toBe(1)
  const ref=writes.find(r=>r.path.endsWith('/help'))!.body.objectRef
  expect(ref).toEqual({kind:'code',attemptId:head.attempt.attemptId,snapshotId:snapshot.snapshotId,fileId:file.fileId,path:file.path,
    documentVersion:file.documentVersion,contentHash:file.contentHash,range:{startLine:1,startColumn:1,endLine:2,endColumn:1}})
  await page.getByRole('button',{name:'收起辅导'}).click()
  await editor.focus();await page.keyboard.press('ControlOrMeta+End');await page.keyboard.insertText('// unconfirmed')
  await expect(page.locator('.cw-protect')).toHaveText('本机草稿已保护')
  await page.getByRole('button',{name:'就所选代码求助'}).click()
  await expect(page.getByRole('status')).toContainText('草稿有未确认修改')
  expect(writes.filter(r=>!r.path.endsWith('/help'))).toEqual([])
  expect((await serverHead(page)).files).toEqual(head.files)
})
test('没有快照的代码问题只说明缺口，不偷偷确认/冻结；开放项目问题不要求代码',async({page})=> {
  await start(page,'tutor-no-snapshot');await create(page);await edit(page,'\uFEFF// 😀\r\nint x;\r// original\n')
  const writes:string[]=[];page.on('request',r=> {if(r.method()==='POST'&&/\/(help|sync|snapshots)$/.test(r.url()))writes.push(r.url())})
  await page.getByRole('button',{name:'就这个文件求助'}).click()
  await expect(page.getByRole('status')).toContainText('求助不会自动保存')
  expect(writes).toEqual([])
  await page.getByRole('button',{name:'就项目求助'}).click()
  await page.getByRole('textbox',{name:'就这个任务提问'}).fill('如何寻找起点？')
  await page.getByRole('button',{name:'发送辅导问题'}).click()
  await expect(page.getByTestId('tutor-message')).toHaveCount(1)
  expect(writes).toHaveLength(1)
})

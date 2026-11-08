import { probeEvidenceDirectory, writeEvidence, captureEvidence, mkdtemp } from './lib/probe-evidence.mjs';
// Run under with-native-desktop-lock; Chrome composition checks do not claim OS IME coverage.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { fixedPdf } from '../apps/server/tests/fixtures/pdf-material.mjs';
const product=process.env.XUNJIE_PRODUCT_PACKAGE;
const mod=await import(product?pathToFileURL(join(product,'app/product-runtime.js')).href:'@xunjie/product-runtime');
const resources=product?Object.fromEntries(Object.entries(JSON.parse(await readFile(join(product,'resources.json'),'utf8'))).map(([k,v])=>[k,typeof v==='string'&&/(Path|Bin|Root|Helper)$/.test(k)?resolve(product,v):v])):
 {nodePath:process.execPath,nodeVersion:'24.21.0',postgresVersion:'18.6',postgresBin:process.env.XUNJIE_PRODUCT_POSTGRES_BIN,webRoot:resolve('apps/web/dist-runtime'),windowsPrerequisitePath:resolve('scripts/windows-prereq-prepare.ps1')};
const out=probeEvidenceDirectory(process.env.XJ_PDF_UI_OUT),root=await mkdtemp(join(tmpdir(),'xj-pdf-ui-218-'));
await mkdir(out,{recursive:true});
const report={platform:process.platform,product:product??'source-build',checks:[],ime:null};
const runtime=mod.openProductRuntime({root,resources});let host,browser;
try{
 await runtime.install({profile:'local'});host=await mod.createProductRuntimeHost({root,createApplication:mod.createProductLearningApplication});
 const api=async(route,body)=>{const r=await fetch(host.endpoint+'/api/learning/'+route,{headers:{'content-type':'application/json','x-xj-space':'personal'},...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})});assert.equal(r.status,200,route);return r.json();};
 const activity=await api('activities',{requestId:randomUUID(),goal:'PDF 来源与草稿恢复',question:'',references:[]}),route='pdf/'+activity.activityId;
 browser=await chromium.launch({channel:'chrome',headless:false});report.chrome=browser.version();
 const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>report.pageErrors=(report.pageErrors??[]).concat(e.message));
 const openConversation=async()=>{const button=page.getByRole('button',{name:/^(打开对话|问题与引用)$/});await button.waitFor();if(await button.getAttribute('aria-expanded')==='false')await button.click();};
 await page.goto(host.endpoint+'/?space=personal&activity='+activity.activityId);await page.getByRole('button',{name:'目标与材料',exact:true}).click();
 let drop=true,uploadIdentity;
 await page.route('**/api/learning/pdf/'+activity.activityId,async intercepted=>{
  if(intercepted.request().method()==='POST'&&drop){drop=false;uploadIdentity=intercepted.request().postDataJSON();await intercepted.fetch();await intercepted.abort('failed');}
  else await intercepted.continue();
 });
 await page.locator('input[type=file][accept="application/pdf,.pdf"]').setInputFiles({name:'same.pdf',mimeType:'application/pdf',buffer:fixedPdf()});
 await expect.poll(async()=> (await api(route)).length).toBe(1);
 await expect(page.getByRole('button',{name:'核对并继续原请求',exact:true})).toBeEnabled();
 await page.reload();await page.getByRole('button',{name:'目标与材料',exact:true}).click();
 await page.getByRole('button',{name:'核对并继续原请求',exact:true}).click();
 await page.getByRole('img',{name:'PDF 第 1 页固定页图',exact:true}).waitFor();
 const docs=await api(route);assert.equal(docs.length,1);assert.equal(docs[0].documentId,uploadIdentity.documentId);report.checks.push('lost-upload-confirmation-reload-original-identity');
 await page.getByRole('button',{name:'相邻两页',exact:true}).click();await page.getByRole('img',{name:'PDF 第 2 页固定页图',exact:true}).waitFor();
 await page.getByRole('button',{name:'引用这两页',exact:true}).click();
 const question=page.locator('textarea:visible').last();await expect(question).toBeFocused();
 const draftRoute='drafts/'+activity.activityId;
 {
  await question.fill('保留中文问题与固定 PDF 引用');
  const cdp=await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition',{text:'为什么',selectionStart:3,selectionEnd:3});
  await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  assert.deepEqual(await api('intents/'+activity.activityId),[]);
  await cdp.send('Input.insertText',{text:'为什么'});await cdp.detach();
  report.checks.push('Chrome-IME-composition-Enter-does-not-send');
 }

 const questionBefore=await question.inputValue();
 await expect.poll(async()=> (await api(draftRoute)).question).toBe(questionBefore);
 await expect.poll(async()=> (await api(draftRoute)).references.length).toBe(1);
 const quoted=await api(draftRoute);assert.deepEqual(quoted.references[0].range.target.pages,[1,2]);
 await page.getByRole('button',{name:'完整页',exact:true}).click();await page.getByRole('button',{name:'下一页',exact:true}).click();
 await page.getByRole('button',{name:'框选区域',exact:true}).click();
 const box=await page.getByRole('img',{name:'PDF 第 2 页固定页图',exact:true}).boundingBox();
 await page.mouse.move(box.x+box.width*.12,box.y+box.height*.1);await page.mouse.down();await page.mouse.move(box.x+box.width*.9,box.y+box.height*.55,{steps:12});await page.mouse.up();
 await page.getByRole('button',{name:'引用所选区域',exact:true}).click();
 await expect.poll(async()=> (await api(draftRoute)).references.length).toBe(2);await expect(question).toHaveValue(questionBefore);
 const fixed=await api(draftRoute),regionRef=fixed.references[1],reading=await api(route+'/reads/'+regionRef.source.readingId);
 assert.ok(reading.region.width>.7);assert.equal(reading.pages[0].transform.region.width,reading.region.width);report.checks.push('adjacent-pages-region-real-crop-single-draft');
 // A same-name replacement remains a distinct original; old source buttons reopen retained bytes.
 await page.locator('input[type=file][accept="application/pdf,.pdf"]').setInputFiles({name:'same.pdf',mimeType:'application/pdf',buffer:fixedPdf()});
 await expect.poll(async()=> (await api(route)).length).toBe(2);
 await page.reload();await openConversation();await page.getByRole('button',{name:/same.pdf.*第 2 页选区/}).click();
 await expect(page.locator('[data-pdf-reading-id]')).toHaveAttribute('data-pdf-reading-id',reading.readingId);
 await expect(question).toHaveValue(questionBefore);report.checks.push('same-name-refresh-opens-original-rendition');
 await host.stop();host=await mod.createProductRuntimeHost({root,createApplication:mod.createProductLearningApplication});
 await page.goto(host.endpoint+'/?space=personal&activity='+activity.activityId);
 await openConversation();await page.getByRole('button',{name:/same.pdf.*第 2 页选区/}).click();
 await expect(page.locator('[data-pdf-reading-id]')).toHaveAttribute('data-pdf-reading-id',reading.readingId);
 assert.deepEqual(await api(route+'/reads/'+reading.readingId),reading);await expect(question).toHaveValue(questionBefore);report.checks.push('host-restart-pure-fixed-reading');
 await page.getByRole('button',{name:'返回活动列表',exact:true}).click();
 await page.waitForURL(url=>!url.searchParams.has('activity'));
 await page.goBack();await page.waitForURL(url=>url.searchParams.get('activity')===activity.activityId);await openConversation();
 await expect(question).toHaveValue(questionBefore);
 await expect.poll(async()=> (await api(draftRoute)).references.length).toBe(2);
 await page.getByRole('button',{name:/same.pdf.*第 2 页选区/}).click();
 await expect(page.locator('[data-pdf-reading-id]')).toHaveAttribute('data-pdf-reading-id',reading.readingId);
 report.checks.push('browser-back-preserves-question-and-fixed-references');
 await captureEvidence(page, {path:join(out,process.platform+'-durable.png'),fullPage:true});
 await page.emulateMedia({colorScheme:'dark'});await page.setViewportSize({width:1100,height:900});await captureEvidence(page, {path:join(out,process.platform+'-narrow-dark.png'),fullPage:true});
 assert.deepEqual(report.pageErrors??[],[]);report.passed=true;
}catch(e){report.error=e.message;report.passed=false;if(browser)await captureEvidence(browser.contexts()[0]?.pages()[0], {path:join(out,process.platform+'-durable-failure.png'),fullPage:true});}
finally{
 await browser?.close();await host?.stop();await runtime.stop();await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
 await writeEvidence(join(out,process.platform+'-durable.json'),JSON.stringify(report,null,2)+'\n');
}
console.log(JSON.stringify(report));if(!report.passed)process.exitCode=1;

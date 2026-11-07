// Real Chrome, native PostgreSQL and the formal product, with no fixture receiver.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {chromium,expect} from '@playwright/test';
import {openProductRuntime,resolveCredential} from '@xunjie/product-runtime';
import {aluPackage,aluCoursePackage} from '../components/alu-experiment/package.mjs';
const output=resolve(process.env.XUNJIE_ALU_OUTPUT??'.verification/wp04-192-product');await mkdir(output,{recursive:true});
const root=await mkdtemp(join(tmpdir(),'xj-alu-product-'));
let resources={nodePath:process.execPath,nodeVersion:'24.21.0',postgresBin:process.env.XUNJIE_PRODUCT_POSTGRES_BIN,
  postgresVersion:'18.6',webRoot:resolve(process.env.XUNJIE_ALU_WEB_ROOT??process.env.XUNJIE_ALU_BASELINE_WEB_ROOT??'apps/web/dist-runtime'),windowsPrerequisitePath:resolve('scripts/windows-prereq-prepare.ps1')};
let runtimeFactory=openProductRuntime,credential=resolveCredential;
if(process.env.XUNJIE_ALU_PRODUCT_ROOT) {
  const packageRoot=resolve(process.env.XUNJIE_ALU_PRODUCT_ROOT), declared=JSON.parse(await readFile(join(packageRoot,'resources.json'),'utf8'));
  resources={...declared,nodePath:resolve(packageRoot,declared.nodePath),postgresBin:resolve(packageRoot,declared.postgresBin),webRoot:resolve(packageRoot,declared.webRoot),
    ...(declared.windowsPrerequisitePath?{windowsPrerequisitePath:resolve(packageRoot,declared.windowsPrerequisitePath)}:{}),
    ...(declared.windowsSessionHelper?{windowsSessionHelper:resolve(packageRoot,declared.windowsSessionHelper)}:{})};
  const bundled=await import(pathToFileURL(join(packageRoot,'app/product-runtime.js')).href);
  runtimeFactory=bundled.openProductRuntime;credential=bundled.resolveCredential;
}
if(!resources.postgresBin)throw new Error('Native PostgreSQL required');
const runtime=runtimeFactory({root,resources}),report={platform:process.platform,arch:process.arch,root,candidate:process.env.XUNJIE_ALU_PRODUCT_ROOT??'workspace production Web/runtime',cases:[],status:'running'};
let browser,page;
try {
  await runtime.install({profile:'local'});const {endpoint}=await runtime.start();
  const admin={authorization:`Bearer ${await credential(root,'control')}`};
  const api=async(route,body,headers=admin)=>{
    const response=await fetch(new URL('/api/learning/'+route,endpoint),{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
    const value=await response.json();assert.equal(response.status,200,`${route}: ${JSON.stringify(value)}`);return value;
  };
  const component=await aluPackage(),course=await aluCoursePackage();
  if(process.env.XUNJIE_ALU_PRODUCT_ROOT) {
    const generated=join(output,'course-package');
    const built=spawnSync(process.execPath,['components/alu-experiment/package.mjs',generated],{encoding:'utf8'});
    assert.equal(built.status,0,built.stderr);
    for(const action of ['component-import','course-import']) {
      const imported=spawnSync(resources.nodePath,[resolve(process.env.XUNJIE_ALU_PRODUCT_ROOT,'app/cli.js'),action,
        '--root',root,'--file',join(generated,action==='component-import'?'component.json':'course.json')],{encoding:'utf8',maxBuffer:32*1024*1024});
      assert.equal(imported.status,0,imported.stderr);
    }
    report.cases.push('packaged CLI reads confined relative files and imports the full runtime/source/material package');
  } else {
    const definition=await api('manage/component-import',component);
    course.release.components[0].definition=definition;
    await api('manage/course-import',course);
  }
  report.cases.push('normal component and course imports');
  const password=randomUUID(),loginName='alu-product';
  const member=await api('manage/members',{requestId:randomUUID(),loginName,password});
  await api('manage/course-access',{requestId:randomUUID(),courseId:course.course.courseId,principalId:member.principalId,active:true});
  browser=await chromium.launch({channel:'chrome',headless:true});report.browser=browser.version();
  const context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});
  assert.equal((await context.request.post(endpoint+'/api/learning/login',{data:{loginName,password}})).status(),200);
  const created=await context.request.post(endpoint+'/api/learning/course-activities',{data:{requestId:randomUUID(),releaseId:course.release.releaseId}});
  assert.equal(created.status(),200);const activity=await created.json();
  page=await context.newPage();
  page.on('console',message=>{if(message.type()==='error')console.log('BROWSER '+message.text().slice(0,500))});
  page.on('pageerror',e=>console.log('PAGE ERROR '+e.message));
  page.on('response',async r=>{if(r.status()>=400 && r.url().includes('/api/'))console.log(`HTTP ${r.status()} ${new URL(r.url()).pathname} ${(await r.text()).slice(0,300)}`)});
  await page.goto(endpoint+'?space=school&activity='+activity.activityId);
  await expect(page.locator('#activity-title')).toHaveText(course.task.title);
  if(process.env.XUNJIE_ALU_BASELINE_WEB_ROOT) {
    await page.getByRole('tab',{name:'ALU 实验',exact:true}).click();
    await page.screenshot({path:join(output,'before.png')});
    report.cases.push('HEAD formal product UI before ALU runtime integration');report.status='baseline-captured';
    await writeFile(join(output,'baseline-report.json'),JSON.stringify(report,null,2));
  } else {
  await page.getByText('打开补学资料来源',{exact:true}).click();
  await expect(page.getByRole('link',{name:/位宽、低 4 位与进位/})).toHaveAttribute('href',/7174035/);
  report.cases.push('clickable source links preserve concept and page context without changing quote text');
  await expect(page.getByRole('button',{name:'运行',exact:true})).toBeEnabled({timeout:120000});
  await expect(page.getByRole('button',{name:'alu.sv',exact:true}).or(page.getByRole('tab',{name:'alu.sv',exact:true})).first()).toBeVisible();
  report.cases.push('starter imported and actual Worker self-check enabled run');
  await page.screenshot({path:join(output,'initial.png')});
  await page.getByRole('button',{name:'运行',exact:true}).click();
  await page.getByRole('tab',{name:'ALU 实验',exact:true}).click();
  const panel=page.getByRole('region',{name:'计算记录'});
  await expect(page.getByText('输出包含 X/Z',{exact:false})).toBeVisible({timeout:60000});
  report.cases.push('starter produced real unknown HDL output');
  // Engineering implementation is typed through the real editor; never shipped as starter content.
  await page.getByRole('tab',{name:'作品',exact:true}).click();
  const correct='// 位宽和进位：中文编辑内容随作品保护\nmodule alu(input logic [3:0] A,B,input logic M,input logic [1:0] S,input logic Cin,output logic [3:0] F,output logic Cout); always_comb begin F=0; Cout=0; if(M) begin if(S==0) {Cout,F}={1\'b0,A}+{1\'b0,B}+Cin; end else case(S) 0:F=~A; 1:F=A&B; 2:F=A|B; 3:F=A^B; endcase end endmodule';
  const replace=async text=>{const editor=page.locator('.monaco-editor textarea').first();await editor.focus();await page.keyboard.press('ControlOrMeta+A');await page.keyboard.insertText(text)};
  await replace(correct);
  await expect(page.getByText('修改尚未运行',{exact:false})).toBeVisible();
  await page.getByLabel('A（4 位）').selectOption('15');await page.getByLabel('B（4 位）').selectOption('1');await page.getByLabel('M（1 位）').selectOption('1');
  await page.getByRole('button',{name:'运行',exact:true}).click();
  await page.getByRole('tab',{name:'ALU 实验',exact:true}).click();
  await expect(page.getByText('F：0000　Cout：1',{exact:false})).toBeVisible({timeout:60000});
  report.cases.push('real carry observation in formal editor and Worker');
  report.cases.push('Chinese source text entered through Monaco survives compilation and fixed execution basis');
  await page.screenshot({path:join(output,'observed.png')});
  await expect.poll(async()=>{
    const history=await context.request.get(`${endpoint}/api/learning/executions/${activity.activityId}/history`);
    if(!history.ok())return false;const value=await history.json();return value.entries.some(r=>r.query.state==='succeeded'&&r.query.output?.output?.cout==='1');
  },{timeout:30000}).toBe(true);
  const history=await (await context.request.get(`${endpoint}/api/learning/executions/${activity.activityId}/history`)).json();
  const last=history.entries.find(r=>r.query.output?.output?.cout==='1');
  assert.ok(last.action.execution.basis.works.some(file=>file.value.includes('中文编辑内容随作品保护')));
  const artifact=await (await context.request.get(`${endpoint}/api/learning/executions/${activity.activityId}/${last.query.requestId}/artifact`)).json();
  assert.ok(artifact.resources.some(r=>r.name==='trace.vcd'&&r.text.includes('$enddefinitions')));
  report.cases.push('PostgreSQL and retained resource API hold original VCD');
  await context.route('**/api/learning/**',route=>route.abort());
  await page.getByLabel('Cin（1 位）').selectOption('1');
  await page.getByRole('button',{name:'运行',exact:true}).click();
  await expect(page.getByText('F：0001　Cout：1',{exact:false})).toBeVisible({timeout:60000});
  report.cases.push('prepared browser runs real HDL while application API is unavailable');
  await context.unroute('**/api/learning/**');
  await expect.poll(async()=>{
    const response=await context.request.get(`${endpoint}/api/learning/executions/${activity.activityId}/history`);
    if(!response.ok())return false;
    const history=await response.json();return history.entries.some(entry=>entry.query.state==='succeeded'&&entry.query.output?.output?.f==='0001');
  },{timeout:30000}).toBe(true);
  report.cases.push('original result synchronizes automatically when service returns, without reload or recomputation');
  await page.reload();await page.getByRole('tab',{name:'ALU 实验',exact:true}).click();
  await expect(page.getByText('F：0000　Cout：1',{exact:false})).toBeVisible({timeout:30000});
  report.cases.push('refresh reads original observation without simulation');
  await page.getByRole('tab',{name:'作品',exact:true}).click();await replace('module alu( broken syntax');
  await page.getByRole('button',{name:'运行',exact:true}).click();await page.getByRole('tab',{name:'ALU 实验',exact:true}).click();
  await expect(page.getByText('编译未完成',{exact:false}).first()).toBeVisible({timeout:60000});
  await expect(page.getByText('F：0000　Cout：1',{exact:false})).toBeVisible();
  report.cases.push('compile failure names original source and never replaces previous observation');
  await page.screenshot({path:join(output,'compile-failure.png')});
  await page.getByRole('tab',{name:'作品',exact:true}).click();
  await replace('module alu(input logic [3:0] A,B,input logic M,input logic [1:0] S,input logic Cin,output logic [3:0] F,output logic Cout); initial begin F=0; Cout=0; forever #0 F=~F; end endmodule');
  await page.getByRole('button',{name:'运行',exact:true}).click();await page.getByRole('tab',{name:'ALU 实验',exact:true}).click();
  const stop=page.getByRole('button',{name:'停止',exact:true}).first();await expect(stop).toBeVisible();
  await stop.click();await expect(page.getByText('已取消',{exact:false}).first()).toBeVisible({timeout:30000});
  report.cases.push('actual zero-time Worker is stopped through the original execution controller');
  await page.getByRole('tab',{name:'作品',exact:true}).click();await replace(correct);
  await page.getByRole('button',{name:'运行',exact:true}).click();await page.getByRole('tab',{name:'ALU 实验',exact:true}).click();
  await expect(page.locator('.execution-records > li').first()).toContainText('F：0001　Cout：1',{timeout:60000});
  report.cases.push('a new Worker remains usable after stop');
  await page.setViewportSize({width:1024,height:768});await page.screenshot({path:join(output,'narrow.png')});
  await page.evaluate(()=>{localStorage.setItem('theme.v1','dark')});await page.reload();
  await page.getByRole('tab',{name:'ALU 实验',exact:true}).click();await page.screenshot({path:join(output,'dark.png')});
  report.cases.push('narrow desktop and dark theme render the same activity and retained results');
  await page.getByRole('tab',{name:'作品',exact:true}).click();
  const other=await context.newPage();await other.goto(endpoint+'?space=school&activity='+activity.activityId);
  await other.getByRole('tab',{name:'作品',exact:true}).click();
  await expect(other.locator('.monaco-editor textarea').first()).toBeAttached();
  await Promise.all([replace(correct+'\n// 第一标签页\n'),(async()=>{
    await other.locator('.monaco-editor textarea').first().focus();await other.keyboard.press('ControlOrMeta+A');
    await other.keyboard.insertText(correct+'\n// 第二标签页\n');
  })()]);
  await expect.poll(async()=>await page.getByText('作品存在分歧',{exact:true}).isVisible().catch(()=>false)
    ||await other.getByText('作品存在分歧',{exact:true}).isVisible().catch(()=>false),{timeout:15000}).toBe(true);
  const conflicted=await page.getByText('作品存在分歧',{exact:true}).isVisible().catch(()=>false)?page:other;
  await expect(conflicted.getByRole('button',{name:'采用本页内容',exact:true})).toBeEnabled();
  await conflicted.getByRole('button',{name:'采用本页内容',exact:true}).click();
  await expect(conflicted.getByText('作品存在分歧',{exact:true})).not.toBeVisible();
  if(conflicted===other){await page.close();page=other}else await other.close();
  report.cases.push('two real Chrome tabs preserve competing Chinese edits and require explicit resolution');
  await expect.poll(async()=>{
    const response=await context.request.get(`${endpoint}/api/learning/executions/${activity.activityId}/history`);
    if(!response.ok())return false;
    const history=await response.json();return history.entries.some(entry=>entry.query.output?.output?.f==='0001'&&entry.query.state==='succeeded');
  },{timeout:30000}).toBe(true);
  const fence=await runtime.recovery.fenceSource({sourceEnvironmentId:randomUUID(),sourceServiceId:randomUUID(),sourceInstallationId:randomUUID(),timeoutMs:30000});
  assert.equal(fence.execution.blocking,0);assert.equal(fence.execution.unresolved,0);
  report.cases.push('real maintenance validation accepts fixed v3 works, result resources and pins and resumes after a source fence');
  report.status='passed';
  }
} catch(error){report.status='failed';report.error=String(error.stack??error);if(page){report.visibleText=await page.locator('body').innerText().catch(()=>'');await page.screenshot({path:join(output,'failure.png')}).catch(()=>{});}throw error;}
finally {
  await browser?.close();await runtime.stop().catch(()=>{});
  // Keep this isolated root for inspection; deleting it requires explicit workspace authorisation.
  await writeFile(join(output,process.env.XUNJIE_ALU_BASELINE_WEB_ROOT?'baseline-report.json':'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
}

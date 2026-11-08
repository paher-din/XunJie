import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openProductRuntime, resolveCredential } from '@xunjie/product-runtime';
import { accumulatorPackage } from '../../../components/state-accumulator/package.mjs';

const postgresBin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN;
if (!postgresBin) throw new Error('Set XUNJIE_PRODUCT_POSTGRES_BIN to native PostgreSQL 18.6.');
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, child]) => [key, canonical(child)]))
    : value;
const sha256Json = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

/** A real native session against real PostgreSQL: start, input, replay, query, stop and restart recovery. */
test('historical checkpoints remain discoverable beyond recent sessions and bounded projections', { timeout: 300000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'xj-native173-'));
  const windowsSessionHelper = process.env.XUNJIE_NATIVE_SESSION_HELPER;
  const windowsSessionHelperSha256 = windowsSessionHelper
    ? createHash('sha256').update(await readFile(windowsSessionHelper)).digest('hex') : undefined;
  const runtime = openProductRuntime({ root, resources: { nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin,
    postgresVersion: '18.6', windowsSessionHelper, windowsSessionHelperSha256, webRoot: fileURLToPath(new URL('../../web/dist-runtime', import.meta.url)),
    windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) } });
  try {
    await runtime.install({ profile: 'local' });
    const started = await runtime.start(), endpoint = started.endpoint;
    const admin = { authorization: `Bearer ${await resolveCredential(root, 'control')}` };
    const api = async (route, body, headers = {}) => {
      const response = await fetch(new URL('/api/learning/' + route, endpoint), { method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, value: await response.json() };
    };
    const published = await accumulatorPackage();
    const imported = await api('manage/component-import', { requestId: randomUUID(), ...published }, admin);
    assert.equal(imported.status, 200, JSON.stringify(imported.value));
    const { manifest } = published, definition = imported.value;
    const session = manifest.session;
    const courseId = randomUUID(), taskId = randomUUID(), releaseId = randomUUID();
    const binding = { key: 'accumulator', definition, configuration: { title: '四态累加模拟' }, materialIds: [] };
    const course = { formatVersion: 1, requestId: randomUUID(), course: { courseId, name: '有状态会话验收样例' },
      task: { taskId, title: '观察四态累加', summary: '' },
      release: { helpPolicy: { version: 1, questions: 'allowed', scope: 'course' },  releaseId, objectives: ['连续输入并观察真实内部状态'], requirements: '依次输入 1、2、2，观察 1、3、1。',
        starterWorks: [], capabilities: [], components: [binding], materials: [] }, resources: [] };
    assert.equal((await api('manage/course-import', course, admin)).status, 200);
    const password = randomUUID();
    const member = await api('manage/members', { requestId: randomUUID(), loginName: 'native-student', password }, admin);
    const login = await fetch(new URL('/api/learning/login', endpoint), { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginName: 'native-student', password }) });
    assert.equal(login.status, 200);
    const headers = { cookie: login.headers.get('set-cookie').split(';')[0] };
    await api('manage/course-access', { requestId: randomUUID(), courseId, principalId: member.value.principalId, active: true }, admin);
    const created = await api('course-activities', { requestId: randomUUID(), releaseId }, headers);
    assert.equal(created.status, 200, JSON.stringify(created.value));
    const activity = created.value;
    const instanceId = `${activity.activityId}:accumulator`;
    const limits = { timeMs: session.budgets.operationTimeoutMs, memoryPages: 1, inputBytes: session.budgets.inputBytes,
      outputBytes: session.budgets.outputBytes, concurrentJobs: session.budgets.concurrentSessions,
      queuedJobs: session.budgets.queuedSessions };
    const actionOf = requestId => ({
      protocolVersion: 2, kind: 'execution', requestId,
      scope: { environmentId: activity.identity.environmentId, spaceId: activity.identity.spaceId,
        principalId: activity.identity.principalId, activityId: activity.activityId },
      receiver: { receiverId: 'native-execution', location: 'local', kind: 'execution' },
      execution: {
        instance: { instanceId, key: 'accumulator', componentId: manifest.componentId,
          componentVersion: manifest.version, definitionDigest: definition.digest, hostApiVersion: 1, stateVersion: 1 },
        operation: { operationId: session.operation.operationId, effect: 'input' },
        parameters: {},
        basis: { works: [], state: null, expected: { stateContentId: null }, resources: [] },
        limits,
        plan: { planId: 'native-session', planVersion: 1, location: 'native', kind: 'session',
          planDigest: sha256Json({ planId: 'native-session', planVersion: 1, componentId: manifest.componentId,
            componentVersion: manifest.version, operationId: session.operation.operationId }) },
        session: { adapterId: session.adapterId, adapterVersion: session.adapterVersion,
          limits: { operationTimeoutMs: session.budgets.operationTimeoutMs, idleMs: session.budgets.idleMs,
            maxMs: session.budgets.maxMs, memoryMiB: session.budgets.memoryMiB,
            concurrentSessions: session.budgets.concurrentSessions, queuedSessions: session.budgets.queuedSessions } },
        initiator: { kind: 'student', principalId: activity.identity.principalId } } });

    const path = `executions/${activity.activityId}`;
    const evidenceDirectory = process.env.XUNJIE_CHECKPOINT_HISTORY_EVIDENCE_DIR?.trim() || process.env.XUNJIE_EVIDENCE_DIR?.trim();
    const evidenceRoot = evidenceDirectory ? resolve(evidenceDirectory) : undefined;
    if (evidenceRoot) await mkdir(evidenceRoot, { recursive: true });
    const firstId=randomUUID(),first=(await api(path,{action:actionOf(firstId)},headers)).value;
    const pause=await api(`${path}/${firstId}/control`,{controlId:randomUUID(),operationId:'pause',effect:'pause',expectedSeq:0,parameters:{}},headers);
    assert.equal(pause.status,200);
    const cp=await api(`${path}/${firstId}/control`,{controlId:randomUUID(),operationId:'checkpoint',effect:'checkpoint',expectedSeq:1,parameters:{}},headers);
    assert.equal(cp.status,200);const checkpoint=cp.value.session.checkpoints[0];
    const stop=async requestId=>{const result=await api(`${path}/${requestId}/stop`,{stopId:randomUUID(),reason:'history regression'},headers);assert.equal(result.status,200);};
    await stop(firstId);
    for(let index=0;index<16;index++){
      const requestId=randomUUID(),created=await api(path,{action:actionOf(requestId)},headers);assert.equal(created.status,200,JSON.stringify(created.value));await stop(requestId);
    }
    const recent=await api(`${path}/sessions`,undefined,headers);assert.equal(recent.value.length,16);
    assert.equal(recent.value.some(item=>item.requestId===firstId),false);
    assert.equal(recent.value.flatMap(item=>item.session.checkpoints??[]).length,0);
    const firstPage=await api(`${path}/checkpoints`,undefined,headers);assert.equal(firstPage.status,200);assert.equal(firstPage.value.items[0].checkpointId,checkpoint.checkpointId);
    const {chromium,expect}=await import('@playwright/test');const browser=await chromium.launch({channel:'chrome',headless:false});
    let restored;
    try{
      const context=await browser.newContext({viewport:{width:1440,height:1000}}),raw=headers.cookie;
      await context.addCookies([{name:raw.slice(0,raw.indexOf('=')),value:raw.slice(raw.indexOf('=')+1),url:endpoint}]);
      const page=await context.newPage();await page.goto(endpoint+'?space=school&activity='+activity.activityId);
      await page.getByRole('tab',{name:'四态累加模拟',exact:true}).click();
      const panel=page.getByRole('region',{name:'本机会话',exact:true});await expect(panel.getByRole('combobox',{name:'恢复检查点'})).toBeVisible();
      await expect(panel.getByText(/尚无可靠检查点/)).toHaveCount(0);
      const frame=page.frameLocator('iframe[title="四态累加模拟"]');await expect(frame.locator('.state').first()).toHaveCSS('font-size','17px');
      await expect(frame.locator('.example')).toHaveCSS('line-height','19.5px');
      if (evidenceRoot) await page.screenshot({path:join(evidenceRoot,'history-limit-fixed.png'),fullPage:true});
      await panel.getByRole('button',{name:'从检查点建立恢复会话',exact:true}).click();
      await expect(panel).toContainText('这是从检查点建立的新恢复实例');
      restored=(await api(`${path}/sessions`,undefined,headers)).value[0];assert.equal(restored.state,'paused');
      assert.equal(restored.session.restoredFrom.checkpointId,checkpoint.checkpointId);
    }finally{await browser.close();}
    let latest=restored,firstNewCheckpoint;
    for(let index=0;index<65;index++){
      const result=await api(`${path}/${restored.requestId}/control`,{controlId:randomUUID(),operationId:'checkpoint',effect:'checkpoint',expectedSeq:latest.session.appliedSeq,parameters:{}},headers);
      assert.equal(result.status,200,JSON.stringify(result.value));latest=result.value;
      if(index===0)firstNewCheckpoint=latest.session.checkpoints[0].checkpointId;
    }
    assert.equal(latest.session.checkpoints.length,64);assert.equal(latest.session.checkpoints.some(item=>item.checkpointId===firstNewCheckpoint),false);
    const all=[];let cursor,requests=0;
    do{const response=await api(`${path}/checkpoints${cursor?'/'+cursor:''}`,undefined,headers);assert.equal(response.status,200);
      assert.ok(response.value.items.length<=64);all.push(...response.value.items);cursor=response.value.nextCursor;requests++;
    }while(cursor);
    assert.equal(all.length,66);assert.equal(new Set(all.map(item=>item.checkpointId)).size,66);assert.equal(requests,2);
    assert.ok(all.some(item=>item.checkpointId===firstNewCheckpoint));assert.ok(all.some(item=>item.checkpointId===checkpoint.checkpointId));
    assert.equal((await api(`${path}/checkpoints/not-a-cursor`,undefined,headers)).status,400);
    const password2=randomUUID(),secondLoginName='history-other-student';
    await api('manage/members',{requestId:randomUUID(),loginName:secondLoginName,password:password2},admin);
    const secondLogin=await fetch(new URL('/api/learning/login',endpoint),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({loginName:secondLoginName,password:password2})});
    const foreignHeaders={cookie:secondLogin.headers.get('set-cookie').split(';')[0]};
    assert.equal((await api(`${path}/checkpoints`,undefined,foreignHeaders)).status,404);
    await stop(restored.requestId);
    const report={date:'2026-11-04',status:'passed',recentSessions:16,oldestListed:false,oldCheckpointVisibleInFreshChrome:true,restoredThroughUI:true,
      publishedCheckpoints:66,pages:requests,perSessionProjection:64,oldestBeyondProjectionRetained:true,fontSize:'17px',codeLineHeight:'19.5px',platform:process.platform,mac:process.platform==='darwin'?'accepted on Apple Silicon arm64':'deferred by user'};
    if (evidenceRoot) await writeFile(join(evidenceRoot,'history-regression.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify(report));
  }finally{await runtime.stop().catch(()=>{});await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100}).catch(()=>{});}
});

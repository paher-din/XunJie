import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { openProductRuntime, createProductRuntimeHost, createProductLearningApplication, resolveCredential } from '@xunjie/product-runtime';
import { createFileBackend, openStorage } from '@xunjie/storage';
import { learningMigrations, spaceCourseMigrations } from '@xunjie/learning-space';
import { agentServiceMigrations } from '@xunjie/agents/transport/session-storage';

const postgresBin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN;
const resources = { nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin, postgresVersion: '18.6',
  webRoot: fileURLToPath(new URL('../../../apps/web/dist-runtime', import.meta.url)),
  windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) };
const id = () => randomUUID();

test('the formal inspection entry reads a student personal session for an authorized school manager and is read-only',
  { timeout: 180000, skip: !postgresBin && 'Requires native PostgreSQL 18.6.' }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'xj-agent-inspection-'));
    const runtime = openProductRuntime({ root, resources });
    let host, provider, requests = 0, workFile;
    try {
      provider = createServer(async (request, response) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        requests++;
        const text = (payload.messages ?? []).map(message => typeof message.content === 'string'
          ? message.content : JSON.stringify(message.content ?? '')).join('\n');
        const send = value => response.write('data: ' + JSON.stringify(value) + '\n\n');
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        if (requests === 1) {
          const args = { objectId: workFile.objectId, contentId: workFile.contentId };
          send({ id: 'inspection-read-1', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0,
            id: 'inspection-read-1', type: 'function', function: { name: 'read_work', arguments: JSON.stringify(args) } }] },
            finish_reason: null }] });
          send({ id: 'inspection-read-1', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
        } else if (requests === 2) {
          send({ id: 'inspection-cite-1', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0,
            id: 'inspection-cite-1', type: 'function', function: { name: 'cite_source',
              arguments: JSON.stringify({ claim: '固定作品支持这个判断', toolCallId: 'inspection-read-1' }) } }] },
            finish_reason: null }] });
          send({ id: 'inspection-cite-1', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
        } else {
          send({ id: 'inspection-final', choices: [{ index: 0, delta: { role: 'assistant', content: '固定作品支持这个判断。' },
            finish_reason: null }] });
          send({ id: 'inspection-final', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
          send({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } });
        }
        response.end('data: [DONE]\n\n');
      });
      await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
      await runtime.install({ profile: 'local' });
      host = await createProductRuntimeHost({ root, createApplication: createProductLearningApplication });
      const environment = JSON.parse(await readFile(join(root, 'environment.json'), 'utf8'));
      const call = async (route, body, headers = {}, expected = 200) => {
        const response = await fetch(host.endpoint + '/api/learning/' + route, {
          headers: { 'content-type': 'application/json', ...headers },
          ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
        const value = await response.json();
        assert.equal(response.status, expected, route + ': ' + JSON.stringify(value));
        return { value, cookie: response.headers.get('set-cookie')?.split(';')[0] };
      };
      const personal = { 'x-xj-space': 'personal' };
      const context = (await call('context', undefined, personal)).value;
      const student = context.identities.find(item => item.key === 'personal').identity;
      const admin = { authorization: 'Bearer ' + await resolveCredential(root, 'control') };
      const loginName = 'inspection-' + id(), password = id();
      const member = (await call('manage/members', { requestId: id(), loginName, password }, admin)).value;
      await call('manage/member-permissions', { requestId: id(), principalId: member.principalId,
        permission: 'course.manage', enabled: true }, admin);
      const login = await call('login', { loginName, password });
      const manager = { cookie: login.cookie };
      const outsiderName = 'outsider-' + id(), outsiderPassword = id();
      await call('manage/members', { requestId: id(), loginName: outsiderName, password: outsiderPassword }, admin);
      const outsiderLogin = await call('login', { loginName: outsiderName, password: outsiderPassword });
      const outsider = { cookie: outsiderLogin.cookie };

      const courseId = id(), taskId = id(), releaseId = id();
      const registration = (await call('manage/course-import', { formatVersion: 1, requestId: id(),
        course: { courseId, name: '排查课程' }, task: { taskId, title: '固定作品', summary: '' },
        release: { releaseId, objectives: ['核对上下文'], requirements: '提交作品。', materials: [], starterWorks: [],
          capabilities: [], helpPolicy: { version: 1, questions: 'allowed', scope: 'course' } }, resources: [] }, admin)).value;
      const spaceService = environment.services.find(item => item.unit === 'space-course');
      const spaceStorage = await openStorage({ binding: JSON.parse(await resolveCredential(root, 'storage-' + spaceService.serviceId)),
        migrations: spaceCourseMigrations,
        backend: createFileBackend({ id: 'space-course', root: join(root, 'learning-resources', 'space-course') }) });
      const dataService = environment.services.find(item => item.unit === 'learning-data');
      const dataStorage = await openStorage({ binding: JSON.parse(await resolveCredential(root, 'storage-' + dataService.serviceId)),
        migrations: learningMigrations,
        backend: createFileBackend({ id: 'learning-data', root: join(root, 'learning-resources', 'learning-data') }) });
      const agentService = environment.services.find(item => item.unit === 'teaching-agent');
      const agentStorage = await openStorage({ binding: JSON.parse(await resolveCredential(root, 'storage-' + agentService.serviceId)),
        migrations: agentServiceMigrations,
        backend: createFileBackend({ id: 'teaching-agent', root: join(root, 'learning-resources', 'teaching-agent') }) });
      t.after(() => Promise.all([spaceStorage.close(), dataStorage.close(), agentStorage.close()]));
      const target = (await call('access', undefined, personal)).value.target;
      const activityId = id();
      const activity = { activityId, identity: student, target: { ...dataStorage.owner, version: 1 },
        goal: '固定作品', question: '', references: [], status: 'open', createdAt: new Date().toISOString() };
      await dataStorage.request({ requestId: id(), fingerprint: 'inspection-activity' }, async tx => {
        await tx.query('INSERT INTO activities VALUES($1,$2,$3,$4,$5)', [activityId, student.environmentId,
          student.spaceId, student.principalId, JSON.stringify(activity)]);
        return null;
      });
      await spaceStorage.request({ requestId: id(), fingerprint: 'inspection-course-link' }, async tx => {
        await tx.query(`INSERT INTO course_access(course_id,space_id,principal_id,active) VALUES($1,$2,$3,true)
          ON CONFLICT(course_id,principal_id) DO UPDATE SET active=true,space_id=EXCLUDED.space_id`,
          [courseId, student.spaceId, student.principalId]);
        await tx.query(`INSERT INTO course_activity_associations(association_id,course_id,task_id,release_id,space_id,
          principal_id,identity,activity_environment_id,activity_service_id,activity_id,request_id,input_digest,state,binding)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'accepted',NULL)`,
          [id(), courseId, taskId, releaseId, student.spaceId, student.principalId, JSON.stringify(student),
            student.environmentId, dataStorage.owner.serviceId, activityId, id(), 'a'.repeat(64)]);
        return null;
      });
      const file = { objectId: id(), contentId: id(), name: 'alu.sv', kind: 'code', encoding: 'utf8',
        mediaType: 'text/plain', value: 'module alu; endmodule\n' };
      workFile = file;
      await call('workspaces/' + activityId, { requestId: id(), baseRevision: 0, files: [file] }, personal);
      const session = (await call('agent-sessions/workspace', { activityId, target },
        { ...personal, 'x-xj-agent-contract': '3' })).value;
      const modelId = id();
      await call('models/connections', { requestId: id(), connectionId: modelId, expectedVersion: 0, name: '排查模型',
        protocol: 'chat-completions', baseUrl: `http://127.0.0.1:${provider.address().port}`, path: '/chat/completions',
        modelId: 'inspection-fixture', dialect: 'standard', parameterMode: 'plain', enabled: true,
        contextWindow: 262144, maxOutputTokens: 1024, credential: { action: 'replace', value: 'synthetic-inspection-key' } }, personal);
      await call('models/selection', { requestId: id(), expectedVersion: 0,
        source: { kind: 'personal', connectionId: modelId, owner: 'self' } }, personal);
      const action = { requestId: id(), scope: { environmentId: student.environmentId, spaceId: student.spaceId,
        principalId: student.principalId, activityId },
        receiver: { receiverId: 'teaching-agent:' + session.owner.target.serviceId, location: 'local', kind: 'question' },
        draft: { token: 'inspection', question: '请阅读全文并解释这段代码', references: [], bases: [] },
        works: [file], evidence: [] };
      const receipt = (await call('agent-sessions/' + session.sessionId + '/inputs', { requestId: action.requestId,
        sessionId: session.sessionId, text: action.draft.question, context: { action } },
        { ...personal, 'x-xj-agent-contract': '3' })).value;
      let turn;
      for (let attempt = 0; attempt < 300; attempt++) {
        turn = (await call('agent-sessions/' + session.sessionId + '/runs/' + receipt.turnId, undefined,
          { ...personal, 'x-xj-agent-contract': '3' })).value;
        if (['completed', 'failed', 'stopped', 'interrupted'].includes(turn.state)) break;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.equal(turn.state, 'completed', JSON.stringify(turn));
      const counts = async () => ({
        commands: Number((await dataStorage.read('SELECT count(*) AS n FROM execution_commands')).rows[0].n),
        records: Number((await dataStorage.read('SELECT count(*) AS n FROM execution_records')).rows[0].n),
        activities: Number((await dataStorage.read('SELECT count(*) AS n FROM activities')).rows[0].n),
        turns: Number((await agentStorage.read('SELECT count(*) AS n FROM agent_turns')).rows[0].n),
        attempts: Number((await agentStorage.read('SELECT count(*) AS n FROM agent_attempts')).rows[0].n),
        toolCalls: Number((await agentStorage.read('SELECT count(*) AS n FROM agent_tool_calls')).rows[0].n),
      });
      const before = await counts(), beforeRequests = requests;
      const view = (await call('agent-inspections/' + session.sessionId + '?turnId=' + receipt.turnId, undefined,
        { ...manager, 'x-xj-agent-contract': '3' })).value;
      assert.equal(view.sessionId, session.sessionId);
      assert.equal(view.turnId, receipt.turnId);
      assert.ok(view.assembly);
      assert.ok(view.attempt);
      assert.ok(view.capacity);
      assert.ok(view.request);
      assert.equal(view.result.text, '固定作品支持这个判断。');
      assert.ok(view.tools.some(tool => tool.name === 'read_work'));
      assert.equal(view.citations.length, 1);
      assert.equal(view.citations[0].claim, '固定作品支持这个判断');
      assert.equal(requests, beforeRequests, 'inspection must not call the model');
      assert.deepEqual(await counts(), before, 'inspection must not add turns, attempts, tool calls or business records');
      // A normal student, a school member without course.manage and a logged-out manager are denied.
      await call('agent-inspections/' + session.sessionId, undefined, { ...personal, 'x-xj-agent-contract': '3' }, 403);
      await call('agent-inspections/' + session.sessionId, undefined, { ...outsider, 'x-xj-agent-contract': '3' }, 403);
      await call('logout', {}, manager);
      await call('agent-inspections/' + session.sessionId, undefined, { ...manager, 'x-xj-agent-contract': '3' }, 403);
      const again = await call('login', { loginName, password });
      const restored = (await call('agent-inspections/' + session.sessionId + '?turnId=' + receipt.turnId,
        undefined, { cookie: again.cookie, 'x-xj-agent-contract': '3' })).value;
      assert.equal(restored.attemptId, view.attemptId);
      // Withdrawing the student's current course access closes inspection even though the
      // historical Activity still names the course and the teacher still has course.manage.
      await spaceStorage.request({ requestId: id(), fingerprint: 'inspection-course-revoked' }, async tx => {
        await tx.query('UPDATE course_access SET active=false WHERE course_id=$1 AND principal_id=$2',
          [courseId, student.principalId]);
        return null;
      });
      await call('agent-inspections/' + session.sessionId + '?turnId=' + receipt.turnId, undefined,
        { cookie: again.cookie, 'x-xj-agent-contract': '3' }, 403);
      // An unrelated home session is not opened merely because the actor has course.manage.
      const home = (await call('agent-sessions', { requestId: id(), sessionId: id(), scenario: 'student-assistant' },
        { ...personal, 'x-xj-agent-contract': '3' })).value;
      await call('agent-inspections/' + home.sessionId, undefined, { cookie: again.cookie, 'x-xj-agent-contract': '3' }, 403);
    } finally {
      await host?.stop().catch(() => {});
      await runtime.stop().catch(() => {});
      provider?.closeAllConnections();
      if (provider) await new Promise(resolve => provider.close(resolve));
      await rm(root, { recursive: true, force: true });
    }
  });

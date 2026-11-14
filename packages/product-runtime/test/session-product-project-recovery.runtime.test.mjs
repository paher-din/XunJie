import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { createFileBackend, openStorage, provisionStorage, StorageError } from '@xunjie/storage';
import { operationId } from '@xunjie/storage/identity';
import { agentRuntimeMigrations } from '@xunjie/agent-runtime';
import { createModelGateway, modelMigrations } from '@xunjie/model-gateway';
import { createLearningData, learningMigrations } from '@xunjie/learning-space/learning-data';
import { createAgentSessions } from '@xunjie/learning-space/learning-data/agent-sessions';
import { createPersonalProjects } from '@xunjie/learning-space/learning-data/personal-projects';
import { createSessionMaterials } from '@xunjie/learning-space/learning-data/session-materials';
import { createProjectMaterials } from '@xunjie/learning-space/learning-data/project-materials';
import { nativeFixture } from '../../storage/test/native-fixture.mjs';

// Exercise the actual product scene assembly without emitting or cleaning shared dist.
const sourceRoots = ['agents', 'product-runtime'].map(pkg => new URL(`../../${pkg}/src/`, import.meta.url).href);
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/contracts/src/agent-dependencies.ts') && specifier.startsWith('.') && specifier.endsWith('.js'))
    return next(new URL(specifier, context.parentURL.replace('/src/', '/dist/')).href, context);
  if (sourceRoots.some(root => context.parentURL?.startsWith(root)) && specifier.startsWith('.') && specifier.endsWith('.js')) {
    const source = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
    if (existsSync(source)) return next(source.href, context);
  }
  const resolved = next(specifier, context);
  if (resolved.url.includes('/packages/agents/dist/') || resolved.url.endsWith('/packages/contracts/dist/agent-dependencies.js')) {
    const source = resolved.url.replace('/dist/', '/src/').replace(/\.js$/, '.ts');
    if (existsSync(new URL(source))) return next(source, context);
  }
  return resolved;
} });
const { createProductAgent } = await import('../src/product-agent.ts');
const { createLearningTools } = await import('../../agents/src/student-assistant/tools/learning-tools.ts');
const { authorizePersonalProjectCreation } = await import('../../agents/src/student-assistant/creation-policy.ts');
const { createAgentDependencyService, createAgentDependencyClient } = await import('../../agents/src/transport/session-dependencies.ts');

for (const faults of [
  ...['project-reply', 'before-initialize', 'initialize-reply', 'workspace-reply', 'material-copy-reply', 'materials-reply', 'native-settle-reply'].map(stage => [stage]),
  ['before-initialize', 'material-copy-reply', 'materials-reply'],
  ['rpc-material-copy-reply'],
  ['rpc-workspace-pending'],
  ['revoked-before-initialize'],
  ['rpc-revoked-material-copy-reply'],
]) {
  const failure = faults.join('+');
  const rpc = failure.startsWith('rpc-');
  const revoked = failure.includes('revoked-');
  const stages = faults.map(stage => stage.replace(/^(rpc-)?(revoked-)?/, ''));
  test(`original core run finishes one project and card after ${failure}`, { timeout: 60000 }, async t => {
    const pg = await nativeFixture(), storages = [], authority = new AsyncLocalStorage();
    let product, runtime, models, content, calls = 0, creationAllowed = true, peerAllowed = true, revokeNextDispatch = false;
    const interrupted = [];
    const nativeReplies = [];
    const rpcReplies = [];
    const permits = [];
    const upstream = createServer(async (request, response) => {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks));
      const texts = payload.messages.flatMap(message => typeof message.content === 'string' ? [message.content]
        : Array.isArray(message.content) ? message.content.filter(part => part.type === 'text').map(part => part.text) : []);
      const policy = texts.some(text => text.includes('STUDENT_INPUT_POLICY_V'));
      const source = texts.map(text => { try { return JSON.parse(text); } catch { return null; } }).find(input => input?.inputDigest);
      const first = !policy && ++calls === 1;
      nativeReplies.push(...payload.messages.filter(message => message.role === 'tool'));
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: ' + JSON.stringify({ id: 'project-owner-fixture', choices: [{ index: 0,
        delta: { role: 'assistant', content: policy ? JSON.stringify({ inputDigest: source.inputDigest, creationAuthorization: 'direct-create' }) : first ? '' : '项目和工作区已就绪。', ...(first ? { tool_calls: [{ index: 0,
          id: 'create-one-project', type: 'function', function: { name: 'create_personal_project', arguments: JSON.stringify(content) } }] } : {}) }, finish_reason: null }] }) + '\n\n');
      response.write('data: ' + JSON.stringify({ id: 'project-owner-fixture', choices: [{ index: 0, delta: {}, finish_reason: first ? 'tool_calls' : 'stop' }] }) + '\n\n');
      response.end('data: [DONE]\n\n');
    });
    t.after(async () => { try {
      await product?.close(); models?.closeWrites(); await models?.checks.drain();
      for (const storage of storages.reverse()) await storage.close();
    } finally { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); await pg.close(); } });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const environmentId = randomUUID(), identity = { environmentId, spaceId: randomUUID(), principalId: randomUUID(), kind: 'personal', name: '学生' };
    async function open(name, migrations) {
      const binding = await provisionStorage({ admin: pg.admin, owner: { environmentId, serviceId: randomUUID() }, password: randomUUID(), migrations });
      const storage = await openStorage({ binding, migrations, backend: createFileBackend({ id: name, root: join(pg.root, name) }) });
      storages.push(storage); return storage;
    }
    const agentStorage = await open('agent', agentRuntimeMigrations), learningStorage = await open('learning', learningMigrations);
    const target = { ...learningStorage.owner, version: 1 }, data = createLearningData(learningStorage, { resolveBinding: async () => target });
    const owner = { version: 1, connectionId: randomUUID(), installationId: randomUUID(),
      target: { ...agentStorage.owner, unit: 'teaching-agent', endpoint: 'https://fixture.invalid', protocolVersion: 1, capabilities: [] } };
    const directory = createAgentSessions(learningStorage, { authorize: async () => {}, openActivity: data.open,
      resolveOwner: async () => owner });
    const attachments = createSessionMaterials(learningStorage, { openScope: (actor, scope) => scope.kind === 'session'
      ? directory.read(actor, scope.sessionId) : data.open(actor, scope.activityId) });
    const projects = createPersonalProjects(learningStorage, { authorize: async () => {}, learning: data });
    async function assertAuthority() {
      const permit = authority.getStore(); assert.ok(permit, 'every new write needs a real current Core permit');
      await runtime.assertDispatch(identity, permit);
    }
    function interrupt(stage) {
      if (!stages.includes(stage) || interrupted.includes(stage)) return false;
      interrupted.push(stage); runtime.closeDispatch(); return true;
    }
    function loseReply(stage) {
      if (interrupt(stage)) throw new Error('retained owner reply interrupted');
    }
    const projectMaterials = createProjectMaterials(learningStorage, { openActivity: data.open,
      materials: { async adopt(...args) { const result = await attachments.adopt(...args); loseReply('material-copy-reply'); return result; } },
      async authorizeReference(actor, reference) {
        assert.deepEqual(reference.owner, target);
        const original = await attachments.personal.original(actor, reference.scope, reference.objectId, Number(reference.version));
        assert.equal(original.version.sha256, reference.sha256);
      }, assertDispatch: assertAuthority });
    models = await createModelGateway(await open('models', modelMigrations), { authorize: async () => {}, holder: 'device',
      authorizePermit: (actor, permit) => runtime.assertDispatch(actor, permit) });
    const settleNativePair = models.segments.settle;
    models.segments.settle = async (...args) => {
      const result = await settleNativePair(...args); loseReply('native-settle-reply'); return result;
    };
    const connectionId = randomUUID(), grantId = randomUUID();
    await models.save(identity, { requestId: randomUUID(), connectionId, expectedVersion: 0, name: 'project-recovery', protocol: 'chat-completions',
      baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, path: '/chat/completions', modelId: 'project-recovery', dialect: 'standard',
      parameterMode: 'plain', enabled: true, contextWindow: 262144, maxOutputTokens: 2048, credential: { action: 'replace', value: 'synthetic-project-key' } });
    await models.selection.createGrant(identity, identity, { requestId: randomUUID(), grantId, connectionId, owner: 'self' });
    await models.selection.save(identity, { requestId: randomUUID(), expectedVersion: 0, source: { kind: 'personal', connectionId, grantId } });
    const host = { localPersonalIdentity: identity, localLearningTarget: target,
      query: { async listLearningTasks() { throw new Error('unused'); }, async searchLearning() { throw new Error('unused'); }, async readLearning() { throw new Error('unused'); } },
      authorizeCreation: (context, content) => creationAllowed ? authorizePersonalProjectCreation(context, content) : Promise.resolve(null),
      projects: { async create(...args) { await assertAuthority(); const result = await projects.create(...args); loseReply('project-reply'); return result; }, receipt: projects.receipt },
      workspaceSessions: {
        async ensure(actor, input) {
          await assertAuthority();
          const session = await directory.create(actor, { requestId: input.requestId, sessionId: input.sessionId, scenario: 'workspace-assistant',
            workspace: { activityId: input.activityId, target: input.target }, title: input.title });
          if (interrupt('workspace-pending')) return { sessionId: session.sessionId, activityId: input.activityId, target: input.target, ready: false };
          loseReply('before-initialize');
          await runtime.initialize({ sessionId: session.sessionId, identity: session.identity, scenario: session.scenario, restartPolicy: 'automatic', createdAt: session.createdAt });
          loseReply('initialize-reply');
          const ready = await directory.markReady(actor, { requestId: operationId('ready:' + input.requestId), sessionId: session.sessionId });
          loseReply('workspace-reply');
          return { sessionId: ready.sessionId, activityId: ready.workspace.activityId, target: ready.workspace.target, ready: ready.state === 'ready' };
        },
        async receipt(actor, sessionId) {
          try { const session = await directory.read(actor, sessionId);
            return session.workspace ? { sessionId, activityId: session.workspace.activityId, target: session.workspace.target, ready: session.state === 'ready' } : null;
          } catch (error) { if (error instanceof StorageError && error.code === 'missing') return null; throw error; }
        },
      }, materials: { async adopt(...args) { await assertAuthority(); const result = await projectMaterials.adopt(...args); loseReply('materials-reply'); return result; }, receipt: projectMaterials.receipt },
    };
    const peer = { grantId: randomUUID(), sourceEnvironmentId: owner.target.environmentId, sourceServiceId: owner.target.serviceId,
      sourceInstallationId: owner.installationId, async assertAuthorized() { if (!peerAllowed) throw new StorageError('forbidden'); } };
    const service = createAgentDependencyService({ sessions: directory, learning: data, courses: {}, materials: attachments,
      authorize: async (_actor, source) => source.assertAuthorized(), tools: async () => [createLearningTools(host)],
      assertDispatch: (actor, permit) => runtime.assertDispatch(actor, permit) });
    const dependencies = createAgentDependencyClient(async call => {
      const wire = JSON.parse(JSON.stringify(call)), reply = JSON.parse(JSON.stringify(await service(wire, peer)));
      rpcReplies.push({ operation: call.operation, call: wire, reply }); return reply;
    });
    function start() {
      product = createProductAgent({ storage: agentStorage, directory, authorize: async () => {}, models,
        student: async () => host, materials: async () => attachments,
        materialSource: async () => ({ sourceId: 'local-personal', owner: target }),
        ...(rpc ? { tools: session => dependencies.forSession(session.identity, session.sessionId).tools() } : {}),
        async workspace() { throw new Error('workspace conversation is not dispatched by project initialization'); },
        withAuthority(permit, work) {
          if (revokeNextDispatch) { revokeNextDispatch = false; peerAllowed = false; }
          permits.push(permit); return authority.run(permit, work);
        } });
      runtime = product.runtime;
    }
    start();
    const home = await product.sessions.create(identity, { requestId: randomUUID(), sessionId: randomUUID(), scenario: 'student-assistant' });
    const scope = { kind: 'session', sessionId: home.sessionId }, materials = [];
    for (const [index, text] of ['固定项目依据 37 V', '第二份固定资料 19 mA'].entries()) materials.push(await attachments.personal.receive(identity, scope,
      { requestId: randomUUID(), materialId: randomUUID(), name: `project-${index}.txt`, mediaType: 'text/plain', dataBase64: Buffer.from(text).toString('base64') }));
    const { name, ...actor } = identity;
    content = { title: '电压测量', goal: '比较测量结果', stages: [{ title: '测量', goal: '验证原始资料' }], materialRefs: materials.map(material => ({
      sourceId: 'local-personal', identity: actor, owner: target, kind: 'personal-material', objectId: material.materialId,
      version: '1', sha256: material.versions[0].sha256, scope })) };
    const accepted = await runtime.accept(identity, { requestId: randomUUID(), sessionId: home.sessionId, text: '创建一个项目并采用这份资料' });
    await runtime.advance(accepted.runId);
    assert.deepEqual(interrupted, [stages[0]]);
    const retained = await projects.list(identity);
    assert.equal(retained.length, 1);
    const original = retained[0], materialRequestId = operationId(`personal-project-materials:${original.operationId}`);
    const completeReceipts = ['materials-reply', 'native-settle-reply'].includes(stages[0]);
    const partial = await runtime.snapshot(identity, home.sessionId, accepted.runId);
    assert.equal((await runtime.events(identity, home.sessionId)).filter(event => event.kind === 'tool-result').length, completeReceipts ? 1 : 0,
      'only complete owner receipts may publish a project result');
    const partialConversation = await product.local.conversation(identity, home.sessionId);
    assert.equal(partialConversation.tools.length, 1);
    assert.equal(partialConversation.workspaces.length, completeReceipts ? 1 : 0);
    assert.deepEqual((await models.segments.read(identity, partial.sessionState.segment.segmentId)).pendingTools.map(tool => tool.callId),
      stages[0] === 'native-settle-reply' ? [] : ['create-one-project']);
    assert.equal(await projectMaterials.receipt(identity, materialRequestId) !== null, completeReceipts);
    const partialCopies = await attachments.personal.list(identity, original.activityId);
    const partialDirectory = await directory.list(identity);
    assert.equal(partialCopies.length, stages[0] === 'material-copy-reply' ? 1 : completeReceipts ? 2 : 0,
      'an interrupted individual copy retains that copy without an aggregate receipt');
    await attachments.personal.update(identity, scope, materials[1].materialId, { requestId: randomUUID(), materialId: materials[1].materialId,
      expectedVersion: 1, dataBase64: Buffer.from('较新版本不可替换固定引用').toString('base64') });
    for (let restart = 0; restart < faults.length; restart++) {
      await product.close(); start();
      await runtime.recoverableRuns();
      assert.equal((await runtime.run(identity, home.sessionId, accepted.runId)).needsContinue, true);
      if (revoked) { creationAllowed = false; if (rpc) revokeNextDispatch = true; }
      await product.sessions.continueRun(identity, home.sessionId, accepted.runId, randomUUID());
      await runtime.advance(accepted.runId);
      if (revoked) {
        const denied = await runtime.run(identity, home.sessionId, accepted.runId);
        assert.equal(denied.state, 'paused');
        assert.equal((await projects.list(identity)).length, 1);
        assert.deepEqual(await directory.list(identity), partialDirectory, 'revocation prevents workspace initialization writes');
        assert.deepEqual((await attachments.personal.list(identity, original.activityId)).map(copy => copy.materialId), partialCopies.map(copy => copy.materialId),
          'revoked creation or peer access cannot finish an additional material copy');
        assert.equal(await projectMaterials.receipt(identity, materialRequestId), null);
        assert.equal((await product.local.conversation(identity, home.sessionId)).workspaces.length, 0);
        assert.deepEqual((await models.segments.read(identity, partial.sessionState.segment.segmentId)).pendingTools.map(tool => tool.callId), ['create-one-project']);
        creationAllowed = true; peerAllowed = true;
        await product.sessions.continueRun(identity, home.sessionId, accepted.runId, randomUUID());
        await runtime.advance(accepted.runId);
      }
      if ((await runtime.run(identity, home.sessionId, accepted.runId)).state === 'completed') break;
    }
    const snapshot = await runtime.snapshot(identity, home.sessionId, accepted.runId);
    assert.equal(snapshot.run.state, 'completed', JSON.stringify({ run: snapshot.run, steps: snapshot.steps.map(step => ({ kind: step.operation.kind, state: step.state })) }));
    assert.deepEqual(interrupted, stages);
    const saved = await projects.list(identity); assert.equal(saved.length, 1);
    assert.equal((await data.list(identity)).length, 1);
    const sessions = await directory.list(identity);
    assert.equal(sessions.filter(session => session.scenario === 'workspace-assistant').length, 1);
    const workspace = sessions.find(session => session.scenario === 'workspace-assistant'); assert.equal(workspace.state, 'ready');
    assert.deepEqual(saved[0], original, 'recovery preserves the complete original business receipt');
    const copied = await attachments.personal.list(identity, { kind: 'workspace', activityId: saved[0].activityId }); assert.equal(copied.length, 2);
    assert.ok(partialCopies.every(partialCopy => copied.some(copy => copy.materialId === partialCopy.materialId)), 'partial copies are reused');
    const copiedTexts = await Promise.all(copied.map(copy => attachments.personal.original(identity, saved[0].activityId, copy.materialId, 1).then(value => value.text)));
    assert.deepEqual(copiedTexts.sort(), ['固定项目依据 37 V', '第二份固定资料 19 mA'].sort());
    const results = (await runtime.events(identity, home.sessionId)).filter(event => event.kind === 'tool-result');
    assert.equal(results.length, 1, 'intermediate nextCommand outcomes never appear as tool results');
    const cards = results.filter(event => event.body.outcome?.result?.workspace);
    assert.equal(cards.length, 1); assert.equal(cards[0].body.outcome.result.workspace.projectId, saved[0].projectId);
    assert.equal(cards[0].body.commandId, original.operationId, 'the visible result belongs to the original logical tool');
    const conversation = await product.local.conversation(identity, home.sessionId);
    assert.equal(conversation.tools.length, 1, 'child operations never leave phantom prepared tools in the product projection');
    assert.equal(conversation.tools[0].operationId, original.operationId);
    assert.equal(conversation.tools[0].state, 'completed');
    assert.equal(conversation.workspaces.length, 1);
    assert.equal(conversation.workspaces[0].operationId, original.operationId);
    const effects = snapshot.sessionState.effects.filter(effect => effect.name === 'create_personal_project');
    assert.equal(effects.length, 1);
    assert.equal(effects[0].commandId, original.operationId);
    assert.equal(effects[0].state, 'completed');
    assert.equal(calls, 2);
    assert.equal(nativeReplies.length, 1, 'only the final stage closes the original native tool pair');
    assert.equal(nativeReplies[0].tool_call_id, 'create-one-project');
    assert.equal(JSON.parse(nativeReplies[0].content).workspace.projectId, saved[0].projectId);
    const toolSteps = snapshot.steps.filter(step => step.operation.kind === 'tool.call');
    assert.ok(toolSteps.every(step => step.operation.input.command.input.kind === 'delegate'));
    const firstBinding = toolSteps[0].operation.input;
    for (const step of toolSteps) {
      const fixed = step.operation.input;
      assert.equal(fixed.callId, 'create-one-project');
      assert.equal(fixed.basisStepId, firstBinding.basisStepId);
      assert.deepEqual(fixed.binding, firstBinding.binding);
      assert.deepEqual(fixed.command.input.binding, firstBinding.command.input.binding);
      assert.equal(fixed.command.input.command.commandId, fixed.commandId);
      const delegated = fixed.command.input.command;
      assert.equal((rpc ? delegated.input.prepared : delegated).input.request.operationId, original.operationId);
    }
    assert.equal(snapshot.steps.filter(step => step.operation.kind === 'model.tools.settle').length, 1);
    assert.deepEqual((await models.segments.read(identity, snapshot.sessionState.segment.segmentId)).pendingTools, []);
    if (rpc) {
      const proposals = rpcReplies.filter(frame => ['tools.dispatch', 'tools.reconcile'].includes(frame.operation) && frame.reply.nextCommand);
      assert.ok(proposals.length, 'the real strict RPC response transports the continuation');
      for (const proposal of proposals) {
        assert.equal(proposal.reply.nextCommand.input.version, 2);
        assert.deepEqual(proposal.reply.nextCommand.input.module, proposal.call.args.module);
        assert.deepEqual(proposal.reply.nextCommand.input.offer, proposal.call.args.command.input.offer);
      }
      assert.ok(proposals.some(proposal => rpcReplies.some(frame => frame.operation === 'tools.dispatch'
        && frame.call.args.command.commandId === proposal.reply.nextCommand.commandId)));
      if (stages[0] === 'workspace-pending') assert.ok(proposals.some(frame => frame.operation === 'tools.dispatch'));
      if (revoked) assert.ok(rpcReplies.some(frame => frame.reply.error === 'forbidden'), 'the actual peer authorization rejects revoked access');
    }
    assert.ok(permits.every(permit => snapshot.steps.some(step => step.stepId === permit.stepId
      && step.operation.operationId === permit.operationId)), 'each dispatch uses its actual current kernel step');
    if (!completeReceipts) assert.ok(new Set(permits.filter(permit => snapshot.steps.some(step => step.operation.kind === 'tool.call' && step.operation.operationId === permit.operationId))
      .map(permit => permit.operationId)).size > 1, 'a missing phase uses a distinct operation and a fresh permit');
  });
}

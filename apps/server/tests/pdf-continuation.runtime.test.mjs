import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import dns from 'node:dns/promises';
import { syncBuiltinESMExports } from 'node:module';
import { resolveCredential } from '@xunjie/product-runtime';
import { openStorage, createFileBackend } from '@xunjie/storage';
import { createTeachingTools, createSpaces, createCourses, spaceCourseMigrations } from '@xunjie/learning-space';
import { pdfReferenceCopy } from '@xunjie/contracts/pdf-materials';
import { actionInputSchema } from '@xunjie/contracts/action-intents';
import { fixture, until } from './support/teaching-input-control.mjs';
import { fixedPdf } from './fixtures/pdf-material.mjs';
import { modelReply } from './fixtures/pdf-runtime.mjs';

const definition = version => ({ definitionId: 'acceptance.pdf-continuation', version, purpose: '解释固定 PDF 依据',
  prompt: { platform: '只依据真实材料解释。', runtime: `指导版本 ${version}；没有页图时不得声称看过电路。` },
  capabilities: [{ sourceId: 'platform.learning', required: true }],
  contextPolicy: { version: 1, maxSystemChars: 400000, maxInputChars: 1000000 },
  outputContract: { kind: 'text', instructions: '区分文字依据和实际查看的页图。' }, budgetPolicy: { version: 1, retryLimit: 0 } });

// Control only the upstream transport. PDF upload/rendering, HTTP, owners and PostgreSQL are real.
async function continuationFixture(protocol, boundary, maxModelSteps = 2, options = {}) {
  const originalFetch = globalThis.fetch, originalLookup = dns.lookup, payloads = [], failures = [];
  let version = 1, reference, agent, c, activity, beforeBoundary, pendingOutcome;
  dns.lookup = async (hostname, options) => hostname === 'api.deepseek.com'
    ? options?.all ? [{ address: '93.184.216.34', family: 4 }] : { address: '93.184.216.34', family: 4 }
    : originalLookup(hostname, options);
  syncBuiltinESMExports();
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== 'api.deepseek.com') return originalFetch(input, init);
    try {
      const payload = JSON.parse(input instanceof Request ? await input.clone().text() : init.body);
      payloads.push(payload);
      if (payloads.length === 1) return modelReply(protocol,
        { id: 'original-pdf-read', name: 'read_reference', arguments: { referenceId: reference.referenceId } });
      const messages = protocol === 'responses' ? payload.input : payload.messages;
      if (messages.at(-1).role === 'assistant') return new Response(JSON.stringify({ error: {
        message: 'Assistant prefill is unsupported in thinking mode', type: 'invalid_request_error' } }),
      { status: 400, headers: { 'content-type': 'application/json' } });
      return modelReply(protocol, null, '固定第 2 页文字是 37 volts。');
    } catch (error) { failures.push(error); throw error; }
  };
  let f, courseStorage;
  try {
    f = await fixture(); activity = await f.activity('根据固定 PDF 第 2 页解释电路'); c = await f.controlled(activity);
    const environment = JSON.parse(await readFile(join(f.root, 'environment.json'), 'utf8'));
    const service = environment.services.find(item => item.unit === 'space-course');
    const binding = JSON.parse(await resolveCredential(f.root, 'storage-' + service.serviceId));
    courseStorage = await openStorage({ binding, migrations: spaceCourseMigrations,
      backend: createFileBackend({ id: 'space-course', root: join(f.root, 'learning-resources', 'space-course') }) });
    const courses = createCourses(courseStorage, createSpaces(courseStorage));
    const connectionId = randomUUID(), grantId = randomUUID();
    await f.api('models/connections', { requestId: randomUUID(), connectionId, expectedVersion: 0,
      name: 'PDF continuation transport', protocol,
      baseUrl: 'https://api.deepseek.com/' + (protocol === 'messages' ? 'anthropic' : 'v1'),
      path: protocol === 'messages' ? '/v1/messages' : protocol === 'responses' ? '/responses' : '/chat/completions',
      modelId: 'deepseek-flash', dialect: 'deepseek', parameterMode: 'thinking', enabled: true,
      contextWindow: 262144, maxOutputTokens: 1024, credential: { action: 'replace', value: 'synthetic-pdf-continuation' } });
    await f.api('models/grants', { requestId: randomUUID(), grantId, connectionId, owner: 'self' });
    const selection = await f.api('models/selection');
    await f.api('models/selection', { requestId: randomUUID(), expectedVersion: selection.version,
      source: { kind: 'personal', connectionId, grantId } });
    const route = `pdf/${activity.activityId}`;
    const document = await f.api(route, { requestId: randomUUID(), documentId: randomUUID(), name: 'fixed.pdf',
      dataBase64: fixedPdf().toString('base64') });
    const reading = await f.api(route + '/read', { requestId: randomUUID(), documentId: document.documentId, pages: [2], region: null });
    const copy = pdfReferenceCopy(reading);
    reference = { referenceId: randomUUID(), source: { kind: 'pdf', activityId: activity.activityId,
      documentId: document.documentId, documentSha256: document.sha256, readingId: reading.readingId },
      range: { kind: 'semantic', formatVersion: 1, typeId: 'pdf-pages', version: 1,
        target: { pages: [2], region: null, coordinates: reading.coordinates }, start: 0, end: copy.length }, copy, sourceName: document.name };
    const host = createTeachingTools({ learning: () => c.learning, courses, models: c.models });
    const tools = { ...host, async dispatch(...args) {
      const result = await host.dispatch(...args);
      if (args[1].name === 'read_reference') {
        assert.equal(result.state, 'completed');
        assert.deepEqual(result.result.visualPages, [2], 'The real PDF tool retains a verified native page image.');
        beforeBoundary = await agent.conversation(c.identity, activity.activityId);
        for (const question of options.steering ?? []) await c.send(question,
          { version: 1, mode: 'steering', basis: { source: 'explicit', preferenceVersion: 0 } }, [], agent);
        const empty = await f.api(`drafts/${activity.activityId}`);
        await f.api(`drafts/${activity.activityId}`, { requestId: randomUUID(), draftId: empty.draftId, baseRevision: empty.revision,
          question: '未发送的新草稿，不得冒充已接受的问题。', references: [], bases: [] });
        if (boundary === 'assembly-change') version = 2;
        else {
          const selected = await c.models.selection.read(c.identity);
          const switched = await agent.switchModel(c.identity, activity.activityId,
            { requestId: randomUUID(), selectionVersion: selected.version });
          assert.equal(switched.state, 'paused', 'Switching waits for the original PDF tool pair.');
        }
      }
      // The public host seam controls receipt timing, not Driver/Command records.
      pendingOutcome = options.outcomeState ? { ...result, state: options.outcomeState,
        feedback: { ...result.feedback, text: JSON.stringify({ state: options.outcomeState, source: result.result.source,
          detail: '原命令的受控宿主回执尚未核实，不能称为完成。' }) } } : result;
      return pendingOutcome;
    }, reconcile: (...args) => options.outcomeState ? Promise.resolve(pendingOutcome ?? null) : host.reconcile(...args) };
    agent = c.makeAgent({ tools, definition: async () => {
      const value = definition(version);
      if (version === 2 && options.maxInputChars) value.contextPolicy.maxInputChars = options.maxInputChars;
      return value;
    }, limits: { maxModelSteps, maxToolCommands: 1 } });
    const question = '先读取固定第2页的页图，再解释电路；保持这条已接受的问题。';
    const input = actionInputSchema.parse({ requestId: randomUUID(), scope: { environmentId: c.identity.environmentId, spaceId: c.identity.spaceId,
      principalId: c.identity.principalId, activityId: activity.activityId }, receiver: agent.receiver.identity,
      draft: { token: randomUUID(), question, references: [reference], bases: [] }, works: options.works ?? [], evidence: [] });
    if (input.works.length) await c.learning.works.sync(c.identity, activity.activityId,
      { requestId: randomUUID(), baseRevision: 0, files: input.works });
    return { f, c, agent, activity, reading, reference, input, payloads, failures, get beforeBoundary() { return beforeBoundary; },
      async send() {
        const receipt = await agent.accept(input, createHash('sha256').update(JSON.stringify(input)).digest('hex'));
        agent.resume(); return JSON.parse(receipt.detail).runId;
      },
      async close() {
        try { agent.closeDispatch(); agent.close(); await agent.drain(); await courseStorage.close(); await f.close(); }
        finally { globalThis.fetch = originalFetch; dns.lookup = originalLookup; syncBuiltinESMExports(); }
      } };
  } catch (error) {
    try { await courseStorage?.close(); await f?.close(); }
    finally { globalThis.fetch = originalFetch; dns.lookup = originalLookup; syncBuiltinESMExports(); }
    throw error;
  }
}

test('new-segment steering keeps sequence and does not replay the old adopted PDF question', { timeout: 180000 }, async () => {
  const steering = ['改为先比较电压。', '再只解释文字，暂不解释电路。'];
  const x = await continuationFixture('chat-completions', 'assembly-change', 2, { steering });
  const { c, agent, activity } = x;
  try {
    const runId = await x.send();
    await until(async () => (await agent.run(c.identity, activity.activityId, runId)).state === 'completed', 'The new direction completes.');
    const messages = x.payloads[1].messages;
    assert.equal(messages.at(-1).role, 'user');
    const text = messages.at(-1).content.filter(part => part.type === 'text').map(part => part.text).join('\n');
    assert.doesNotMatch(text, /保持这条已接受的问题/);
    for (const question of steering) assert.equal(text.split(question).length - 1, 1, 'Each pending revision is sent once.');
    assert.ok(text.indexOf(steering[0]) < text.indexOf(steering[1]), 'The original input sequence determines direction.');
    assert.equal((await agent.conversation(c.identity, activity.activityId)).inputs.filter(input => input.state === 'adopted').length, 3);
  } finally { await x.close(); }
});

for (const state of ['accepted', 'unknown']) {
  test(`a PDF continuation preserves an original ${state} host receipt without claiming completion`, { timeout: 180000 }, async () => {
    const x = await continuationFixture('chat-completions', 'assembly-change', 2,
      { outcomeState: state, steering: ['先解释当前回执，未核实的原操作不能称为完成。'] });
    const { c, agent, activity } = x;
    try {
      const runId = await x.send();
      const events = await until(async () => {
        const value = await agent.events(c.identity, activity.activityId);
        return value.filter(event => event.kind === 'context-assembled').length === 2 ? value : null;
      }, 'The original pending receipt crosses the real assembly boundary.');
      const snapshots = await Promise.all(events.filter(event => event.kind === 'context-assembled')
        .map(event => agent.snapshot(c.identity, activity.activityId, event.body.snapshotId)));
      assert.notEqual(snapshots[0].segmentId, snapshots[1].segmentId);
      await until(() => x.payloads.length === 2, 'Observe the actual second upstream request.');
      const message = x.payloads[1].messages.at(-1);
      assert.equal(message.role, 'user');
      const observation = JSON.parse(message.content.map(part => part.text ?? '').join(''));
      assert.equal(observation.source, 'caller');
      const fact = JSON.parse(observation.text);
      const conversation = await agent.conversation(c.identity, activity.activityId);
      assert.equal(conversation.runs[0].runId, runId);
      assert.equal(conversation.tools.length, 1);
      assert.equal(conversation.tools[0].outcome, state);
      assert.equal(fact.state, state);
      assert.equal(fact.commandId, conversation.tools[0].commandId);
      assert.deepEqual(JSON.parse(fact.feedback).source, x.reference.source);
      assert.doesNotMatch(fact.feedback, /"state":"completed"/);
    } finally { await x.close(); }
  });
}

test('replayed fixed PDF input over the new policy reports its question, works and references', { timeout: 180000 }, async () => {
  const work = { objectId: randomUUID(), contentId: randomUUID(), name: 'fixed-evidence.txt', kind: 'text',
    encoding: 'utf8', mediaType: 'text/plain', value: '必须保留的固定作品。' };
  const x = await continuationFixture('chat-completions', 'assembly-change', 2, { maxInputChars: 1, works: [work] });
  const { c, agent, activity } = x;
  try {
    const runId = await x.send();
    const run = await until(async () => {
      const value = await agent.run(c.identity, activity.activityId, runId); return value.state === 'paused' ? value : null;
    }, 'Replaying required fixed input must pause instead of truncating it.');
    assert.equal(run.reason, 'capacity-exceeded');
    assert.equal(x.payloads.length, 1);
    const notice = (await agent.events(c.identity, activity.activityId)).find(event => event.kind === 'capacity-paused');
    assert.deepEqual(notice.body.requiredScope, { questions: [x.input.requestId], references: [x.reference.referenceId],
      works: [work.contentId], workNames: [work.name], referenceNames: [x.reference.sourceName] });
    assert.equal((await agent.conversation(c.identity, activity.activityId)).inputs[0].state, 'adopted');
  } finally { await x.close(); }
});

for (const protocol of ['chat-completions', 'responses', 'messages']) {
  for (const boundary of ['assembly-change', 'model-switch']) {
    test(`${protocol}: ${boundary} continues the adopted PDF question as current user input`, { timeout: 180000 }, async () => {
      const x = await continuationFixture(protocol, boundary);
      const { f, c, agent, activity } = x;
      try {
        const runId = await x.send();
        const run = await until(async () => {
          const value = await agent.run(c.identity, activity.activityId, runId);
          assert.ok(!['failed', 'paused', 'stopped'].includes(value.state), JSON.stringify({ value, failures: x.failures }));
          return value.state === 'completed' ? value : null;
        }, 'The original PDF Run completes across a real segment boundary.');
        assert.equal(x.payloads.length, 2);
        const events = await agent.events(c.identity, activity.activityId);
        const snapshots = await Promise.all(events.filter(event => event.kind === 'context-assembled')
          .map(event => agent.snapshot(c.identity, activity.activityId, event.body.snapshotId)));
        assert.equal(snapshots.length, 2);
        assert.notEqual(snapshots[0].segmentId, snapshots[1].segmentId, 'This must be an actual segment change.');
        const payload = x.payloads[1], messages = protocol === 'responses' ? payload.input : payload.messages;
        assert.equal(messages.at(-1).role, 'user', 'DeepSeek thinking must not receive an assistant prefill after the PDF read.');
        assert.ok(JSON.stringify(messages.at(-1)).includes(x.input.draft.question), 'The current user turn contains the adopted fixed intent.');
        assert.ok(JSON.stringify(messages.at(-1)).includes(x.reference.referenceId));
        assert.doesNotMatch(JSON.stringify(payload), /未发送的新草稿/);
        assert.doesNotMatch(JSON.stringify(payload), /reasoning_content|读取固定页图。|original-pdf-read/,
          'A fresh segment must never borrow old native reasoning or tool-call identities.');
        assert.match(JSON.stringify(payload), /37 volts/);
        const conversation = await agent.conversation(c.identity, activity.activityId);
        assert.equal(conversation.runs.length, 1);
        assert.equal(conversation.tools.length, 1, 'The original PDF Command is not rerun at the boundary.');
        const tool = conversation.tools[0];
        assert.equal(tool.commandId, x.beforeBoundary.tools[0].commandId);
        assert.equal(tool.callId, 'original-pdf-read');
        assert.equal(tool.outcome, 'completed');
        assert.deepEqual(tool.result.source, x.reference.source);
        assert.deepEqual(await f.api(`pdf/${activity.activityId}/reads/${x.reading.readingId}`), x.reading);
        assert.equal(conversation.inputs[0].input.requestId, x.input.requestId);
        assert.deepEqual(conversation.inputs[0].input.draft.references, [x.reference]);
        assert.deepEqual(run.usage, { state: 'final', inputTokens: 80, outputTokens: 40,
          ...(protocol === 'messages' ? {} : { totalTokens: 120 }) });
        assert.equal(events.filter(event => event.kind === 'budget-reserved').length, 2);
        assert.equal(events.filter(event => event.kind === 'budget-settled').length, 2);
        const images = [];
        const visit = value => {
          if (!value || typeof value !== 'object') return;
          if (['image_url', 'input_image', 'image'].includes(value.type)) images.push(value);
          else Object.values(value).forEach(visit);
        };
        visit(payload);
        assert.equal(images.length, 1, 'A fresh segment must actually receive the original PDF page before claiming visual evidence.');
        const png = Buffer.from(protocol === 'messages' ? images[0].source.data
          : (protocol === 'responses' ? images[0].image_url : images[0].image_url.url).split(',')[1], 'base64');
        assert.equal(createHash('sha256').update(png).digest('hex'), x.reading.pages[0].image.sha256);
        assert.deepEqual(x.failures, []);
      } finally { await x.close(); }
    });
  }
}

for (const boundary of ['assembly-change', 'model-switch']) {
  test(`${boundary} cannot reset the original PDF Run model budget`, { timeout: 180000 }, async () => {
    const x = await continuationFixture('chat-completions', boundary, 1);
    const { c, agent, activity } = x;
    try {
      const runId = await x.send();
      const run = await until(async () => {
        const value = await agent.run(c.identity, activity.activityId, runId);
        return ['paused', 'failed', 'completed'].includes(value.state) ? value : null;
      }, 'The original model-step budget stops continuation.');
      assert.equal(run.state, 'paused');
      assert.equal(run.reason, 'model-step-budget-exhausted');
      assert.deepEqual(run.usage, { state: 'final', inputTokens: 40, outputTokens: 20, totalTokens: 60 });
      assert.equal(x.payloads.length, 1, 'Changing segments cannot buy another model request.');
      const conversation = await agent.conversation(c.identity, activity.activityId);
      assert.equal(conversation.tools.length, 1);
      assert.equal(conversation.tools[0].outcome, 'completed');
      assert.deepEqual(conversation.tools[0].result.source, x.reference.source);
      assert.equal((await agent.events(c.identity, activity.activityId)).filter(event => event.kind === 'budget-reserved').length, 1);
    } finally { await x.close(); }
  });
}

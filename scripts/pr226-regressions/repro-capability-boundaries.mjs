// F-CAP-4/5: real PostgreSQL material/image/segment owners and Gateway factory.
// Supplier responses are deterministic SSE over a real loopback HTTP socket; no paid model or two-machine claim.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { skillFixture } from '../../packages/learning-space/test/support/session-skills.mjs';
import { createSessionMaterials } from '../../packages/learning-space/dist/learning-data/session-materials.js';
import { createDocumentTools } from '../../packages/agents/dist/capabilities/documents/index.js';
import { imageRoute } from '../../packages/agents/dist/capabilities/documents/tools-images.js';
import { createWorkspaceTools } from '../../packages/agents/dist/workspace-assistant/tools/module.js';
import { createModelGateway, modelMigrations } from '../../packages/model-gateway/dist/index.js';
import { fixedPdf } from '../../apps/server/tests/fixtures/pdf-material.mjs';

test('F-CAP-4/5 fixed references and image authority boundaries', { timeout: 120000 }, async t => {
  const f = await skillFixture(t), identity = f.identity, sessionId = f.session.sessionId;
  const scope = { kind: 'session', sessionId };
  const materials = createSessionMaterials(f.storage, { openScope: (actor, s) => s.kind === 'session'
    ? f.sessions.read(actor, s.sessionId) : f.data.open(actor, s.activityId) });
  const context = (extra = {}) => ({ identity, sessionId, turnId: randomUUID(), stepId: randomUUID(),
    toolCallId: randomUUID(), signal: new AbortController().signal, inputIds: [],
    ask: async () => { throw Error('unused'); }, ...extra });
  const run = (tools, name, input, ctx = context()) => {
    const toolCallId = randomUUID();
    return tools.find(tool => tool.definition.name === name).execute({ toolCallId, name, input,
      executionMode: 'foreground', nativeCallId: 'boundary-call', callIndex: 0 }, { ...ctx, toolCallId });
  };
  const documents = createDocumentTools({ materials, scope, source: { sourceId: 'boundary-owner', owner: f.target } });
  const original = 'historical-only-token 37 volts', latest = 'current-only-token 42 volts';
  const materialId = randomUUID();
  const first = await materials.personal.receive(identity, scope, { requestId: randomUUID(), materialId,
    name: 'fixed.txt', mediaType: 'text/plain', dataBase64: Buffer.from(original).toString('base64') });
  await materials.personal.update(identity, scope, materialId, { requestId: randomUUID(), materialId,
    expectedVersion: 1, dataBase64: Buffer.from(latest).toString('base64') });
  const personalReferences = [{ materialId, version: 1, sha256: first.versions[0].sha256 }];

  await t.test('historical explicit search and read stay at v1 after the catalogue advances to v2', async () => {
    const fixed = await run(documents, 'search_materials', { query: 'historical-only-token', personalReferences });
    assert.equal(fixed.data.coverage.searchedSourceCount, 1);
    assert.equal(fixed.data.matches.length, 1);
    assert.equal(fixed.data.matches[0].source.version, '1');
    assert.equal(fixed.data.matches[0].reference.version, '1');
    assert.equal((await run(documents, 'search_materials', { query: 'current-only-token', personalReferences })).data.matches.length, 0);
    const read = await run(documents, 'read_personal_material', { ...personalReferences[0], start: 0, length: 6000 });
    assert.equal(read.data.text, original);
    assert.equal(read.data.reference.sha256, first.versions[0].sha256);
  });

  const doc = await materials.pdf.upload(identity, scope, { requestId: randomUUID(), documentId: randomUUID(),
    name: 'boundary.pdf', dataBase64: fixedPdf('PDF-only-token 37 volts').toString('base64') });
  let pdfRef;
  await t.test('unread, read-but-unselected and forged PDF readings never count as searched', async () => {
    const search = args => run(documents, 'search_materials', { query: 'PDF-only-token', personalReferences: [], ...args });
    const unread = await search({});
    assert.equal(unread.data.coverage.searchedSourceCount, 0);
    assert.deepEqual(unread.data.matches, []);
    const forged = await search({ pdfReferences: [{ documentId: doc.documentId, sha256: doc.sha256, readingId: randomUUID() }] });
    assert.equal(forged.data.coverage.searchedSourceCount, 0);
    assert.deepEqual(forged.data.matches, []);
    assert.ok(forged.data.sources.some(source => ['missing', 'no-access'].includes(source.state)));
    assert.ok(!forged.data.sources.some(source => source.state === 'searched'));
    const read = await run(documents, 'read_pdf', { documentId: doc.documentId, sha256: doc.sha256, pages: [2] });
    assert.equal(read.outcome, 'success');
    pdfRef = { documentId: doc.documentId, sha256: doc.sha256, readingId: read.data.reading.readingId };
    assert.equal((await search({})).data.coverage.searchedSourceCount, 0);
    const searched = await search({ pdfReferences: [pdfRef] });
    assert.equal(searched.data.coverage.searchedSourceCount, 1);
    assert.equal(searched.data.matches.length, 1);
    assert.equal(searched.data.matches[0].readMethod, 'native-pdf-text');
    assert.equal(searched.data.matches[0].source.readingId, pdfRef.readingId);
  });

  const payloads = [];
  let replyCall = null;
  const upstream = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    payloads.push(JSON.parse(Buffer.concat(chunks)));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = replyCall ? { tool_calls: [{ index: 0, id: 'boundary-native', type: 'function',
      function: { name: replyCall.name, arguments: JSON.stringify(replyCall.input) } }] } : { content: 'done' };
    response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: replyCall ? 'tool_calls' : 'stop' }] })
      + '\n\ndata: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  f.beforeClose(() => { upstream.closeAllConnections(); return new Promise(resolve => upstream.close(resolve)); });
  async function gatewayAt(name) {
    const storage = await f.open(name, modelMigrations);
    const gateway = await createModelGateway(storage, { holder: 'device', authorize: f.host.authorize, authorizePermit: async () => {} });
    f.beforeClose(async () => { gateway.closeWrites(); await gateway.checks.drain(); });
    return { gateway, storage };
  }
  const { gateway, storage } = await gatewayAt('capability-gateway');
  const otherOwner = (await gatewayAt('other-capability-gateway')).gateway;
  async function connection(imageInput) {
    const connectionId = randomUUID();
    await gateway.save(identity, { requestId: randomUUID(), connectionId, expectedVersion: 0, name: 'Boundary ' + imageInput,
      protocol: 'chat-completions', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, path: '/chat/completions',
      modelId: 'boundary-' + imageInput, dialect: 'standard', parameterMode: 'plain', imageInput, enabled: true,
      contextWindow: 262144, maxOutputTokens: 1024, credential: { action: 'replace', value: 'synthetic-boundary-key' } });
    return connectionId;
  }
  const enabled = await connection(true), disabled = await connection(false);
  let selectionVersion = 0;
  async function select(connectionId) {
    await gateway.selection.save(identity, { requestId: randomUUID(), expectedVersion: selectionVersion++, source: { kind: 'personal', connectionId, owner: 'self' } });
  }
  async function segment(id = sessionId, tools = []) {
    const segmentId = randomUUID();
    await gateway.segments.create(identity, { requestId: randomUUID(), segmentId, sessionId: id, purpose: 'learning',
      source: { selected: true, selectionVersion }, prefix: { system: 'F-CAP boundary', tools }, portable: [] });
    return segmentId;
  }
  const permit = id => ({ sessionId: id, runId: randomUUID(), stepId: randomUUID(), operationId: randomUUID(), generation: 1 });
  async function dispatch(segmentId, sequence = 0, images = []) {
    const attemptId = randomUUID();
    await gateway.checks.receive(identity, { attemptId, purpose: 'learning', segmentId, expectedSequence: sequence,
      authority: { formatVersion: 1, permit: permit(sessionId) }, input: { text: 'Inspect fixed work', images, toolResults: [] },
      limits: { maxOutputTokens: 1024, timeoutMs: 10000 } });
    await gateway.checks.dispatch(identity, attemptId);
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const fact = await gateway.checks.read(identity, attemptId);
      if (fact.physicalRequestEnded) { assert.equal(fact.state, 'completed', fact.reason); return fact; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw Error('Gateway HTTP attempt did not end');
  }
  let uploadCalls = 0, segmentReads = 0;
  // Observe calls while delegating every operation to the actual PG-backed Gateway.
  const observed = { ...gateway,
    segments: { ...gateway.segments, read: async (...args) => { segmentReads++; return gateway.segments.read(...args); } },
    images: { ...gateway.images, upload: async (...args) => { uploadCalls++; return gateway.images.upload(...args); } } };
  const pdfTools = models => createDocumentTools({ materials, scope, models, source: { sourceId: 'boundary-owner', owner: f.target } });
  const activity = await f.data.create(identity, { requestId: randomUUID(), goal: 'Image boundary', question: '', references: [] });
  const png = { objectId: randomUUID(), contentId: randomUUID(), name: 'work.png', kind: 'resource', encoding: 'base64',
    mediaType: 'image/png', value: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=' };
  const text = { objectId: randomUUID(), contentId: randomUUID(), name: 'work.txt', kind: 'text', encoding: 'utf8', mediaType: 'text/plain', value: 'text-only-boundary' };
  await f.data.works.sync(identity, activity.activityId, { requestId: randomUUID(), baseRevision: 0, files: [png, text] });
  const inputId = randomUUID();
  const action = { requestId: randomUUID(), scope: { environmentId: identity.environmentId, spaceId: identity.spaceId,
    principalId: identity.principalId, activityId: activity.activityId }, receiver: { receiverId: 'question', location: 'local', kind: 'question' },
    draft: { token: 'boundary', question: 'Read work', references: [], bases: [] }, works: [png, text], evidence: [] };
  const workspace = models => createWorkspaceTools({ workspace: async () => activity, learning: f.data, courses: {}, models },
    { identity, sessionId, turnId: randomUUID(), stepId: randomUUID(), inputIds: [inputId], sessionState: { workspaceInputs: [{ inputId, action }] } });
  const works = await workspace(observed), workArgs = file => ({ objectId: file.objectId, contentId: file.contentId });

  await t.test('selection changes after tool image production keep work and PDF images on the original HTTP segment', async () => {
    for (const kind of ['work', 'pdf']) {
      await select(enabled);
      const tools = kind === 'work' ? works : pdfTools(observed);
      const name = kind === 'work' ? 'read_work' : 'read_pdf_images', args = kind === 'work' ? workArgs(png) : pdfRef;
      const segmentId = await segment(sessionId, tools.map(tool => tool.definition));
      replyCall = { name, input: args };
      const firstCall = await dispatch(segmentId);
      assert.equal(firstCall.toolIntents[0].name, name);
      const result = await run(tools, name, firstCall.toolIntents[0].arguments, context({ segmentId }));
      assert.equal(result.outcome, 'success'); assert.ok(result.images.length > 0);
      await select(disabled);
      await gateway.segments.settle(identity, segmentId, { requestId: randomUUID(), expectedSequence: 1,
        results: [{ callId: 'boundary-native', outcome: 'success', text: result.summary, images: result.images }] });
      replyCall = null;
      await dispatch(segmentId, 1);
      assert.equal(payloads.at(-1).model, 'boundary-true');
      assert.match(JSON.stringify(payloads.at(-1).messages), /image_url/);
      assert.equal((await gateway.segments.read(identity, segmentId)).connection.connectionId, enabled);
      // Also flip selection before executing a tool from an already fixed disabled segment.
      const disabledSegment = await segment();
      await select(enabled);
      const before = uploadCalls;
      const blocked = await run(tools, name, args, context({ segmentId: disabledSegment }));
      assert.equal(blocked.outcome, 'error'); assert.equal(uploadCalls, before);
    }
  });

  await t.test('missing session fails closed before segment reads or image uploads', async () => {
    await select(enabled);
    const segmentId = await segment();
    const before = { reads: segmentReads, uploads: uploadCalls,
      images: (await storage.read('SELECT count(*) AS count FROM model_images')).rows[0].count };
    assert.deepEqual(await imageRoute({ identity, segmentId }, observed),
      { available: false, reason: 'fixed-model-session-required' });
    for (const [tools, name, args] of [[pdfTools(observed), 'read_pdf_images', pdfRef], [works, 'read_work', workArgs(png)]]) {
      const ctx = context({ segmentId });
      delete ctx.sessionId;
      const result = await run(tools, name, args, ctx);
      assert.equal(result.outcome, 'error');
      assert.equal(result.images?.length ?? 0, 0);
    }
    assert.equal(segmentReads, before.reads, 'a segment alone cannot authorize image capability');
    assert.equal(uploadCalls, before.uploads);
    assert.equal((await storage.read('SELECT count(*) AS count FROM model_images')).rows[0].count, before.images);
  });

  await t.test('image tools reject a real segment from another session before uploading', async () => {
    await select(enabled);
    const foreignSession = await f.sessions.create(identity, { requestId: randomUUID(), sessionId: randomUUID(), scenario: 'student-assistant' });
    const foreignSegment = await segment(foreignSession.sessionId);
    for (const [tools, name, args] of [[pdfTools(observed), 'read_pdf_images', pdfRef], [works, 'read_work', workArgs(png)]]) {
      const before = uploadCalls;
      await assert.rejects(() => run(tools, name, args, context({ segmentId: foreignSegment })), { code: 'forbidden' });
      assert.equal(uploadCalls, before);
    }
  });

  await t.test('image tools reject a segment in another PG owner and a different identity', async () => {
    const segmentId = await segment();
    for (const [tools, name, args] of [[pdfTools(otherOwner), 'read_pdf_images', pdfRef], [await workspace(otherOwner), 'read_work', workArgs(png)]])
      await assert.rejects(() => run(tools, name, args, context({ segmentId })), { code: 'missing' });
    const otherIdentity = { ...identity, principalId: randomUUID() };
    await assert.rejects(() => gateway.segments.read(otherIdentity, segmentId), { code: 'forbidden' });
    await assert.rejects(() => run(pdfTools(observed), 'read_pdf_images', pdfRef, context({ segmentId, identity: otherIdentity })), { code: 'forbidden' });
  });

  await t.test('text-only work reads never upload or create an image even without a segment', async () => {
    for (const segmentId of [undefined, await segment()]) {
      const before = uploadCalls, count = (await storage.read('SELECT count(*) AS count FROM model_images')).rows[0].count;
      const result = await run(works, 'read_work', workArgs(text), context({ segmentId }));
      assert.equal(result.outcome, 'success'); assert.equal(result.data.file.value, text.value);
      assert.equal(result.images?.length ?? 0, 0); assert.equal(uploadCalls, before);
      assert.equal((await storage.read('SELECT count(*) AS count FROM model_images')).rows[0].count, count);
    }
  });

  await t.test('revocation denies historical reads, searches and retained PDF images', async () => {
    const segmentId = await segment(), before = uploadCalls;
    f.deny();
    for (const [name, args] of [['read_personal_material', { ...personalReferences[0], start: 0, length: 100 }],
      ['search_materials', { query: 'historical-only-token', personalReferences }],
      ['search_materials', { query: 'PDF-only-token', personalReferences: [], pdfReferences: [pdfRef] }],
      ['read_pdf_images', pdfRef]])
      await assert.rejects(() => run(pdfTools(observed), name, args, context({ segmentId })), { code: 'forbidden' });
    assert.equal(uploadCalls, before);
  });
});

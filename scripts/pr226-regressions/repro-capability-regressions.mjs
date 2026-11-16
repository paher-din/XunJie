import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { skillFixture, packageInput } from '../../packages/learning-space/test/support/session-skills.mjs';
import { createSkillTools } from '../../packages/agents/dist/capabilities/skills/index.js';
import { createStudentAssistant } from '../../packages/agents/dist/student-assistant/index.js';
import { createWorkspaceAssistant } from '../../packages/agents/dist/workspace-assistant/index.js';
import { learningToolNames } from '../../packages/agents/dist/student-assistant/tools/learning-tools.js';
import { workspaceToolNames } from '../../packages/agents/dist/workspace-assistant/tools/module.js';
import { createStudentFacts } from '../../packages/agents/dist/capabilities/student-facts/index.js';
import { createDocumentTools } from '../../packages/agents/dist/capabilities/documents/index.js';
import { createMaterialSearch } from '../../packages/learning-space/dist/learning-data/material-search.js';
import { createWorkspaceTools } from '../../packages/agents/dist/workspace-assistant/tools/module.js';
import { projectResult } from '../../packages/agents/dist/capabilities/tool-support.js';
import { agentToolResultSchema } from '../../packages/contracts/dist/agent-runtime.js';
import { createAgentStore, createAgentRuntime, agentRuntimeMigrations } from '../../packages/agent-runtime/dist/index.js';
import { mockGateway } from './harness.mjs';

const cleanups = [];
try {
  const f = await skillFixture({ after(fn) { cleanups.push(fn); } });
  const ctx = { identity: f.identity, sessionId: f.session.sessionId, turnId: randomUUID(), stepId: randomUUID(), segmentId: randomUUID(),
    toolCallId: randomUUID(), signal: new AbortController().signal, inputIds: [], ask: async () => { throw Error('unused'); } };
  const call = (name, input) => ({ name, input, executionMode: 'foreground', toolCallId: randomUUID(), nativeCallId: 'native', callIndex: 0 });
  const runTool = (tools, name, args, context = ctx) => {
    const c = call(name, args); return tools.find(t => t.definition.name === name).execute(c, { ...context, toolCallId: c.toolCallId });
  };
  const simple = await f.skills.import(f.identity, packageInput('simple-guidance'));
  const skills = createSkillTools({ owner: f.target, skills: f.skills });
  assert.equal((await runTool(skills, 'skill_load', { skillId: simple.skillId, version: 1 })).outcome, 'success');
  const withTool = await f.skills.import(f.identity, packageInput('pdf-guidance', { files: [
    { path: 'SKILL.md', encoding: 'utf8', content: '---\nname: pdf-guidance\ndescription: PDF guidance\nallowed-tools: [read_pdf]\n---\nRead the selected PDF.' }
  ] }));
  const discovery = await runTool(skills, 'discover_skills', {});
  const blocked = discovery.data.entries.find(e => e.skillId === withTool.skillId);
  assert.equal(blocked.unavailable.reason, 'tool-unavailable');
  const after = await runTool(skills, 'skill_load', { skillId: simple.skillId, version: 1 });
  assert.equal(after.outcome, 'success'); assert.ok(after.summary.includes('simple-guidance'));
  const actualTools = ['discover_skills', 'skill_load', 'skill_read', 'read_pdf'];
  const guardedState = await f.skills.resolveSession(f.identity, f.session.sessionId, actualTools);
  const loaded = await f.skills.loadSession(f.identity, f.session.sessionId, { skillId: simple.skillId, version: 1,
    selectionDigest: guardedState.selectionDigest, packageDigest: simple.digest, runId: ctx.turnId, stepId: ctx.stepId,
    commandId: randomUUID(), moduleId: 'skills', moduleVersion: 1 }, { toolNames: actualTools });
  assert.ok(loaded.content.includes('simple-guidance'));
  console.log(JSON.stringify({ case: 'skill_companion_names_and_load_guard', before: 'simple skill_load success', afterImportPdfSkill: after,
    pdfSkill: blocked.unavailable, sameExplicitToolNamesResolveAndLoad: 'success' }));
  // Exercise the two real scene assembly paths, not only the skills owner API. Both must expose a Skill
  // declaring a genuinely assembled non-Skill tool (read_pdf) and reject it when that tool is absent.
  const actualSceneTools = [...learningToolNames, 'read_pdf', 'read_work', 'search_materials', 'student_ask'];
  const assembledSkills = createSkillTools({ owner: f.target, skills: f.skills, toolNames: async () => actualSceneTools });
  const studentScene = createStudentAssistant({ tools: async () => [], skills: assembledSkills, compaction: false });
  const studentAssembly = [...await studentScene.tools({} )];
  const workspaceScene = createWorkspaceAssistant({ tools: async () => [], skills: assembledSkills, compaction: false });
  const workspaceAssembly = [...await workspaceScene.tools({} )];
  for (const [scene, assembly] of [['student', studentAssembly], ['workspace', workspaceAssembly]]) {
    const found = await runTool(assembly, 'discover_skills', {});
    const entry = found.data.entries.find(e => e.skillId === withTool.skillId);
    assert.equal(entry?.unavailable?.reason, undefined, `${scene} scene sees read_pdf as assembled`);
    const loadedPdf = await runTool(assembly, 'skill_load', { skillId: withTool.skillId, version: 1 });
    assert.equal(loadedPdf.outcome, 'success', `${scene} scene loads an allowed-tools skill`);
    console.log(JSON.stringify({ case: 'real_scene_skill_assembly', scene, available: true, load: loadedPdf.outcome, toolNames: actualSceneTools.length }));
  }

  const activity = await f.data.create(f.identity, { requestId: randomUUID(), goal: '学习偏好测试', question: '帮助理解', references: [] });
  const ws0 = await f.sessions.create(f.identity, { requestId: randomUUID(), sessionId: randomUUID(), scenario: 'workspace-assistant',
    workspace: { activityId: activity.activityId, target: activity.target } });
  const ws = await f.sessions.markReady(f.identity, { requestId: randomUUID(), sessionId: ws0.sessionId });
  const runtimeStorage = await f.open('facts-runtime', agentRuntimeMigrations);
  const store = createAgentStore(runtimeStorage, { ownerInstanceId: 'facts-review' });
  await store.initialize({ sessionId: ws.sessionId, identity: f.identity, scenario: ws.scenario, createdAt: ws.createdAt });
  const first = await store.submitInput({ requestId: randomUUID(), sessionId: ws.sessionId, text: '请帮我学习', context: {} });
  await store.openStep(first.turnId, {});
  const pending = await store.submitInput({ requestId: randomUUID(), sessionId: ws.sessionId, text: '我喜欢先看例子再看公式', context: {} });
  const facts = createStudentFacts({ activity: f.data.open, sources: async () => [{ sourceId: 'local', identity: f.identity,
    target: f.target, learning: f.data, sessions: f.sessions, core: async () => ({
      sessionSnapshot: async (_i, id) => store.sessionSnapshot(id), events: async (_i, id, after) => store.events(id, after)
    }) }] });
  const beforeFacts = await facts.read(f.identity, activity.activityId);
  await store.stopTurn(ws.sessionId, first.turnId, randomUUID());
  await facts.read(f.identity, activity.activityId);
  const next = await store.continueSession(ws.sessionId, randomUUID());
  const afterFacts = await facts.read(f.identity, activity.activityId);
  const original = (await store.events(ws.sessionId)).find(e => e.kind === 'input-received' && e.body.inputId === pending.inputId);
  const moved = (await store.sessionSnapshot(ws.sessionId)).inputs.find(i => i.inputId === pending.inputId);
  assert.equal(moved.turnId, next.turnId); assert.ok(afterFacts.facts.length >= beforeFacts.facts.length);
  console.log(JSON.stringify({ case: 'deferred_input_keeps_student_facts_valid', factsBefore: beforeFacts.facts.length, factsAfter: afterFacts.facts.length,
    originalEventTurn: original.body.turnId, adoptedInputTurn: moved.turnId, nextTurn: next.turnId, version: moved.version }));

  const text = '课程资料中的唯一线索：needle-text';
  const materialId = randomUUID(), sha = createHash('sha256').update(text).digest('hex');
  const version = { materialId, version: 1, sha256: sha, name: 'notes.txt', mediaType: 'text/plain', byteLength: Buffer.byteLength(text) };
  const material = { materialId, activityId: activity.activityId, currentVersion: 1, versions: [version], removedAt: null };
  const personal = { list: async () => [material], original: async () => ({ material, version, text }), readRange: async () => { throw Error('unused'); } };
  const searchOwner = createMaterialSearch({ open: async () => activity, personal });
  const documents = createDocumentTools({ materials: { personal, pdf: { list: async () => [] }, search: searchOwner.search },
    scope: { kind: 'workspace', activityId: activity.activityId }, source: { sourceId: 'local-personal', owner: f.target } });
  const implicit = await runTool(documents, 'search_materials', { query: 'needle-text' });
  const explicit = await runTool(documents, 'search_materials', { query: 'needle-text', personalReferences: [{ materialId, version: 1, sha256: sha }] });
  const emptyScope = await runTool(documents, 'search_materials', { query: 'needle-text', personalReferences: [] });
  let wrongDigestError;
  await assert.rejects(() => runTool(documents, 'search_materials', { query: 'needle-text', personalReferences: [{ materialId, version: 1, sha256: 'f'.repeat(64) }] }), error => { wrongDigestError = error; return error.code === 'forbidden'; });
  assert.equal(implicit.data.matches.length, 1); assert.equal(explicit.data.matches.length, 1);
  assert.equal(emptyScope.outcome, 'success'); assert.equal(emptyScope.data.matches.length, 0, 'explicit [] remains an empty scope');
  assert.equal(emptyScope.data.scope.personalMaterialIds.length, 0, 'explicit [] does not fall back to the catalogue');
  assert.equal(wrongDigestError.code, 'forbidden', 'wrong fixed digest is rejected before search');
  const removed = { ...material, removedAt: new Date().toISOString() };
  const removedDocuments = createDocumentTools({ materials: { personal: { list: async () => [removed],
      original: async () => ({ material: removed, version, text }) }, pdf: { list: async () => [] }, search: searchOwner.search },
    scope: { kind: 'workspace', activityId: activity.activityId }, source: { sourceId: 'local-personal', owner: f.target } });
  await assert.rejects(() => runTool(removedDocuments, 'search_materials', { query: 'needle-text',
    personalReferences: [{ materialId, version: 1, sha256: sha }] }), error => error.code === 'forbidden');
  assert.ok(JSON.stringify(implicit.data.scope).includes('personal'));
  console.log(JSON.stringify({ case: 'document_default_search_includes_authorized_catalogue', catalogueCount: 1,
    implicitMatches: implicit.data.matches.length, implicitScope: implicit.data.scope,
    explicitMatches: explicit.data.matches.length, explicitEmptyMatches: emptyScope.data.matches.length,
    wrongDigest: 'forbidden' }));

  const large = { objectId: randomUUID(), contentId: randomUUID(), name: 'large.txt', kind: 'text', encoding: 'utf8', mediaType: 'text/plain', value: 'x'.repeat(9000) + 'END-OF-REAL-WORK' };
  const asciiBig = { objectId: randomUUID(), contentId: randomUUID(), name: 'ascii-100k.txt', kind: 'text', encoding: 'utf8', mediaType: 'text/plain', value: 'A'.repeat(100000) + 'ASCII-TAIL' };
  const chineseBig = { objectId: randomUUID(), contentId: randomUUID(), name: 'chinese.txt', kind: 'text', encoding: 'utf8', mediaType: 'text/plain', value: '中文内容超过八KB。'.repeat(1200) + '中文末尾' };
  const png = { objectId: randomUUID(), contentId: randomUUID(), name: 'work.png', kind: 'resource', encoding: 'base64', mediaType: 'image/png', value: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=' };
  await f.data.works.sync(f.identity, activity.activityId, { requestId: randomUUID(), baseRevision: 0, files: [large, asciiBig, chineseBig, png] });
  const action = { requestId: randomUUID(), scope: { environmentId: f.identity.environmentId, spaceId: f.identity.spaceId,
    principalId: f.identity.principalId, activityId: activity.activityId }, receiver: { receiverId: 'question', location: 'local', kind: 'question' },
    draft: { token: 'review', question: '查看这些作品', references: [], bases: [] }, works: [large, asciiBig, chineseBig, png], evidence: [] };
  let imageRouteReads = 0;
  const imageSegmentId = randomUUID();
  const models = { segments: { read: async () => { imageRouteReads++; return { sessionId: ws.sessionId, segmentId: imageSegmentId, connection: { imageInput: true, capabilities: { images: 'verified' } } }; } },
    images: { upload: async () => ({}), read: async () => ({}) } };
  const inputId = randomUUID();
  const workspace = await createWorkspaceTools({ workspace: async () => activity, learning: f.data, courses: {}, models },
    { identity: f.identity, sessionId: ws.sessionId, turnId: next.turnId, stepId: randomUUID(), inputIds: [inputId],
      sessionState: { workspaceInputs: [{ inputId, action }] } });
  const workResult = await runTool(workspace, 'read_work', { objectId: large.objectId, contentId: large.contentId }, { ...ctx, sessionId: ws.sessionId });
  assert.equal(agentToolResultSchema.safeParse(workResult).success, true);
  assert.ok(workResult.summary.length <= 8192);
  for (const [file, expected, unit] of [[asciiBig, asciiBig.value, 'ASCII'], [chineseBig, chineseBig.value, '中文']]) {
    let offset = 0, reconstructed = '';
    for (let calls = 0; calls < 40; calls++) {
      const part = await runTool(workspace, 'read_work', { objectId: file.objectId, contentId: file.contentId, offset, length: 8192 }, { ...ctx, sessionId: ws.sessionId });
      assert.equal(part.outcome, 'success'); assert.equal(agentToolResultSchema.safeParse(part).success, true);
      if (part.data.nextOffset !== null) { const feedback = JSON.parse(part.summary); assert.equal(feedback.nextOffset, part.data.nextOffset, 'model feedback keeps the continuation offset'); }
      reconstructed += part.data.file.value; if (part.data.nextOffset === null) break; offset = part.data.nextOffset;
    }
    assert.equal(reconstructed, expected, `${unit} large work is recoverable from its own immutable range`);
    assert.equal(reconstructed.at(-1), expected.at(-1), `${unit} last character is preserved`);
    console.log(JSON.stringify({ case: 'large_work_range_reconstructs_full_version', unit, bytes: Buffer.byteLength(expected), finalOffset: offset, calls: Math.ceil(expected.length / 8192) }));
  }
  const pngResult = await runTool(workspace, 'read_work', { objectId: png.objectId, contentId: png.contentId }, { ...ctx, sessionId: ws.sessionId });
  assert.equal(pngResult.outcome, 'success'); assert.ok((pngResult.images??[]).length > 0); assert.ok(imageRouteReads > 0);
  console.log(JSON.stringify({ case: 'workspace_image_resolves_fixed_segment_before_upload', outcome: pngResult.outcome, images: (pngResult.images??[]).length, modelsInjected: true, imageRouteReads }));

  const imageBytes = Buffer.from(png.value, 'base64'), imageSha = createHash('sha256').update(imageBytes).digest('hex');
  const doc = { documentId: randomUUID(), activityId: activity.activityId, sha256: 'a'.repeat(64) };
  const retained = { readingId: randomUUID(), activityId: activity.activityId, documentId: doc.documentId, documentSha256: doc.sha256,
    pages: [{ page: 1, state: 'ready', text: '', image: { dataBase64: png.value, sha256: imageSha, width: 1, height: 1, mediaType: 'image/png' } }] };
  let capabilityReads = 0, uploads = 0;
  const imageDisabledModels = { selection: { read: async () => { capabilityReads++; return { selected: true, version: 1 }; },
      snapshot: async () => { capabilityReads++; return { choice: { connection: { imageInput: false, capabilities: { images: 'unsupported' } } } }; } },
    segments: { read: async () => { capabilityReads++; return { sessionId: ctx.sessionId, connection: { imageInput: false, capabilities: { images: 'unsupported' } } }; } },
    images: { upload: async () => { uploads++; }, read: async (_identity, ref) => ({ ...ref, mediaType: 'image/png', sha256: imageSha, byteLength: imageBytes.length }) } };
  const pdfTools = createDocumentTools({ materials: { personal: { list: async () => [] }, pdf: {
      list: async () => [doc], document: async () => doc, reading: async () => retained } }, models: imageDisabledModels,
    scope: { kind: 'workspace', activityId: activity.activityId }, source: { sourceId: 'local-personal', owner: f.target } });
  const imageResult = await runTool(pdfTools, 'read_pdf_images', { documentId: doc.documentId, sha256: doc.sha256, readingId: retained.readingId });
  assert.equal(imageResult.outcome, 'error'); assert.equal(imageResult.data.limitation, 'image-capability-unverified'); assert.equal(uploads, 0); assert.ok(capabilityReads > 0);
  let enabledUploads = 0;
  const imageEnabledModels = { selection: { read: async () => ({ selected: true, version: 1 }),
      snapshot: async () => ({ choice: { connection: { imageInput: true, capabilities: { images: 'verified' } } } }) },
    segments: { read: async () => ({ sessionId: ctx.sessionId, connection: { imageInput: true, capabilities: { images: 'verified' } } }) },
    images: { upload: async () => { enabledUploads++; }, read: async (_identity, ref) => ({ ...ref, mediaType: 'image/png', sha256: imageSha, byteLength: imageBytes.length }) } };
  const pdfEnabledTools = createDocumentTools({ materials: { personal: { list: async () => [] }, pdf: {
      list: async () => [doc], document: async () => doc, reading: async () => retained } }, models: imageEnabledModels,
    scope: { kind: 'workspace', activityId: activity.activityId }, source: { sourceId: 'local-personal', owner: f.target } });
  const enabledResult = await runTool(pdfEnabledTools, 'read_pdf_images', { documentId: doc.documentId, sha256: doc.sha256, readingId: retained.readingId });
  assert.equal(enabledResult.outcome, 'success'); assert.equal(enabledResult.images.length, 1); assert.ok(enabledUploads > 0);
  console.log(JSON.stringify({ case: 'same_scene_pdf_images_follow_original_segment_capability', disabled: imageResult.outcome,
    enabled: enabledResult.outcome, enabledImages: enabledResult.images.length, enabledUploads, capabilityReads,
    disabledCase: { limit: imageResult.data.limitation, uploads } }));

  const gateway = mockGateway([{ text: '', toolIntents: [
    { callId: 'read-1', name: 'read_work', arguments: { objectId: large.objectId, contentId: large.contentId } },
    { callId: 'read-2', name: 'read_work', arguments: { objectId: asciiBig.objectId, contentId: asciiBig.contentId, offset: 0, length: 8192 } }] },
    { text: '已完成两次读取', toolIntents: [] }]);
  const runtime = createAgentRuntime(runtimeStorage, { authorize: async () => {}, gateway,
    scenario: { id: 'review', version: 1, context: async () => ({ system: 'test', facts: {}, sources: [] }), tools: async () => workspace } });
  f.beforeClose(() => runtime.close());
  const runtimeSession = { sessionId: randomUUID(), identity: f.identity, scenario: 'review', createdAt: new Date().toISOString() };
  await runtime.initialize(runtimeSession);
  const received = await runtime.submit(f.identity, { requestId: randomUUID(), sessionId: runtimeSession.sessionId, text: '读取作品', context: {} });
  await runtime.drain();
  const ended = await runtime.turn(f.identity, runtimeSession.sessionId, received.turnId);
  assert.equal(ended.state, 'completed'); assert.equal(ended.reason, '');
  const runtimeSnap = await runtime.sessionSnapshot(f.identity, runtimeSession.sessionId);
  assert.equal(runtimeSnap.toolCalls.length, 2, 'both same-Step calls are executed');
  assert.deepEqual(runtimeSnap.toolCalls.map(call => call.nativeCallId), ['read-1', 'read-2'], 'native callIds pair in order');
  assert.ok(runtimeSnap.toolCalls.every(call => call.result.kind === 'completed'), 'both large reads finish');
  console.log(JSON.stringify({ case: 'large_work_completes_real_kernel_turn', summaryChars: workResult.summary.length, schemaAccepts: true, turn: ended.state, reason: ended.reason,
    hasGenericResultReader: workspace.some(t => t.definition.name === 'read_tool_result') }));

  const projected = projectResult({ text: 'x'.repeat(9000) + 'HIDDEN-TAIL' }, 'x'.repeat(9000) + 'HIDDEN-TAIL');
  assert.equal(projected.data.text.endsWith('HIDDEN-TAIL'), true); assert.equal(projected.summary.includes('HIDDEN-TAIL'), false);
  assert.equal(projected.resultRef, undefined, 'no fake result handle is advertised');
  console.log(JSON.stringify({ case: 'project_result_keeps_full_data_without_fake_handle', resultRef: projected.resultRef,
    summaryChars: projected.summary.length, visibleTail: projected.summary.includes('HIDDEN-TAIL'), fullTailRetained: projected.data.text.endsWith('HIDDEN-TAIL'),
    original: JSON.parse(projected.summary).original }));
} finally {
  for (const cleanup of cleanups.reverse()) await cleanup();
}

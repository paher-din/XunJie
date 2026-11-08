import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { resolveCredential } from '@xunjie/product-runtime';
import { pdfReferenceCopy } from '@xunjie/contracts/pdf-materials';
import { pdfRuntime, modelReply } from './fixtures/pdf-runtime.mjs';
import { fixedPdf } from './fixtures/pdf-material.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const skillBody = 'WP08_FIXED_GUIDANCE：先核对原件与实际页图，再区分观测和未知原因。';
const attachment = 'WP08_FIXED_CHECKLIST：比较课程材料、原观测和第 2 页，不推断未读取页面。';
const materialText = 'WP08_APPROVED_MATERIAL：原观测为 37，原因尚未核实。';

function lastToolResult(payload) {
  const message = payload.messages.filter(message => message.role === 'tool').at(-1);
  assert.ok(message, 'The actual transport contains the preceding native tool result.');
  const value = JSON.parse(message.content);
  return value.result ?? value;
}

function pageImages(payload) {
  const images = [];
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (value.type === 'image_url') images.push(value.image_url.url);
    else Object.values(value).forEach(visit);
  };
  visit(payload);
  return images.map(url => {
    assert.ok(url.startsWith('data:image/png;base64,'), 'The real PNG reaches the model transport.');
    const png = Buffer.from(url.split(',')[1], 'base64');
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    return hash(png);
  });
}

function compactionRequest(payload) {
  for (const message of payload.messages ?? []) {
    const texts = typeof message.content === 'string' ? [message.content] : (message.content ?? []).map(part => part.text);
    for (const text of texts) try {
      const value = JSON.parse(text);
      if (value.kind === 'xunjie.context-compaction') return value;
    } catch { /* Ordinary conversation and guidance are not summary requests. */ }
  }
  return null;
}

async function completedRun(api, base, runId) {
  for (let n = 0; n < 375; n++) {
    const conversation = await api(base + '/conversation'), run = conversation.runs.find(run => run.runId === runId);
    assert.ok(!['failed', 'paused', 'stopped'].includes(run?.state), JSON.stringify(run));
    if (run?.state === 'completed') return conversation;
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  assert.fail('The production combined compaction Run did not complete.');
}

test('compaction retains fixed Skill, discovered course reader and original PDF Commands through long conversation and pure restart reads',
  { timeout: 240000 }, async () => {
    let api, base, skill, reference, reading, discovered, pendingSummary;
    let plan = [], currentPdfCall;
    const summaries = [], continuations = [], questions = [];
    const work = { objectId: randomUUID(), contentId: randomUUID(), name: 'retained-observation.txt',
      kind: 'text', encoding: 'utf8', mediaType: 'text/plain', value: 'WP08_RETAINED_WORK：原观测为 37，原因未知。' };
    const f = await pdfRuntime(async (payload, index, protocol) => {
      const source = compactionRequest(payload);
      if (source) {
        assert.equal(payload.tools?.length ?? 0, 0, 'The real ModelGateway summary route has no tools.');
        assert.deepEqual(pageImages(payload), [], 'Summary generation cannot borrow the fixed PDF image route.');
        assert.ok(!(payload.messages ?? []).some(message => message.role === 'system' && message.content.includes(skillBody)));
        const observation = source.messages.find(message => message.text.includes('原观测为 37') || message.text.includes('observation 37'));
        assert.ok(observation?.eventId, 'The controlled summary cites an actual source message.');
        const conversation = await api(base + '/conversation');
        const currentPdf = conversation.tools.find(tool => tool.callId === currentPdfCall && tool.outcome === 'completed');
        const summary = { version: 1, sourceDigest: source.sourceDigest, retainedDigest: source.retainedDigest,
          retainedIds: source.retained.map(item => item.id),
          facts: [{ text: 'WP08_SOURCED_SUMMARY：原观测为 37，原因仍未知。', sources: [observation.eventId] }],
          inferences: [], contradictions: [], unknowns: [], unfinished: [] };
        pendingSummary = { source, summary, index, currentPdf };
        summaries.push(pendingSummary);
        return modelReply(protocol, null, JSON.stringify(summary));
      }
      if (pendingSummary) {
        const text = JSON.stringify(payload);
        assert.ok(text.includes('WP08_SOURCED_SUMMARY'), 'The learning continuation actually consumes the sourced summary.');
        assert.ok(text.includes(skillBody), 'The original explicit Skill body returns on the learning route.');
        assert.ok(payload.tools.some(tool => tool.function.name === 'read_material'), 'Compaction keeps the discovered reader installed.');
        assert.ok(text.includes(work.value) && text.includes(reference.referenceId), 'Current fixed work and PDF reference remain independent of the summary.');
        if (pendingSummary.currentPdf)
          assert.deepEqual(pageImages(payload), [reading.pages[0].image.sha256], 'A PDF read before compaction reaches the successor learning segment as the same PNG.');
        continuations.push({ ...pendingSummary, index });
        pendingSummary = undefined;
      }
      const call = plan.shift();
      if (!call) return modelReply(protocol, null, '原观测为 37，原因尚未核实；保留原命令，不重复已完成操作。');
      if (call.name === 'load_tools') {
        discovered = lastToolResult(payload).entries;
        assert.equal(discovered.length, 1);
        assert.equal(discovered[0].executor.toolName, 'read_material');
        call.arguments = { bindingIds: [discovered[0].bindingId] };
      }
      return modelReply(protocol, call);
    });
    try {
      const session = await courseSession(f), { activity, materialId } = session;
      api = session.api; base = `agent/${activity.activityId}`;
      const imported = await api('skills/import', { requestId: randomUUID(), source: 'student:wp08-compaction', packageVersion: '1.0.0',
        files: [{ path: 'SKILL.md', encoding: 'utf8', content: '---\nname: wp08-retained-evidence\ndescription: 保留固定原观测与页图\n---\n' + skillBody },
          { path: 'references/checklist.md', encoding: 'utf8', content: attachment }] });
      skill = { skillId: imported.skillId, version: imported.version };
      const pdf = `pdf/${activity.activityId}`;
      const document = await api(pdf, { requestId: randomUUID(), documentId: randomUUID(), name: 'retained-page.pdf',
        dataBase64: fixedPdf().toString('base64') });
      reading = await api(pdf + '/read', { requestId: randomUUID(), documentId: document.documentId, pages: [2], region: null });
      const copy = pdfReferenceCopy(reading);
      reference = { referenceId: randomUUID(), source: { kind: 'pdf', activityId: activity.activityId,
        documentId: document.documentId, documentSha256: document.sha256, readingId: reading.readingId },
        range: { kind: 'semantic', formatVersion: 1, typeId: 'pdf-pages', version: 1,
          target: { pages: [2], region: null, coordinates: reading.coordinates }, start: 0, end: copy.length }, copy, sourceName: document.name };
      await api(`workspaces/${activity.activityId}`, { requestId: randomUUID(), baseRevision: 0, files: [work] });
      const receiver = (await api(base + '/capabilities')).receiver;
      const send = async question => {
        questions.push(question);
        const input = { requestId: randomUUID(), scope: { environmentId: activity.identity.environmentId,
          spaceId: activity.identity.spaceId, principalId: activity.identity.principalId, activityId: activity.activityId }, receiver,
          draft: { token: randomUUID(), question, references: [reference], bases: [], skills: [skill] }, works: [work], evidence: [] };
        await api(`intents/${activity.activityId}`, input);
        const receipt = await api(`intents/${activity.activityId}/${input.requestId}/dispatch`, {});
        assert.equal(receipt.state, 'accepted');
        return completedRun(api, base, JSON.parse(receipt.receipt.detail).runId);
      };
      plan = [
        { id: 'wp08-retain-discover', name: 'discover_tools', arguments: {
          purpose: 'read_material', source: 'platform.learning', object: materialId, cursor: null, pageSize: 1 } },
        { id: 'wp08-retain-load', name: 'load_tools' },
        { id: 'wp08-retain-material', name: 'read_material', arguments: { materialId } },
        { id: 'wp08-retain-attachment', name: 'skill_read', arguments: { ...skill, path: 'references/checklist.md' } },
      ];
      const original = await send('对照课程材料和固定 Skill 附件，保留原观测为 37、原因未知。');
      assert.deepEqual(original.tools.map(tool => tool.outcome), Array(4).fill('completed'));
      assert.equal(original.tools.find(tool => tool.name === 'read_material').result.text, materialText);
      assert.ok(JSON.stringify(f.payloads.at(-1)).includes(attachment));
      for (let n = 0; n < 10 && !continuations.some(item => item.currentPdf); n++) {
        currentPdfCall = 'wp08-history-pdf-' + n;
        plan = [{ id: currentPdfCall, name: 'read_pdf', arguments: { referenceId: reference.referenceId, pages: [2], region: null } }];
        // Each new student request explicitly asks for one fresh PDF read. No old
        // Command is replayed to manufacture history or a compaction trigger.
        await send(`WP08_HISTORY_${n}：请读取固定第 2 页，继续核对原记录。\n` + 'observation 37; cause unconfirmed. '.repeat(280));
        assert.equal(plan.length, 0);
      }
      const continuation = continuations.find(item => item.currentPdf);
      assert.ok(continuation, 'Accumulated real conversation compacts after a PDF Command in that same Run.');
      const conversation = await api(base + '/conversation'), events = await api(base + '/events');
      for (const question of questions)
        assert.ok(conversation.messages.some(message => message.role === 'student' && message.text.includes(question)), 'Original long questions remain queryable.');
      assert.ok(!conversation.messages.some(message => message.text.includes('WP08_SOURCED_SUMMARY')), 'Internal summaries are not presented as student answers.');
      for (const tool of original.tools)
        assert.deepEqual(conversation.tools.find(current => current.commandId === tool.commandId), tool, 'Old material/Skill Command records are unchanged.');
      assert.ok(conversation.tools.every(tool => tool.outcome === 'completed'));
      assert.equal(new Set(conversation.tools.map(tool => tool.commandId)).size, conversation.tools.length);
      const generated = events.filter(event => event.kind === 'context-compaction-generated');
      const adoptions = events.filter(event => event.kind === 'context-compacted');
      assert.equal(generated.length, summaries.length);
      assert.equal(adoptions.length, summaries.length);
      const results = [];
      for (const adoption of adoptions) {
        const generation = generated.find(event => event.body.compactionId === adoption.body.compactionId);
        assert.ok(generation);
        assert.equal(generation.body.resultRef, adoption.body.resultRef);
        for (const fact of generation.body.result.facts) for (const eventId of fact.sources)
          assert.ok(events.some(event => event.eventId === eventId), 'Summary fact sources refer to actual durable activity events.');
        const result = await api('models/results/' + generation.body.resultRef);
        assert.deepEqual(JSON.parse(result.text), generation.body.result);
        assert.equal(result.attemptId, generation.body.attemptId);
        results.push({ resultRef: generation.body.resultRef, result });
      }
      const adopted = adoptions.find(event => event.body.runId === continuation.currentPdf.runId);
      assert.ok(adopted, 'The same PDF Run adopts the summary before continuing.');
      assert.ok(adopted.body.source.retained.some(item => item.kind === 'effect' && item.content.commandId === continuation.currentPdf.commandId));
      assert.ok(adopted.body.source.retained.some(item => item.kind === 'reference' && item.content.referenceId === reference.referenceId));
      for (const tool of original.tools)
        assert.ok(adopted.body.source.retained.some(item => item.kind === 'effect' && item.content.commandId === tool.commandId));
      const snapshots = await Promise.all(events.filter(event => event.kind === 'context-assembled')
        .map(event => api(base + '/snapshots/' + event.body.snapshotId)));
      assert.equal(snapshots.length, f.payloads.length);
      const summarySnapshot = snapshots.find(snapshot => snapshot.attemptId === generated.find(event => event.body.runId === adopted.body.runId).body.attemptId);
      assert.ok(summarySnapshot);
      const finalSnapshot = snapshots.at(-1);
      assert.notEqual(summarySnapshot.segmentId, finalSnapshot.segmentId);
      assert.ok(finalSnapshot.resolvedAgent.tools.some(tool => tool.bindingId === discovered[0].bindingId));
      assert.ok(finalSnapshot.contextManifest.items.some(item => item.selection.access === 'fixed-skill-content'
        && item.content.skillId === skill.skillId && item.content.version === skill.version && item.content.content.includes(skillBody)));
      assert.ok(finalSnapshot.contextManifest.items.some(item => item.kind === 'history'
        && JSON.stringify(item.content).includes(adopted.body.source.sourceDigest)), 'The saved continuation identifies the actual adopted summary source.');
      const calls = f.payloads.length;
      const readings = await Promise.all(conversation.tools.filter(tool => tool.name === 'read_pdf')
        .map(async tool => ({ commandId: tool.commandId, reading: await api(pdf + '/reads/' + tool.commandId) })));
      for (const retained of readings) assert.equal(retained.reading.readingId, retained.commandId);
      await f.restart();
      assert.deepEqual(await api(base + '/conversation'), conversation);
      assert.deepEqual(await api(base + '/events'), events);
      for (const snapshot of snapshots) assert.deepEqual(await api(base + '/snapshots/' + snapshot.snapshotId), snapshot);
      for (const retained of readings) assert.deepEqual(await api(pdf + '/reads/' + retained.commandId), retained.reading);
      for (const retained of results) assert.deepEqual(await api('models/results/' + retained.resultRef), retained.result);
      assert.equal(f.payloads.length, calls, 'Reading recovered summaries, sources, snapshots and Commands causes zero new model calls.');
    } finally { await f.close(); }
  });

async function courseSession(f) {
  const admin = { authorization: 'Bearer ' + await resolveCredential(f.root, 'control') };
  const courseId = randomUUID(), releaseId = randomUUID(), materialId = randomUUID();
  const bytes = Buffer.from(materialText);
  await f.api('manage/course-import', { formatVersion: 1, requestId: randomUUID(),
    course: { courseId, name: 'WP08 组合入口' },
    task: { taskId: randomUUID(), title: '对照真实材料解释原观测', summary: '' },
    release: { releaseId, objectives: ['保留原件、页图及实际来源'], requirements: '区分观测和未知原因。',
      helpPolicy: { version: 1, questions: 'allowed', scope: 'course' }, starterWorks: [], capabilities: [],
      materials: [{ materialId, title: '开放观测说明', path: 'observations.md', mediaType: 'text/markdown',
        access: 'student', sha256: hash(bytes), byteLength: bytes.length }] },
    resources: [{ path: 'observations.md', contentBase64: bytes.toString('base64') }] }, admin);
  const loginName = 'wp08-' + randomUUID(), password = randomUUID();
  const member = await f.api('manage/members', { requestId: randomUUID(), loginName, password }, admin);
  await f.api('manage/course-access', { requestId: randomUUID(), courseId, principalId: member.principalId, active: true }, admin);
  const login = await f.request('login', { loginName, password }, { 'x-xj-space': 'school' });
  assert.equal(login.status, 200);
  const headers = { 'x-xj-space': 'school', cookie: login.headers.get('set-cookie').split(';')[0] };
  const api = (route, body) => f.api(route, body, headers);
  const activity = await api('course-activities', { requestId: randomUUID(), releaseId });
  const connectionId = randomUUID(), grantId = randomUUID();
  const connection = await api('models/connections', { requestId: randomUUID(), connectionId, expectedVersion: 0,
    name: 'WP08 combined transport', protocol: 'chat-completions', baseUrl: 'https://api.deepseek.com/v1',
    path: '/chat/completions', modelId: 'deepseek-flash', dialect: 'deepseek', parameterMode: 'thinking', enabled: true,
    contextWindow: 262144, maxOutputTokens: 1024, credential: { action: 'replace', value: 'synthetic-wp08-integration-key' } });
  assert.equal(connection.capabilities.images, 'verified');
  await api('models/grants', { requestId: randomUUID(), grantId, connectionId, owner: 'self' });
  const selection = await api('models/selection');
  await api('models/selection', { requestId: randomUUID(), expectedVersion: selection.version,
    source: { kind: 'personal', connectionId, grantId } });
  return { api, activity, materialId, releaseId };
}

// Only the external model transport is controlled by pdfRuntime. All activity,
// Skill, discovery, Command, PDF and snapshot evidence comes from product HTTP.
test('one production Run retains explicit Skill, original work and PDF across discovered course-tool loading and restart',
  { timeout: 180000 }, async () => {
    let skill, reference, reading, discovered;
    const work = { objectId: randomUUID(), contentId: randomUUID(), name: 'original-observation.txt',
      kind: 'text', encoding: 'utf8', mediaType: 'text/plain', value: 'WP08_ORIGINAL_WORK：原观测为 37，原因未知。' };
    const calls = [
      ['wp08-original-work', 'read_work'], ['wp08-original-pdf', 'read_pdf'],
      ['wp08-discover', 'discover_tools'], ['wp08-load', 'load_tools'],
      ['wp08-material', 'read_material'], ['wp08-attachment', 'skill_read'],
    ];
    let materialId;
    const f = await pdfRuntime((payload, index, protocol) => {
      assert.ok(index <= 7, 'The shortest combined Run must not retry or replay completed tools.');
      const text = JSON.stringify(payload);
      const names = payload.tools.map(tool => tool.function.name);
      if (index === 1) {
        assert.ok(names.includes('discover_tools') && names.includes('load_tools'));
        assert.ok(names.includes('skill_read') && names.includes('read_pdf'));
        assert.ok(!names.includes('read_material'), 'An unfixed course material stays hidden until explicitly discovered and loaded.');
        assert.ok(text.includes(skillBody), 'Explicit draft selection loads the original body without settings selection.');
        assert.ok(!text.includes(attachment), 'Attachment bytes are read only on demand.');
      } else if (index === 2) assert.equal(lastToolResult(payload).file.value, work.value);
      else if (index === 3) assert.deepEqual(pageImages(payload), [reading.pages[0].image.sha256]);
      else if (index === 4) {
        discovered = lastToolResult(payload).entries;
        assert.equal(discovered.length, 1);
        assert.equal(discovered[0].executor.toolName, 'read_material');
        assert.ok(!names.includes('read_material'), 'Discovery alone does not install the definition.');
      } else if (index === 5) {
        assert.ok(names.includes('read_material'), 'The next actual payload includes the loaded course reader.');
        assert.ok(text.includes(skillBody) && text.includes(work.value));
        assert.ok(text.includes(reference.referenceId));
        assert.deepEqual(pageImages(payload), [reading.pages[0].image.sha256], 'The new segment restores the actual original PDF image.');
        assert.ok(!text.includes('wp08-original-pdf'), 'A new segment carries durable Command facts without borrowing native call IDs.');
      } else if (index === 6) assert.equal(lastToolResult(payload).text, materialText);
      else {
        assert.ok(text.includes(attachment));
        assert.ok(names.includes('read_material'), 'Loading the attachment retains the discovered tool.');
        return modelReply(protocol, null, '原观测为 37；已对照固定原件、课程材料、Skill 附件和第 2 页图，原因仍未知。');
      }
      const args = index === 1 ? { objectId: work.objectId, contentId: work.contentId }
        : index === 2 ? { referenceId: reference.referenceId, pages: [2], region: null }
        : index === 3 ? { purpose: 'read_material', source: 'platform.learning', object: materialId, cursor: null, pageSize: 1 }
        : index === 4 ? { bindingIds: [discovered[0].bindingId] }
        : index === 5 ? { materialId }
        : { ...skill, path: 'references/checklist.md' };
      return modelReply(protocol, { id: calls[index - 1][0], name: calls[index - 1][1], arguments: args });
    });
    try {
      const session = await courseSession(f), { api, activity, releaseId } = session;
      materialId = session.materialId;
      const base = `agent/${activity.activityId}`, pdf = `pdf/${activity.activityId}`;
      const imported = await api('skills/import', { requestId: randomUUID(), source: 'student:wp08-integration', packageVersion: '1.0.0',
        files: [{ path: 'SKILL.md', encoding: 'utf8', content: '---\nname: wp08-evidence\ndescription: 核对固定原观测与页图\n---\n' + skillBody },
          { path: 'references/checklist.md', encoding: 'utf8', content: attachment }] });
      skill = { skillId: imported.skillId, version: imported.version };
      assert.deepEqual((await api('skills')).selections, [], 'Only the explicit question selects this Skill.');
      const document = await api(pdf, { requestId: randomUUID(), documentId: randomUUID(), name: 'separate-fixed-page.pdf',
        dataBase64: fixedPdf().toString('base64') });
      reading = await api(pdf + '/read', { requestId: randomUUID(), documentId: document.documentId, pages: [2], region: null });
      const copy = pdfReferenceCopy(reading);
      reference = { referenceId: randomUUID(), source: { kind: 'pdf', activityId: activity.activityId,
        documentId: document.documentId, documentSha256: document.sha256, readingId: reading.readingId },
        range: { kind: 'semantic', formatVersion: 1, typeId: 'pdf-pages', version: 1,
          target: { pages: [2], region: null, coordinates: reading.coordinates }, start: 0, end: copy.length },
        copy, sourceName: document.name };
      await api(`workspaces/${activity.activityId}`, { requestId: randomUUID(), baseRevision: 0, files: [work] });
      const receiver = (await api(base + '/capabilities')).receiver;
      const input = { requestId: randomUUID(), scope: { environmentId: activity.identity.environmentId,
        spaceId: activity.identity.spaceId, principalId: activity.identity.principalId, activityId: activity.activityId }, receiver,
        draft: { token: randomUUID(), question: 'WP08_CURRENT_QUESTION：对照原件、固定 PDF 第 2 页与发现后的课程材料，按显式 Skill 解释。',
          references: [reference], bases: [], skills: [skill] }, works: [work], evidence: [] };
      await api(`intents/${activity.activityId}`, input);
      const receipt = await api(`intents/${activity.activityId}/${input.requestId}/dispatch`, {});
      assert.equal(receipt.state, 'accepted');
      const { runId } = JSON.parse(receipt.receipt.detail);
      let conversation;
      for (let n = 0; n < 375; n++) {
        conversation = await api(base + '/conversation');
        const run = conversation.runs.find(run => run.runId === runId);
        assert.ok(!['failed', 'paused', 'stopped'].includes(run?.state), JSON.stringify({ run, calls: f.payloads.length }));
        if (run?.state === 'completed') break;
        await new Promise(resolve => setTimeout(resolve, 80));
      }
      assert.equal(conversation.runs.find(run => run.runId === runId)?.state, 'completed');
      assert.equal(f.payloads.length, 7);
      assert.equal(conversation.runs.length, 1);
      assert.deepEqual(conversation.tools.map(tool => [tool.callId, tool.name]), calls);
      assert.ok(conversation.tools.every(tool => tool.runId === runId && tool.outcome === 'completed'));
      assert.deepEqual(conversation.inputs[0].input, input, 'The original accepted input survives the segment transition unchanged.');
      const pdfCommand = conversation.tools.find(tool => tool.name === 'read_pdf');
      assert.equal(pdfCommand.result.source.readingId, pdfCommand.commandId, 'The PDF owner uses the original durable Command identity.');
      assert.equal(pdfCommand.result.source.documentSha256, document.sha256);
      const commandReading = await api(pdf + '/reads/' + pdfCommand.commandId);
      assert.deepEqual(commandReading.requestedPages, [2]);
      const material = conversation.tools.find(tool => tool.name === 'read_material');
      assert.equal(material.result.source.materialId, materialId);
      assert.equal(material.result.source.releaseId, releaseId);
      assert.equal(material.result.source.materialSha256, hash(Buffer.from(materialText)));
      assert.equal(material.result.text, materialText);
      const events = await api(base + '/events');
      const snapshots = await Promise.all(events.filter(event => event.kind === 'context-assembled')
        .map(event => api(base + '/snapshots/' + event.body.snapshotId)));
      assert.equal(snapshots.length, f.payloads.length);
      assert.notEqual(snapshots[3].segmentId, snapshots[4].segmentId, 'Paired loading creates a real production segment.');
      assert.ok(!snapshots[0].resolvedAgent.tools.some(tool => tool.executor.toolName === 'read_material'));
      assert.ok(snapshots[4].resolvedAgent.tools.some(tool => tool.bindingId === discovered[0].bindingId));
      for (const path of ['SKILL.md', 'references/checklist.md'])
        assert.ok(snapshots.at(-1).contextManifest.items.some(item => item.selection.access === 'fixed-skill-content'
          && item.content.skillId === skill.skillId && item.content.version === skill.version && item.content.path === path));
      assert.ok(conversation.messages.some(message => message.skillSource?.path === 'references/checklist.md'
        && message.skillSource.content === attachment));
      for (const tool of conversation.tools.slice(0, 4))
        assert.ok(JSON.stringify(f.payloads[4]).includes(tool.commandId), 'The new segment preserves each original completed operation identity.');
      const originalWork = await api(`workspaces/${activity.activityId}/contents/${work.contentId}`);
      assert.equal(originalWork.value, work.value);
      const intent = await api(`intents/${activity.activityId}/${input.requestId}`);
      await f.restart();
      assert.deepEqual(await api(base + '/conversation'), conversation);
      assert.deepEqual(await api(base + '/events'), events, 'Pure history reads add no Command or event.');
      for (const snapshot of snapshots) assert.deepEqual(await api(base + '/snapshots/' + snapshot.snapshotId), snapshot);
      assert.deepEqual(await api(pdf + '/reads/' + pdfCommand.commandId), commandReading);
      assert.deepEqual(await api(pdf + '/reads/' + reading.readingId), reading);
      assert.deepEqual(await api(`workspaces/${activity.activityId}/contents/${work.contentId}`), originalWork);
      assert.deepEqual(await api(`intents/${activity.activityId}/${input.requestId}`), intent);
      assert.equal(f.payloads.length, 7, 'Restart and pure reads never issue another model call.');
    } finally { await f.close(); }
  });

test('Skill result original tail is byte-exact and retains source permission after escaped attachment reading',
  { timeout: 180000 }, async () => {
    const content = '\u0001"\\\n'.repeat(900) + 'END_SKILL_ORIGINAL_WP08';
    const path = 'references/escaped.txt';
    let skill, original, offset, observedRange;
    const f = await pdfRuntime(async (payload, index, protocol) => {
      if (index === 1) return modelReply(protocol, { id: 'wp08-escaped-skill', name: 'skill_read',
        arguments: { ...skill, path, offset: 0, length: 6000 } });
      const pair = payload.messages.filter(message => message.role === 'tool').at(-1);
      assert.ok(pair);
      assert.ok(Buffer.byteLength(pair.content) <= 8192, 'Escaping does not overflow the real native feedback envelope.');
      const feedback = JSON.parse(pair.content);
      if (index === 2) {
        assert.equal(feedback.truncated, true);
        original = feedback.original;
        assert.equal(original.readTool, 'read_tool_result');
        assert.equal(original.encoding, 'utf8');
        assert.ok(original.byteLength > 8192, 'The fixed Skill result needs bounded continuation.');
        assert.ok(!pair.content.includes('END_SKILL_ORIGINAL_WP08'), 'The original tail is outside the feedback preview.');
        offset = original.byteLength - 2048;
        return modelReply(protocol, { id: 'wp08-skill-original-tail', name: 'read_tool_result',
          arguments: { commandId: original.commandId, sha256: original.sha256, offset, limit: 2048 } });
      }
      if (index === 3) {
        observedRange = feedback.result ?? feedback;
        // A failed range still finishes the real model loop, so the public
        // Command assertion below reports the production reason directly.
        if (typeof observedRange.base64 !== 'string') return modelReply(protocol, null, '原件尾部读取失败，不能声称已读到。');
        await f.api('skills/disable', { requestId: randomUUID(), skillId: skill.skillId, disabled: true });
        return modelReply(protocol, { id: 'wp08-skill-tail-after-disable', name: 'read_tool_result',
          arguments: { commandId: original.commandId, sha256: original.sha256, offset, limit: 2048 } });
      }
      assert.equal(index, 4, 'The original Skill read is never replayed.');
      return modelReply(protocol, null, '仅依据获准时实际读取的原件字节；停用后不再续读。');
    });
    try {
      const imported = await f.api('skills/import', { requestId: randomUUID(), source: 'student:wp08-escaped-original', packageVersion: '1.0.0',
        files: [{ path: 'SKILL.md', encoding: 'utf8', content: '---\nname: wp08-escaped-original\ndescription: 核对固定附件原件字节\n---\n只解释实际读取的固定内容。' },
          { path, encoding: 'utf8', content }] });
      skill = { skillId: imported.skillId, version: imported.version };
      const input = { ...f.input, draft: { ...f.input.draft, question: '读取已固定的转义附件，再读取实际原件尾部，保持原权限。',
        references: [], skills: [skill] } };
      const runId = await f.send(input), conversation = await f.completed(runId);
      const source = conversation.tools.find(tool => tool.callId === 'wp08-escaped-skill');
      const tail = conversation.tools.find(tool => tool.callId === 'wp08-skill-original-tail');
      assert.ok(source && tail, 'Both reads must be real budgeted Commands.');
      assert.equal(source.outcome, 'completed');
      assert.equal(source.commandId, original.commandId);
      assert.equal(source.result.loaded.content, content);
      assert.equal(source.result.loaded.digest, hash(Buffer.from(content)));
      assert.equal(source.result.loaded.complete, true);
      assert.equal(source.result.loaded.skillId, skill.skillId);
      assert.equal(source.result.loaded.version, skill.version);
      assert.equal(source.result.loaded.path, path);
      assert.equal(tail.runId, source.runId);
      assert.equal(tail.outcome, 'completed', 'A permitted Skill original tail must be readable: ' + JSON.stringify(tail.result));
      // The public full original independently supplies the expected canonical
      // JSON bytes. No owner resource, private serializer or table is consulted.
      const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
      const bytes = Buffer.from(JSON.stringify(sorted(source.result)));
      assert.equal(original.byteLength, bytes.length);
      assert.equal(original.sha256, hash(bytes));
      assert.deepEqual(tail.result, observedRange);
      assert.equal(tail.result.source.commandId, source.commandId);
      assert.equal(tail.result.sha256, original.sha256);
      assert.equal(tail.result.version, original.sha256);
      assert.equal(tail.result.outcomeState, 'completed');
      assert.equal(tail.result.byteLength, bytes.length);
      assert.deepEqual(tail.result.byteRange, { offset, end: bytes.length });
      assert.equal(tail.result.nextOffset, null);
      assert.deepEqual(Buffer.from(tail.result.base64, 'base64'), bytes.subarray(offset));
      assert.ok(Buffer.from(tail.result.base64, 'base64').includes(Buffer.from('END_SKILL_ORIGINAL_WP08')));
      const denied = conversation.tools.find(tool => tool.callId === 'wp08-skill-tail-after-disable');
      assert.ok(denied, 'Disabling the original Skill tests current permission in that same Run.');
      assert.equal(denied.runId, runId);
      assert.equal(denied.outcome, 'failed');
      assert.equal(denied.result.reason, 'forbidden');
      assert.equal(denied.result.base64, undefined);
      assert.equal(conversation.tools.filter(tool => tool.name === 'skill_read').length, 1);
      assert.equal(f.payloads.length, 4);
      const events = await f.api(`agent/${f.activity.activityId}/events`);
      await f.restart();
      assert.deepEqual(await f.api(`agent/${f.activity.activityId}/conversation`), conversation, 'The fixed Skill original and Commands remain unchanged after disable and restart.');
      assert.deepEqual(await f.api(`agent/${f.activity.activityId}/events`), events);
      assert.equal(f.payloads.length, 4, 'Pure reads never regenerate the Skill original or model calls.');
    } finally { await f.close(); }
  });

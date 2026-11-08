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

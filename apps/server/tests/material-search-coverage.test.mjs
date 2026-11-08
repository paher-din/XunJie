import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { createMaterialSearch } from '../../../packages/learning-space/dist/learning-data/material-search.js';
import { pdfReferenceCopy } from '../../../packages/contracts/dist/pdf-materials.js';

const digest = value => createHash('sha256').update(value).digest('hex');
const identity = { environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(), kind: 'personal', name: '检索学生' };
const activity = () => ({ activityId: randomUUID(), identity, target: { environmentId: identity.environmentId, serviceId: randomUUID(), version: 1 },
  goal: '检索', question: '', references: [], status: 'open', createdAt: new Date().toISOString() });

function pdfFixture() {
  const activityValue = activity(), documentId = randomUUID(), readingId = randomUUID();
  const original = Buffer.from('%PDF-1.7 synthetic original');
  const page = (pageNumber, text) => ({ page: pageNumber, label: String(pageNumber), state: 'ready', text, textOrigin: 'native',
    ocr: 'not-performed', image: { mediaType: 'image/png', dataBase64: 'iVBORw0KGgo=', width: 10, height: 10,
      sha256: digest('png') }, transform: { rotation: 0, cropBox: [], region: null, scale: 1, engine: 'synthetic' } });
  const reading = { readingId, documentId, activityId: activityValue.activityId, documentSha256: digest(original),
    documentName: '电路.pdf', coordinates: 'rotated-cropbox-top-left-normalized', requestedPages: [1, 2], region: null,
    pages: [page(1, '第一页含串联关键词'), { ...page(2, '第二页内容不可读'), state: 'failed' }] };
  const reference = { referenceId: randomUUID(), source: { kind: 'pdf', activityId: activityValue.activityId, documentId,
    documentSha256: reading.documentSha256, readingId }, range: { kind: 'semantic', formatVersion: 1, typeId: 'pdf-pages',
    version: 1, target: { pages: [1, 2], region: null, coordinates: 'rotated-cropbox-top-left-normalized' },
    start: 0, end: pdfReferenceCopy({ ...reading, pages: [page(1, '第一页没有关键词'), page(2, '第二页串联电路')] }).length },
    copy: pdfReferenceCopy({ ...reading, pages: [page(1, '第一页含串联关键词'), page(2, '第二页内容不可读')] }), sourceName: '电路.pdf' };
  const storage = {
    async read(sql) {
      assert.match(sql, /FROM pdf_readings/);
      return { rows: [{ body: reading }] };
    },
    async readResource(id) {
      if (id === reading.readingId) return Buffer.from(JSON.stringify(reading));
      if (id === documentId) return original;
      throw new Error('unexpected resource ' + id);
    },
  };
  return { activityValue, reading, reference, storage };
}

test('PDF search reports partial read failure and locates the native-text page', async () => {
  const fixture = pdfFixture();
  const search = createMaterialSearch({ open: async () => fixture.activityValue,
    pdf: { reading: async () => fixture.reading } });
  const result = await search.search(identity, fixture.activityValue.activityId,
    { query: '串联', scope: { courseMaterials: false, skillAttachments: false, pdfReferenceIds: [fixture.reading.readingId] } },
    { pdfReferences: [fixture.reference] });
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].readMethod, 'native-pdf-text');
  assert.deepEqual(result.matches[0].locator, { page: 1, start: 4, end: 6 });
  assert.equal(result.sources[0].state, 'partial-failure');
  assert.equal(result.sources[0].source.label, '电路.pdf');
  assert.deepEqual(result.coverage.kinds, ['pdf']);

  const empty = await search.search(identity, fixture.activityValue.activityId,
    { query: '没有这个词', scope: { courseMaterials: false, skillAttachments: false, pdfReferenceIds: [fixture.reading.readingId] } },
    { pdfReferences: [fixture.reference] });
  assert.equal(empty.matches.length, 0);
  assert.equal(empty.sources.at(-1).state, 'no-hit');
});

test('course search distinguishes not-indexed, no-text and no-access without naming denied sources', async () => {
  const activityValue = activity();
  const courseId = randomUUID(), releaseId = randomUUID();
  const textMaterial = { materialId: randomUUID(), title: '讲义', mediaType: 'text/markdown', sha256: digest('讲义内容'), byteLength: Buffer.byteLength('讲义内容') };
  const pdfMaterial = { materialId: randomUUID(), title: '扫描讲义.pdf', mediaType: 'application/pdf', sha256: digest('pdf'), byteLength: 10 };
  const imageMaterial = { materialId: randomUUID(), title: '图片', mediaType: 'image/png', sha256: digest('png'), byteLength: 3 };
  activityValue.course = { courseId, releaseId, materials: [textMaterial, pdfMaterial, imageMaterial] };
  const search = createMaterialSearch({
    open: async () => activityValue,
    courses: { readMaterial: async (_identity, release, materialId) => {
      assert.equal(release, releaseId);
      if (materialId === textMaterial.materialId) return { materialId, sha256: textMaterial.sha256,
        byteLength: textMaterial.byteLength, contentBase64: Buffer.from('讲义内容').toString('base64') };
      throw Object.assign(new Error('forbidden'), { code: 'forbidden' });
    } },
  });
  const result = await search.search(identity, activityValue.activityId,
    { query: '不存在', scope: { courseMaterials: true, skillAttachments: false } }, {});
  assert.deepEqual(result.sources.map(item => item.state), ['searched', 'not-indexed', 'no-text', 'no-hit']);
  assert.equal(result.sources[4], undefined);
  assert.equal(result.sources[1].source, undefined);
  assert.equal(result.sources[2].source, undefined);
  assert.equal(result.matches.length, 0);

  const noCourseActivity = activity();
  const noCourse = createMaterialSearch({ open: async () => noCourseActivity,
    personal: { original: async () => { throw Object.assign(new Error('missing'), { code: 'missing' }); } } });
  const denied = await noCourse.search(identity, noCourseActivity.activityId,
    { query: '不存在', scope: { courseMaterials: true, skillAttachments: false } }, {});
  assert.equal(denied.sources[0].state, 'no-access');
  assert.equal(denied.sources[0].source, undefined);

  const missingId = randomUUID();
  const missing = await noCourse.search(identity, noCourseActivity.activityId,
    { query: '不存在', scope: { courseMaterials: false, skillAttachments: false, personalMaterialIds: [missingId] } }, {});
  assert.equal(missing.sources[0].state, 'missing', 'a selected personal id without a fixed draft reference is missing, not no-access');
  assert.equal(missing.sources[0].source, undefined);
  assert.equal(missing.coverage.sourceCount, 1);
  assert.equal(missing.coverage.searchedSourceCount, 0);
  assert.equal(missing.coverage.excludedSourceCount, 1);
});

test('selected UTF-8 skill attachments are searched through the skill owner and report their path', async () => {
  const activityValue = activity(), skillId = randomUUID();
  const content = '# 电路 Skill\n节点电压法步骤';
  const attachment = { path: 'notes.md', encoding: 'utf8', mediaType: 'text/markdown',
    byteLength: Buffer.byteLength(content), digest: digest(content) };
  const catalog = { skillId, version: 1, name: 'circuit-helper', description: '电路方法', source: '个人',
    packageVersion: '1.0.0', digest: 'a'.repeat(64), metadata: { name: 'circuit-helper', description: '电路方法' },
    attachments: [attachment], origin: 'personal', selected: true, disabled: false, required: false };
  const search = createMaterialSearch({
    open: async () => activityValue,
  });
  const result = await search.search(identity, activityValue.activityId,
    { query: '节点电压', scope: { courseMaterials: false, skillAttachments: true } },
    { skillState: { catalog: [catalog], loaded: [] },
      skillRead: async (readSkillId, version, path) => { assert.equal(readSkillId, skillId); assert.equal(version, 1);
        assert.equal(path, 'notes.md'); return { content, digest: attachment.digest }; } });
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].readMethod, 'skill-text-attachment');
  assert.equal(result.matches[0].source.kind, 'skill-attachment');
  assert.equal(result.matches[0].source.path, 'notes.md');
  assert.equal(result.matches[0].source.label, 'circuit-helper · notes.md');
  assert.deepEqual(result.coverage.kinds, ['skill-attachment']);
  assert.equal(result.sources[0].state, 'searched');
});

test('source read failures distinguish missing, partial failure and denied access', async () => {
  const activityValue = activity(), courseId = randomUUID(), releaseId = randomUUID();
  const material = { materialId: randomUUID(), title: '讲义', mediaType: 'text/markdown', sha256: digest('讲义'), byteLength: 6 };
  activityValue.course = { courseId, releaseId, materials: [material] };
  const search = createMaterialSearch({ open: async () => activityValue,
    courses: { readMaterial: async () => { throw Object.assign(new Error('storage unavailable'), { code: 'storage' }); } } });
  const failed = await search.search(identity, activityValue.activityId,
    { query: '不存在', scope: { courseMaterials: true, skillAttachments: false } }, {});
  assert.equal(failed.sources[0].state, 'partial-failure');
  assert.equal(failed.sources[0].source, undefined);

  const missingSearch = createMaterialSearch({ open: async () => activityValue,
    courses: { readMaterial: async () => { throw Object.assign(new Error('gone'), { code: 'missing' }); } } });
  const missing = await missingSearch.search(identity, activityValue.activityId,
    { query: '不存在', scope: { courseMaterials: true, skillAttachments: false } }, {});
  assert.equal(missing.sources[0].state, 'missing');

  const deniedSearch = createMaterialSearch({ open: async () => activityValue,
    courses: { readMaterial: async () => { throw Object.assign(new Error('forbidden'), { code: 'forbidden' }); } } });
  const denied = await deniedSearch.search(identity, activityValue.activityId,
    { query: '不存在', scope: { courseMaterials: true, skillAttachments: false } }, {});
  assert.equal(denied.sources[0].state, 'no-access');

  const personalId = randomUUID(), personalActivity = activity();
  const reference = { referenceId: randomUUID(), source: { kind: 'personal-material', activityId: personalActivity.activityId,
    materialId: personalId, version: 1, sha256: digest('笔记') }, range: { kind: 'text', start: 0, end: 2 }, copy: '笔记', sourceName: '笔记.md' };
  const personalSearch = createMaterialSearch({ open: async () => personalActivity,
    personal: { original: async () => { throw Object.assign(new Error('missing'), { code: 'missing' }); } } });
  const personal = await personalSearch.search(identity, personalActivity.activityId,
    { query: '笔记', scope: { courseMaterials: false, skillAttachments: false, personalMaterialIds: [personalId] } },
    { personalReferences: [reference] });
  assert.equal(personal.sources[0].state, 'missing');
  assert.equal(personal.sources[0].source, undefined);
});

test('empty course text is no-text rather than a searched source with no hit', async () => {
  const activityValue = activity(), courseId = randomUUID(), releaseId = randomUUID();
  const material = { materialId: randomUUID(), title: '空白讲义', mediaType: 'text/plain', sha256: digest(''), byteLength: 0 };
  activityValue.course = { courseId, releaseId, materials: [material] };
  const search = createMaterialSearch({ open: async () => activityValue,
    courses: { readMaterial: async () => ({ materialId: material.materialId, sha256: material.sha256,
      byteLength: 0, contentBase64: '' }) } });
  const result = await search.search(identity, activityValue.activityId,
    { query: '任何词', scope: { courseMaterials: true, skillAttachments: false } }, {});
  assert.equal(result.sources[0].state, 'no-text');
  assert.equal(result.coverage.searchedSourceCount, 0);
  assert.equal(result.coverage.searchedChars, 0);
  assert.equal(result.matches.length, 0);
});

import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { expect } from '@playwright/test';

const REASON_A = '双标签A：保留进位边界草稿';
const REASON_B = '双标签B：保留操作区别草稿';
const DATABASE = 'xunjie-reliable-works-v1';
const UI = 90000, SYNC = 120000, CONFLICT = 20000;
const tool = page => page.locator('.runtime-tool-full.alu-tool');
const reason = page => tool(page).getByLabel('选择这组输入的理由', { exact: true });
const draftContent = draft => ({ question: draft.question,
  references: draft.references.map(({ copyDigest: _digest, ...reference }) => reference) });
const executionIds = snapshot => snapshot.executionCommands.map(item => item.requestId).sort();

function scopeParts(key, activityId) {
  try {
    const parts = JSON.parse(key);
    return Array.isArray(parts) && parts.length === 5 && parts[4] === activityId ? parts : null;
  } catch { return null; }
}

/** Inspect existing product stores in one readonly transaction; never create/upgrade a DB. */
async function local(page, activityId, key) {
  const snapshot = await page.evaluate(async ({ database, activityId, key }) => {
    if (!(await indexedDB.databases()).some(item => item.name === database)) throw new Error('Real workspace IDB is absent');
    const db = await new Promise((resolve, reject) => {
      const opening = indexedDB.open(database);
      opening.onupgradeneeded = () => { opening.transaction.abort(); reject(new Error('Unexpected workspace IDB upgrade')); };
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
      opening.onblocked = () => reject(new Error('Workspace IDB readonly open is blocked'));
    });
    try {
      const names = ['workspaces', 'candidates', 'drafts', 'executionCommands'];
      for (const name of names) if (!db.objectStoreNames.contains(name)) throw new Error(`Real workspace store is absent: ${name}`);
      const stores = await new Promise((resolve, reject) => {
        const tx = db.transaction(names, 'readonly'), result = {};
        for (const name of names) {
          const request = tx.objectStore(name).getAll();
          request.onsuccess = () => { result[name] = request.result; };
        }
        tx.oncomplete = () => resolve(result);
        tx.onabort = () => reject(tx.error ?? new Error('Workspace IDB readonly transaction aborted'));
        tx.onerror = () => { /* onabort reports the original transaction failure. */ };
      });
      const inActivity = value => {
        if (typeof value !== 'string') return false;
        try { const parts = JSON.parse(value); return Array.isArray(parts) && parts.length === 5 && parts[4] === activityId; }
        catch { return false; }
      };
      const workspaces = stores.workspaces.filter(row => key ? row.key === key : inActivity(row.key));
      if (workspaces.length !== 1) throw new Error(`Expected exactly one real workspace for activity; found ${workspaces.length}`);
      const scope = workspaces[0].key;
      return { workspace: workspaces[0], candidates: stores.candidates.filter(row => row.scope === scope),
        drafts: stores.drafts.filter(row => row.key === scope), executionCommands: stores.executionCommands.filter(row => row.scope === scope) };
    } finally { db.close(); }
  }, { database: DATABASE, activityId, key });
  assert.equal(snapshot.drafts.length, 1, 'exactly one original question draft belongs to this workspace');
  return { ...snapshot, draft: snapshot.drafts[0] };
}

function component(files, name) {
  const matches = files.filter(file => file.mediaType === 'application/vnd.xunjie.component-state+json' && (!name || file.name === name));
  const parsed = matches.map(file => ({ file, envelope: JSON.parse(file.value) }))
    .filter(item => item.envelope.stateVersion === 3 && typeof item.envelope.content?.caseDraft === 'string');
  assert.equal(parsed.length, 1, 'exactly one original stateVersion3 ALU component is available');
  const { file, envelope } = parsed[0];
  const draft = envelope.content.caseDraft ? JSON.parse(envelope.content.caseDraft) : null;
  return { file, envelope, draft, reason: draft?.reason ?? null, caseId: draft?.caseId ?? null };
}

async function poll(message, read, accepts, timeout = SYNC) {
  let value;
  await expect.poll(async () => { value = await read(); return Boolean(accepts(value)); },
    { message, timeout, intervals: [100, 250, 500, 1000] }).toBe(true);
  return value;
}

async function owner(page, origin, route, headers) {
  const result = await page.evaluate(async ({ url, headers }) => {
    const response = await fetch(url, { method: 'GET', credentials: 'same-origin', redirect: 'error', cache: 'no-store',
      headers, signal: AbortSignal.timeout(30000) });
    return { status: response.status, value: await response.json() };
  }, { url: new URL(`/api/learning/${route}`, origin).href, headers });
  assert.equal(result.status, 200, `Original owner GET ${route} must succeed; HTTP ${result.status}`);
  return result.value;
}

async function ownerExecutionIds(page, origin, activityId, headers) {
  const ids = [], cursors = new Set();
  let cursor = null;
  do {
    assert.ok(cursors.size < 64, 'execution history must finish within 64 genuine pages');
    const history = await owner(page, origin, `executions/${activityId}/history${cursor ? '/' + encodeURIComponent(cursor) : ''}`, headers);
    assert.ok(Array.isArray(history.entries), 'owner returns an execution history page');
    for (const entry of history.entries) {
      assert.equal(entry.action.scope.activityId, activityId, 'history stays in the original activity');
      ids.push(entry.action.requestId);
    }
    cursor = history.nextCursor;
    assert.ok(!cursor || !cursors.has(cursor), 'execution history cursor must advance');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  assert.equal(new Set(ids).size, ids.length, 'owner history contains no duplicate execution IDs');
  return ids.sort();
}

async function tab(page, name) {
  await page.getByRole('tab', { name, exact: true }).click({ timeout: UI });
  await expect(page.getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true', { timeout: UI });
}

async function comparison(page, componentName, caseId) {
  const view = page.locator('.work-comparison');
  if (!await view.isVisible()) return null;
  await expect(page.getByRole('heading', { name: '作品存在分歧', exact: true })).toBeVisible();
  const columns = view.locator(':scope > div');
  await expect(columns).toHaveCount(2);
  const result = [];
  for (const [index, title] of ['本页内容', '另一版本'].entries()) {
    const column = columns.nth(index);
    await expect(column.getByRole('heading', { name: title, exact: true })).toBeVisible();
    const summary = column.locator('summary').filter({ hasText: new RegExp(`^${componentName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) });
    await expect(summary).toHaveCount(1);
    const text = await summary.locator('..').locator('pre').textContent();
    const envelope = JSON.parse(text);
    const draft = JSON.parse(envelope.content.caseDraft);
    assert.equal(draft.caseId, caseId, `${title} retains the same original ALU case`);
    result.push({ column: title, reason: draft.reason });
  }
  assert.deepEqual(result.map(side => side.reason).sort(), [REASON_A, REASON_B].sort(), 'both real UI columns retain the two complete reasons');
  return result;
}

async function visibleComponent(page, name) {
  await tab(page, '作品');
  await page.getByRole('group', { name: '已打开的文件', exact: true }).getByRole('button', { name, exact: true }).click({ timeout: UI });
  const raw = page.locator('.learning-workspace > pre');
  await expect(raw).toBeVisible({ timeout: UI });
  return raw.textContent();
}

/** Scroll the actual comparison text to the reason; never replace text or alter app state. */
async function revealReasons(page, name, sides) {
  for (const [index, side] of sides.entries()) {
    const column = page.locator('.work-comparison').locator(':scope > div').nth(index);
    const pre = column.locator('summary').filter({ hasText: name }).locator('..').locator('pre');
    await pre.scrollIntoViewIfNeeded();
    const found = await pre.evaluate((element, text) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const start = node.textContent.indexOf(text);
        if (start < 0) continue;
        const range = document.createRange(); range.setStart(node, start); range.setEnd(node, start + text.length);
        const rectangle = range.getBoundingClientRect(), frame = element.getBoundingClientRect();
        element.scrollTop += rectangle.top - frame.top - 12;
        element.scrollLeft += rectangle.left - frame.left - 12;
        return true;
      }
      return false;
    }, side.reason);
    assert.ok(found, 'the screenshot scrolls to a genuine reason in the original comparison text');
  }
}

/**
 * Real UI/IDB/GET-only acceptance seam; no product launch or invocation on module import.
 * Requires an online, idle ALU activity with a nonempty question and existing references.
 * The caller owns Chrome, authentication, the activity, failure reporting and this evidence directory.
 * ReliableWorkspace currently protects every 250 ms; the ALU's 150 ms timer throttles observations.
 * Concurrent fills must produce a genuine persisted CAS candidate, otherwise this helper fails.
 */
export async function probeAluLearningTwoTabs({ page, context, activityId, output }) {
  assert.ok(page && context && page.context() === context, 'reuse the original real BrowserContext');
  assert.ok(typeof activityId === 'string' && activityId, 'activityId is required');
  assert.ok(typeof output === 'string' && output, 'output screenshot directory is required');
  const origin = new URL(page.url()).origin;
  const worksPath = `/api/learning/workspaces/${activityId}`;
  let observedHeaders, secondary, primaryError;
  // Observe the product's own scope headers; do not guess a space or read auth tokens.
  const observe = request => {
    const url = new URL(request.url());
    if (url.origin !== origin || url.pathname !== worksPath) return;
    const headers = request.headers();
    if (headers['x-xj-space'] && headers['x-xj-namespace'] && headers['x-xj-expected-subject']) observedHeaders = {
      'x-xj-space': headers['x-xj-space'], 'x-xj-namespace': headers['x-xj-namespace'],
      'x-xj-expected-subject': headers['x-xj-expected-subject'], 'content-type': 'application/json' };
  };
  page.on('request', observe);
  try {
    await tab(page, 'ALU 实验');
    const newCase = tool(page).getByRole('button', { name: '新用例', exact: true });
    await expect(newCase).toBeEnabled({ timeout: UI });
    const initial = await local(page, activityId), key = initial.workspace.key, parts = scopeParts(key, activityId);
    assert.ok(parts, 'workspace key has the original namespace, subject and activity');
    assert.ok(!initial.workspace.conflict && !initial.candidates.length, 'start before any pre-existing work conflict');
    assert.ok(!initial.draft.conflict, 'the original question has no pre-existing conflict');
    assert.ok(initial.draft.question.trim() && initial.draft.references.length, 'start with a real question and retained references, not a vacuous draft');
    assert.ok(initial.executionCommands.every(item => item.query.statusKnowledge === 'confirmed'
      && ['succeeded', 'failed', 'cancelled'].includes(item.query.state)), 'start without an experiment still in flight');
    const beforeIds = executionIds(initial), originalDraft = draftContent(initial.draft), originalComponent = component(initial.workspace.files);
    // This real edit guarantees a product-owned works request to observe even when the previous
    // steps have already drained their queues. Waiting for traffic before editing can wait forever.
    await newCase.click();
    await poll('observe the original product works-owner request headers', async () => observedHeaders, Boolean);
    const headers = { ...observedHeaders };
    assert.equal(headers['x-xj-namespace'], parts[0], 'owner reads reuse the original recovery namespace');
    assert.equal(headers['x-xj-expected-subject'], parts.slice(1, 4).join('.'), 'owner reads reuse the original authenticated subject');
    const beforeOwnerIds = await ownerExecutionIds(page, origin, activityId, headers);
    const remoteDraftBefore = await poll('original question and all references have reached their owner before the two-tab edit',
      () => owner(page, origin, `drafts/${activityId}`, headers), value =>
        isDeepStrictEqual(draftContent(value), originalDraft));
    assert.deepEqual(draftContent(remoteDraftBefore), originalDraft, 'original question/references must already belong to the owner');

    const held = await poll('new UI case is protected with hold and a new original caseId', () => local(page, activityId, key), snapshot => {
      const value = component(snapshot.workspace.files, originalComponent.file.name);
      return value.caseId && value.caseId !== originalComponent.caseId && value.envelope.content.feedbackPolicy === 'hold';
    });
    const candidate = component(held.workspace.files, originalComponent.file.name), name = candidate.file.name, caseId = candidate.caseId;
    await expect(reason(page)).toHaveValue('', { timeout: UI });

    // Finish the genuine owner acknowledgement before another page observes this case.
    let stableKey, stableAt = 0;
    const stable = await poll('original works owner has acknowledged this exact held component case before page B opens', async () => {
      const snapshot = await local(page, activityId, key);
      const head = await owner(page, origin, `workspaces/${activityId}`, headers);
      return { snapshot, head };
    }, ({ snapshot, head }) => {
      const current = component(snapshot.workspace.files, name), remote = component(head.files, name);
      const settled = current.caseId === caseId && remote.caseId === caseId && remote.envelope.content.feedbackPolicy === 'hold'
        && current.file.value === remote.file.value && !snapshot.workspace.pending && !snapshot.workspace.conflict
        && !snapshot.candidates.length && !snapshot.draft.pending && snapshot.workspace.remoteRevision === head.revision;
      if (!settled) { stableKey = undefined; return false; }
      const token = JSON.stringify([snapshot.workspace.localRevision, head.revision, current.file.contentId]);
      if (token !== stableKey) { stableKey = token; stableAt = Date.now(); return false; }
      return Date.now() - stableAt >= 300;
    });
    assert.deepEqual(draftContent(stable.snapshot.draft), originalDraft, 'new case does not change the question or any reference');
    const otherFiles = stable.snapshot.workspace.files.filter(file => file.name !== name);
    const originalHeldBytes = component(stable.snapshot.workspace.files, name).file.value;

    secondary = await context.newPage();
    await secondary.goto(page.url(), { waitUntil: 'domcontentloaded', timeout: UI });
    await tab(secondary, 'ALU 实验');
    await Promise.all([expect(reason(page)).toBeEnabled({ timeout: UI }), expect(reason(secondary)).toBeEnabled({ timeout: UI }),
      expect(reason(page)).toHaveValue(''), expect(reason(secondary)).toHaveValue('')]);
    const originalViews = await Promise.all([visibleComponent(page, name), visibleComponent(secondary, name)]);
    for (const value of originalViews) assert.equal(value, originalHeldBytes, 'both real UI views show the same original held component bytes');
    await Promise.all([tab(page, 'ALU 实验'), tab(secondary, 'ALU 实验')]);
    await Promise.all([expect(reason(page)).toBeEnabled({ timeout: UI }), expect(reason(secondary)).toBeEnabled({ timeout: UI })]);
    const [aReady, bReady] = await Promise.all([local(page, activityId, key), local(secondary, activityId, key)]);
    assert.equal(aReady.workspace.localRevision, bReady.workspace.localRevision, 'both pages observe the same original protected revision');
    assert.equal(aReady.workspace.remoteRevision, stable.head.revision, 'no remote revision changed before concurrent input');
    assert.equal(component(aReady.workspace.files, name).caseId, caseId);
    assert.equal(component(bReady.workspace.files, name).caseId, caseId);
    assert.ok(!aReady.workspace.pending && !bReady.workspace.pending && !aReady.candidates.length && !bReady.candidates.length,
      'both real views begin without a pending write or a synthetic candidate');
    const editStarted = Date.now();
    const fillCompletedAt = await Promise.all([
      reason(page).fill(REASON_A, { timeout: UI }).then(() => Date.now()),
      reason(secondary).fill(REASON_B, { timeout: UI }).then(() => Date.now()),
    ]);
    await Promise.all([expect(reason(page)).toHaveValue(REASON_A), expect(reason(secondary)).toHaveValue(REASON_B)]);

    const protectedConflict = await poll('genuine local CAS retains opposite A/B reasons in workspaces and candidates',
      () => local(page, activityId, key), snapshot => {
        const current = component(snapshot.workspace.files, name);
        const rejected = snapshot.candidates.map(item => component(item.files, name));
        return current.caseId === caseId && [REASON_A, REASON_B].includes(current.reason)
          && rejected.some(item => item.caseId === caseId && item.reason === (current.reason === REASON_A ? REASON_B : REASON_A));
      }, CONFLICT);
    assert.deepEqual(executionIds(protectedConflict), beforeIds, 'reason-only input creates no experiment command');
    await Promise.all([tab(page, '作品'), tab(secondary, '作品')]);
    await poll('at least one genuine product comparison is visible after CAS', async () => Promise.all([
      page.locator('.work-comparison').isVisible(), secondary.locator('.work-comparison').isVisible(),
    ]), visibility => visibility.some(Boolean), CONFLICT);
    const reasonsBefore = { A: await comparison(page, name, caseId), B: await comparison(secondary, name, caseId),
      idb: { current: component(protectedConflict.workspace.files, name).reason,
        candidates: protectedConflict.candidates.map(item => ({ id: item.id, reason: component(item.files, name).reason })) } };
    await mkdir(output, { recursive: true });
    const beforeScreenshot = join(output, 'two-tabs-before-choice.png');
    const conflictPage = reasonsBefore.A ? page : secondary;
    await revealReasons(conflictPage, name, reasonsBefore.A ?? reasonsBefore.B);
    await conflictPage.screenshot({ path: beforeScreenshot, fullPage: true });

    const choices = [];
    for (const [label, view] of [['A', page], ['B', secondary]]) {
      const sides = await comparison(view, name, caseId);
      if (!sides) continue;
      const index = sides.findIndex(side => side.reason === REASON_A);
      assert.ok(index >= 0, `page ${label} offers the original A reason for explicit choice`);
      const button = index === 0 ? '采用本页内容' : '采用另一版本';
      const alert = view.getByRole('alert').filter({ has: view.getByRole('heading', { name: '作品存在分歧', exact: true }) });
      await expect(alert.getByRole('button', { name: button, exact: true })).toBeEnabled({ timeout: UI });
      await alert.getByRole('button', { name: button, exact: true }).click();
      await expect(view.locator('.work-comparison')).toBeHidden({ timeout: CONFLICT });
      choices.push({ page: label, column: sides[index].column, button });
    }
    assert.ok(choices.length, 'an explicit product choice was made; no automatic merge is accepted');
    await Promise.all([tab(page, 'ALU 实验'), tab(secondary, 'ALU 实验')]);
    await Promise.all([expect(reason(page)).toHaveValue(REASON_A, { timeout: UI }), expect(reason(secondary)).toHaveValue(REASON_A, { timeout: UI })]);

    stableKey = undefined;
    const after = await poll('explicit A choice converges in the original UI, IDB and remote owner without reviving the conflict', async () => {
      const snapshot = await local(page, activityId, key), head = await owner(page, origin, `workspaces/${activityId}`, headers);
      return { snapshot, head };
    }, ({ snapshot, head }) => {
      const current = component(snapshot.workspace.files, name), remote = component(head.files, name);
      const settled = current.caseId === caseId && remote.caseId === caseId && current.reason === REASON_A && remote.reason === REASON_A
        && !snapshot.workspace.pending && !snapshot.workspace.conflict && !snapshot.candidates.length
        && snapshot.workspace.remoteRevision === head.revision;
      if (!settled) { stableKey = undefined; return false; }
      const token = JSON.stringify([snapshot.workspace.localRevision, head.revision, current.file.contentId]);
      if (token !== stableKey) { stableKey = token; stableAt = Date.now(); return false; }
      return Date.now() - stableAt >= 1000;
    });
    const bAfter = await local(secondary, activityId, key);
    for (const [label, snapshot] of [['A', after.snapshot], ['B', bAfter]]) {
      assert.deepEqual(executionIds(snapshot), beforeIds, `page ${label} adds no executionCommands and reruns nothing`);
      assert.deepEqual(draftContent(snapshot.draft), originalDraft, `page ${label} preserves the question and every fixed reference`);
      assert.equal(component(snapshot.workspace.files, name).reason, REASON_A);
      assert.deepEqual(snapshot.workspace.files.filter(file => file.name !== name), otherFiles, 'reason conflict resolution preserves all other original works');
    }
    const remoteDraftAfter = await owner(page, origin, `drafts/${activityId}`, headers);
    assert.deepEqual(draftContent(remoteDraftAfter), originalDraft, 'original question owner retains the exact question, reference order, sources and copies');
    const afterOwnerIds = await ownerExecutionIds(page, origin, activityId, headers);
    assert.deepEqual(afterOwnerIds, beforeOwnerIds, 'original execution owner confirms no additional execution');
    await expect(reason(page)).toHaveValue(REASON_A);
    const afterScreenshot = join(output, 'two-tabs-after-choice.png');
    await reason(page).scrollIntoViewIfNeeded();
    await page.screenshot({ path: afterScreenshot, fullPage: true });
    return { passed: true, activityId, caseId, reasonsBefore, keptReason: REASON_A, choices,
      localRevisionBefore: aReady.workspace.localRevision, localRevisionAfter: after.snapshot.workspace.localRevision,
      remoteRevisionBefore: stable.head.revision, remoteRevisionAfter: after.head.revision,
      executionIdsBefore: beforeIds, executionIdsAfter: executionIds(after.snapshot),
      ownerExecutionIdsBefore: beforeOwnerIds, ownerExecutionIdsAfter: afterOwnerIds,
      questionPreserved: true, referenceIdsPreserved: originalDraft.references.map(item => item.referenceId),
      concurrentFill: { durationMs: Math.max(...fillCompletedAt) - editStarted, completionSkewMs: Math.abs(fillCompletedAt[0] - fillCompletedAt[1]) },
      screenshots: { before: beforeScreenshot, after: afterScreenshot, beforePage: reasonsBefore.A ? 'A' : 'B' } };
  } catch (error) { primaryError = error; throw error; }
  finally {
    page.off('request', observe);
    // The passed page/context are always left with their actual product state for inspection.
    if (secondary && !secondary.isClosed()) {
      try { await secondary.close(); }
      catch (error) {
        if (primaryError) throw new AggregateError([primaryError, error], 'Two-tab acceptance failed and its own second page could not close');
        throw error;
      }
    }
  }
}

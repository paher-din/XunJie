import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { pdfRuntime, modelReply } from './fixtures/pdf-runtime.mjs';

async function until(check, message) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const value = await check(); if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  throw new Error(message);
}

const page = () => ({ html: '<section><h2>位宽示意</h2><label>我的解释<textarea data-xj-field="answer"></textarea></label></section>',
  title: '位宽示意', display: 'card', formatVersion: 1, hostApiVersion: 1, css: '', javascript: '', stateVersion: 1,
  stateShape: { type: 'object', properties: { answer: { type: 'string', maxLength: 1000 } } },
  initialState: { answer: '' }, semanticFields: [{ key: 'answer', meaning: '学生对位宽的解释' }], semanticObjects: [],
  requiredCapabilities: ['workspace.read', 'workspace.change'], artifactId: null, parentRevisionId: null, mapping: [] });

test('a real learning request exposes the versioned content generator and keeps its binding in the saved request', { timeout: 180000 }, async () => {
  const f = await pdfRuntime((_payload, _index, protocol) => modelReply(protocol, null, '可以围绕这个问题制作交互解释。'));
  try {
    f.input.draft.question = '请生成一个能填写预测并调整输入的交互学习页面。';
    const runId = await f.send();
    await f.completed(runId);
    const events = await f.api(`agent/${f.activity.activityId}/events`);
    const assembled = events.find(event => event.kind === 'context-assembled');
    assert.ok(assembled);
    const snapshot = await f.api(`agent/${f.activity.activityId}/snapshots/${assembled.body.snapshotId}`);
    const generator = snapshot.resolvedAgent.tools.find(item => item.executor.toolName === 'generate_teaching_artifact');
    assert.ok(generator, 'generation uses the same authorized Agent tool assembly as ordinary learning');
    assert.equal(generator.source.sourceId, 'platform.learning');
    assert.equal(generator.effect, 'input', 'publishing content is a durable change, never a replayable read');
    assert.deepEqual(generator.definition.progress, { kind: 'json-string', property: 'html' });
    const actual = f.payloads[0].tools.find(tool => tool.function.name === generator.modelName);
    assert.ok(actual);
    assert.equal(actual.function.progress, undefined, 'application progress metadata is not sent as an SDK tool option');
    await f.restart();
    assert.deepEqual(await f.api(`agent/${f.activity.activityId}/snapshots/${snapshot.snapshotId}`), snapshot);
    assert.equal(f.payloads.length, 1, 'reading the original content-generation request has no model effect');
  } finally { await f.close(); }
});

test('streaming content stays a static preview until complete arguments publish the original candidate', { timeout: 180000 }, async () => {
  const args = page();
  args.html = '<section><h2>预测与观察</h2><p>' + '先写下自己的解释，再比较真实工具的结果。'.repeat(12) + '</p><textarea data-xj-field="answer"></textarea></section>';
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await pdfRuntime((payload, index, protocol) => {
    if (index > 1) return modelReply(protocol, null, '卡片已生成。');
    const tool = payload.tools.find(tool => tool.function.name === 'generate_teaching_artifact');
    const serialized = JSON.stringify(args), split = serialized.indexOf(',"title"');
    const encoder = new TextEncoder();
    return new Response(new ReadableStream({ start(controller) {
      const emit = value => controller.enqueue(encoder.encode('data: ' + JSON.stringify(value) + '\n\n'));
      emit({ id: 'stream-content', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0,
        id: 'stream-original', type: 'function', function: { name: tool.function.name, arguments: serialized.slice(0, split) } }] }, finish_reason: null }] });
      void gate.then(() => {
        emit({ id: 'stream-content', choices: [{ index: 0, delta: { tool_calls: [{ index: 0,
          function: { arguments: serialized.slice(split) } }] }, finish_reason: null }] });
        emit({ id: 'stream-content', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
        emit({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 100, total_tokens: 150 } });
        controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close();
      });
    } }), { headers: { 'content-type': 'text/event-stream' } });
  });
  try {
    f.input.draft.question = '制作一个逐渐展示的预测卡片。';
    const runId = await f.send();
    const preview = await until(async () => {
      const conversation = await f.api(`agent/${f.activity.activityId}/conversation`);
      return conversation.artifactPreviews?.find(value => value.runId === runId && value.html.includes('预测与观察'));
    }, 'a safe generated HTML prefix must be visible while the original model attempt is still open');
    assert.equal(preview.callId, 'stream-original');
    assert.equal((await f.api(`artifacts/${f.activity.activityId}`)).length, 0, 'incomplete arguments have no publish effect');
    release();
    const conversation = await f.completed(runId);
    const command = conversation.tools.find(tool => tool.commandId === preview.commandId);
    assert.equal(command.outcome, 'completed');
    assert.ok(command.result.artifact.candidateId);
    await f.restart();
    const recovered = await f.api(`agent/${f.activity.activityId}/conversation`);
    assert.ok(recovered.artifactPreviews.some(value => value.commandId === preview.commandId && value.html === preview.html));
    assert.equal(f.payloads.length, 2, 'replaying preview events never starts another model attempt');
  } finally { release(); await f.close(); }
});

test('a model tool result publishes one immutable activity candidate through the original Command and can be reread after restart', { timeout: 180000 }, async () => {
  const args = page();
  const f = await pdfRuntime((payload, index, protocol) => {
    const tool = payload.tools.find(tool => (tool.function?.name ?? tool.name) === 'generate_teaching_artifact');
    return modelReply(protocol, index === 1 ? { id: 'content-original', name: tool.function?.name ?? tool.name, arguments: args } : null,
      '位宽示意卡片已经生成，你可以在其中记录自己的解释。');
  });
  try {
    f.input.draft.question = '生成一个位宽示意卡片，保留我的解释输入。';
    const runId = await f.send(), conversation = await f.completed(runId);
    const command = conversation.tools.find(tool => tool.name === 'generate_teaching_artifact');
    assert.equal(command?.outcome, 'completed', JSON.stringify(command));
    const receipt = command.result.artifact;
    assert.equal(receipt.requestId, command.commandId);
    assert.equal(receipt.outcome, 'candidate', 'publication alone does not claim that the view passed its browser check');
    const route = `artifacts/${f.activity.activityId}`;
    const fixed = await f.api(`${route}/${receipt.artifactId}/revisions/${receipt.revisionId}`);
    assert.equal(fixed.payload.html, args.html);
    assert.equal(fixed.origin.runId, runId);
    assert.equal(fixed.origin.commandId, command.commandId);
    assert.equal(fixed.origin.snapshotId, command.snapshotId);
    assert.equal((await f.api(route)).length, 1);
    assert.deepEqual(await f.api(`${route}/receipts/${command.commandId}`), receipt);
    await f.restart();
    assert.deepEqual(await f.api(`${route}/${receipt.artifactId}/revisions/${receipt.revisionId}`), fixed);
    assert.deepEqual(await f.api(`${route}/receipts/${command.commandId}`), receipt);
    assert.equal(f.payloads.length, 2, 'recovery reads the original publication instead of asking the model to regenerate');
  } finally { await f.close(); }
});

for (const protocol of ['responses', 'messages']) test(`${protocol} publishes content through the same original tool and source contract`, { timeout: 180000 }, async () => {
  const args = page();
  const f = await pdfRuntime((payload, index) => {
    const tool = payload.tools.find(tool => (tool.function?.name ?? tool.name) === 'generate_teaching_artifact');
    return modelReply(protocol, index === 1 ? { id: `content-${protocol}`, name: tool.function?.name ?? tool.name, arguments: args } : null,
      '请在位宽示意卡片中记录你的解释。');
  }, protocol);
  try {
    f.input.draft.question = '生成位宽示意卡片。';
    const runId = await f.send(), conversation = await f.completed(runId);
    const tool = conversation.tools.find(tool => tool.name === 'generate_teaching_artifact');
    assert.equal(tool?.outcome, 'completed', JSON.stringify(tool));
    const receipt = tool.result.artifact;
    const fixed = await f.api(`artifacts/${f.activity.activityId}/${receipt.artifactId}/revisions/${receipt.revisionId}`);
    assert.equal(fixed.origin.runId, runId);
    assert.equal(fixed.origin.commandId, tool.commandId);
    assert.equal(fixed.payload.html, args.html);
    assert.equal(conversation.runs.find(run => run.runId === runId).model.protocol, protocol);
  } finally { await f.close(); }
});

test('stopping a generation with a visible preview cannot publish a late complete tool result', { timeout: 180000 }, async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const args = page(); args.html = '<p>' + '只预览，尚未启用。'.repeat(40) + '</p>';
  const f = await pdfRuntime((payload, _index, protocol) => {
    const tool = payload.tools.find(tool => tool.function.name === 'generate_teaching_artifact');
    const serialized = JSON.stringify(args), split = serialized.indexOf(',"title"');
    const encoder = new TextEncoder(); let cancelled = false;
    return new Response(new ReadableStream({ start(controller) {
      const emit = value => controller.enqueue(encoder.encode('data: ' + JSON.stringify(value) + '\n\n'));
      emit({ id: 'stopping-content', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0,
        id: 'stopping-original', type: 'function', function: { name: tool.function.name, arguments: serialized.slice(0, split) } }] }, finish_reason: null }] });
      void gate.then(() => {
        if (cancelled) return;
        emit({ id: 'stopping-content', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: serialized.slice(split) } }] }, finish_reason: null }] });
        emit({ id: 'stopping-content', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
        controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close();
      });
    }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } });
  });
  try {
    f.input.draft.question = '生成卡片，随后我要停止。';
    const runId = await f.send();
    await until(async () => (await f.api(`agent/${f.activity.activityId}/conversation`)).artifactPreviews.some(value => value.runId === runId),
      'generation must have reached the preview boundary');
    await f.api(`agent/${f.activity.activityId}/runs/${runId}/stop`, { requestId: randomUUID() });
    release();
    await until(async () => (await f.api(`agent/${f.activity.activityId}/runs/${runId}`)).state === 'stopped', 'original Run did not stop');
    assert.deepEqual(await f.api(`artifacts/${f.activity.activityId}`), []);
    await f.restart();
    assert.deepEqual(await f.api(`artifacts/${f.activity.activityId}`), []);
    assert.equal(f.payloads.length, 1, 'a stopped content generation never silently starts over');
  } finally { release(); await f.close(); }
});

test('a structurally invalid generated state is a recorded tool failure and can be repaired within the same Run', { timeout: 180000 }, async () => {
  const invalid = page(); invalid.initialState = { answer: 17 };
  const f = await pdfRuntime((payload, index, protocol) => {
    const tool = payload.tools.find(tool => tool.function.name === 'generate_teaching_artifact');
    return modelReply(protocol, index < 3 ? { id: 'state-' + index, name: tool.function.name, arguments: index === 1 ? invalid : page() } : null,
      '修正后的卡片已保留。');
  });
  try {
    f.input.draft.question = '生成解释卡片，检查有问题时修正。';
    const runId = await f.send(), conversation = await f.completed(runId);
    const commands = conversation.tools.filter(tool => tool.name === 'generate_teaching_artifact');
    assert.equal(commands.length, 2);
    assert.equal(commands[0].outcome, 'not-dispatched');
    assert.equal(commands[0].basis.rejected, 'invalid');
    assert.equal(commands[1].outcome, 'completed');
    assert.equal((await f.api(`artifacts/${f.activity.activityId}`)).length, 1);
    assert.equal(f.payloads.length, 3, 'repair remains in the original bounded Agent/model budget');
  } finally { await f.close(); }
});

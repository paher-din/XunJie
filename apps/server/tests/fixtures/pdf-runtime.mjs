import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dns from 'node:dns/promises';
import { syncBuiltinESMExports } from 'node:module';
import { openProductRuntime, createProductRuntimeHost, createProductLearningApplication } from '@xunjie/product-runtime';
import { pdfReferenceCopy } from '@xunjie/contracts/pdf-materials';
import { fixedPdf } from './pdf-material.mjs';

export function modelReply(protocol, call, text = '只根据已经读取的固定 PDF 第 2 页解释，未读取其他页。') {
  const events = [];
  if (protocol === 'chat-completions') {
    events.push({ id: 'pdf-chat', choices: [{ index: 0, delta: { role: 'assistant', content: call ? '' : text,
      ...(call ? { reasoning_content: '读取固定页图。', tool_calls: [{ index: 0, id: call.id, type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } : {}) }, finish_reason: null }] },
    { id: 'pdf-chat', choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }] },
    { choices: [], usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 } });
  } else if (protocol === 'responses') {
    events.push({ type: 'response.completed', response: { id: 'pdf-response', object: 'response', status: 'completed',
      output: call ? [{ id: 'pdf-function', type: 'function_call', call_id: call.id, name: call.name,
        arguments: JSON.stringify(call.arguments), status: 'completed' }] : [{ id: 'pdf-text', type: 'message', role: 'assistant',
        status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }],
      usage: { input_tokens: 40, output_tokens: 20, total_tokens: 60 } } });
  } else {
    events.push({ type: 'message_start', message: { id: 'pdf-message', type: 'message', role: 'assistant', model: 'deepseek-flash',
      content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 40, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: call
      ? { type: 'tool_use', id: call.id, name: call.name, input: {} } : { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: call
      ? { type: 'input_json_delta', partial_json: JSON.stringify(call.arguments) } : { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: call ? 'tool_use' : 'end_turn', stop_sequence: null },
      usage: { input_tokens: 40, output_tokens: 20 } }, { type: 'message_stop' });
  }
  return new Response(events.map(event => (protocol === 'messages' ? 'event: ' + event.type + '\n' : '')
    + 'data: ' + JSON.stringify(event) + '\n\n').join('') + (protocol === 'chat-completions' ? 'data: [DONE]\n\n' : ''),
  { headers: { 'content-type': 'text/event-stream' } });
}

/** Only the upstream fetch is controlled; every product owner, HTTP handler and PDF process is real. */
export async function pdfRuntime(answer, protocol = 'chat-completions', pdfBytes = fixedPdf()) {
  assert.ok(process.env.XUNJIE_PRODUCT_POSTGRES_BIN);
  const root = await mkdtemp(join(tmpdir(), 'xj-wp08-218-agent-'));
  const resources = { nodePath: process.execPath, nodeVersion: '24.21.0',
    postgresBin: process.env.XUNJIE_PRODUCT_POSTGRES_BIN, postgresVersion: '18.6',
    webRoot: fileURLToPath(new URL('../../../web/dist-runtime', import.meta.url)),
    windowsPrerequisitePath: fileURLToPath(new URL('../../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) };
  const runtime = openProductRuntime({ root, resources }), payloads = [], transportErrors = [], originalFetch = globalThis.fetch;
  const originalLookup = dns.lookup;
  // Local proxy DNS may return a deliberately prohibited benchmark address. This controlled
  // transport has no upstream socket; provide a public classification at the DNS boundary only.
  dns.lookup = async (hostname, options) => hostname === 'api.deepseek.com'
    ? options?.all ? [{ address: '93.184.216.34', family: 4 }] : { address: '93.184.216.34', family: 4 }
    : originalLookup(hostname, options);
  syncBuiltinESMExports();
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === 'api.deepseek.com') {
      try { const payload = JSON.parse(input instanceof Request ? await input.clone().text() : init.body); payloads.push(payload);
      return await answer(payload, payloads.length, protocol); } catch(error) {transportErrors.push(String(error));throw error;}
    }
    return originalFetch(input, init);
  };
  let host;
  try {
    await runtime.install({ profile: 'local' });
    host = await createProductRuntimeHost({ root, createApplication: createProductLearningApplication });
    const request = async (route, body, headers = {}) => {
      const response = await originalFetch(new URL('/api/learning/' + route, host.endpoint), {
        headers: { 'content-type': 'application/json', 'x-xj-space': 'personal', ...headers },
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
      return { status: response.status, headers: response.headers, value: await response.json() };
    };
    const api = async (route, body, headers) => {
      const response = await request(route, body, headers);
      assert.equal(response.status, 200, route + ': ' + JSON.stringify(response.value)); return response.value;
    };
    const connectionId = randomUUID(), grantId = randomUUID();
    const connection = await api('models/connections', { requestId: randomUUID(), connectionId, expectedVersion: 0,
      name: 'PDF transport fixture', protocol, baseUrl: 'https://api.deepseek.com/' + (protocol === 'messages' ? 'anthropic' : 'v1'),
      path: protocol === 'messages' ? '/v1/messages' : protocol === 'responses' ? '/responses' : '/chat/completions',
      modelId: 'deepseek-flash', dialect: 'deepseek', parameterMode: 'thinking', enabled: true,
      contextWindow: 262144, maxOutputTokens: 1024, credential: { action: 'replace', value: 'synthetic-pdf-fixture-key' } });
    assert.equal(connection.capabilities.images, 'verified');
    await api('models/grants', { requestId: randomUUID(), grantId, connectionId, owner: 'self' });
    await api('models/selection', { requestId: randomUUID(), expectedVersion: 0, source: { kind: 'personal', connectionId, grantId } });
    const activity = await api('activities', { requestId: randomUUID(), goal: 'PDF 固定依据', question: '', references: [] });
    const pdfRoute = `pdf/${activity.activityId}`;
    const document = await api(pdfRoute, { requestId: randomUUID(), documentId: randomUUID(), name: 'lesson.pdf', dataBase64: pdfBytes.toString('base64') });
    const reading = await api(pdfRoute + '/read', { requestId: randomUUID(), documentId: document.documentId, pages: [2], region: null });
    const copy = pdfReferenceCopy(reading);
    const reference = { referenceId: randomUUID(), source: { kind: 'pdf', activityId: activity.activityId,
      documentId: document.documentId, documentSha256: document.sha256, readingId: reading.readingId },
      range: { kind: 'semantic', formatVersion: 1, typeId: 'pdf-pages', version: 1,
        target: { pages: [2], region: null, coordinates: reading.coordinates }, start: 0, end: copy.length }, copy, sourceName: document.name };
    const receiver = (await api(`agent/${activity.activityId}/capabilities`)).receiver;
    const input = { requestId: randomUUID(), scope: { environmentId: activity.identity.environmentId, spaceId: activity.identity.spaceId,
      principalId: activity.identity.principalId, activityId: activity.activityId }, receiver,
      draft: { token: randomUUID(), question: '先读取固定第2页的页图，再解释电路。', references: [reference], bases: [] }, works: [], evidence: [] };
    return { root, resources, runtime, api, request, payloads, activity, document, reading, reference, input, connectionId, grantId,
      get endpoint() { return host.endpoint; },
      async send(value = input) {
        await api(`intents/${activity.activityId}`, value);
        const receipt = await api(`intents/${activity.activityId}/${value.requestId}/dispatch`, {});
        assert.equal(receipt.state, 'accepted'); return JSON.parse(receipt.receipt.detail).runId;
      },
      async completed(runId) {
        for (let n = 0; n < 250; n++) {
          const value = await api(`agent/${activity.activityId}/conversation`), run = value.runs.find(run => run.runId === runId);
          if (run?.state === 'completed') return value;
          assert.ok(!['failed', 'paused', 'stopped'].includes(run?.state), JSON.stringify({run, sent:payloads.length, transportErrors}));
          await new Promise(resolve => setTimeout(resolve, 80));
        }
        throw new Error('PDF Agent did not complete');
      },
      async restart() { await host.stop(); host = await createProductRuntimeHost({ root, createApplication: createProductLearningApplication }); },
      async close() { await host.stop(); await runtime.stop(); globalThis.fetch = originalFetch;
        dns.lookup = originalLookup; syncBuiltinESMExports();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } };
  } catch (error) {
    await host?.stop(); await runtime.stop(); globalThis.fetch = originalFetch;
    dns.lookup = originalLookup; syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); throw error;
  }
}

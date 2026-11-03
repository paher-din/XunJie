// Acceptance-only preload. Keep payloads/credentials/reasoning in memory; persist bounded facts.
import { readFile, writeFile, rename } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';

export const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export const sha = value => createHash('sha256').update(value).digest('hex');
const witnessFile = process.env.XUNJIE_ACCEPTANCE_WITNESS_FILE;
if (witnessFile) {
  const original = globalThis.fetch;
  const allowed = new Set((process.env.XUNJIE_ACCEPTANCE_UPSTREAMS ?? '').split(','));
  let document;
  try { document = JSON.parse(await readFile(witnessFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; document = { requests: [] }; }
  async function persist() {
    const temporary = witnessFile + '.' + randomUUID() + '.tmp';
    await writeFile(temporary, JSON.stringify(document), { mode: 0o600 }); await rename(temporary, witnessFile);
  }
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (!allowed.has(request.url) || request.method !== 'POST') return original(input, init);
    if (document.requests.length >= Number(process.env.XUNJIE_ACCEPTANCE_MAX_REQUESTS ?? '5')) throw new Error('Acceptance generation limit reached');
    const payload = JSON.parse(await request.clone().text()), messages = payload.messages ?? [];
    const pending = new Set(), interruptions = [];
    for (const [index, message] of messages.entries()) {
      if (message.role === 'assistant') for (const call of message.tool_calls ?? []) pending.add(call.id);
      else if (message.role === 'tool') pending.delete(message.tool_call_id);
      else if (pending.size) interruptions.push(index);
    }
    const images = [];
    function scan(value) {
      if (!value || typeof value !== 'object') return;
      if (value.type === 'image_url' && typeof value.image_url?.url === 'string' && value.image_url.url.startsWith('data:image/png;base64,'))
        images.push(sha(Buffer.from(value.image_url.url.slice('data:image/png;base64,'.length), 'base64')));
      for (const item of Object.values(value)) if (item && typeof item === 'object') scan(item);
    }
    scan(payload);
    const fact = { number: document.requests.length + 1, endpoint: request.url, model: payload.model,
      assistantHashes: messages.filter(item => item.role === 'assistant').map(item => sha(canonical(item))),
      roles: messages.map(item => item.role), toolCalls: messages.filter(item => item.role === 'tool').map(item => item.tool_call_id),
      images, toolGroupInterruptions: interruptions, status: null };
    document.requests.push(fact); await persist();
    try { const response = await original(input, init); fact.status = response.status; await persist(); return response; }
    catch (error) { fact.transportError = error.name; await persist(); throw error; }
  };
}

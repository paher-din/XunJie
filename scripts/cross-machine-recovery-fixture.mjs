import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Controlled external model transport for the #212 cross-machine recovery acceptance.
// The first generation asks the original student question; later generations continue from the response.
const args = Object.fromEntries(process.argv.slice(2).map(item => {
  const [key, ...rest] = item.replace(/^--/, '').split('=');
  return [key, rest.join('=')];
}));
const port = Number(args.port ?? 47901), host = args.host ?? '127.0.0.1';
const state = resolve(args.state ?? 'fixture-state.json');
const payloads = [];
const save = () => writeFile(state, JSON.stringify({ requests: payloads.length,
  events: payloads.map((payload, index) => ({ index: index + 1, at: new Date().toISOString(),
    messageCount: payload.messages?.length ?? null })) }, null, 2) + '\n');
const reply = (response, value) => {
  const delta = { role: 'assistant', content: value.text ?? '', ...(value.calls ? { tool_calls: value.calls.map((call, index) => ({
    index, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) } : {}) };
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const chunk of [
    { id: 'cross-machine-recovery', choices: [{ index: 0, delta, finish_reason: null }] },
    { id: 'cross-machine-recovery', choices: [{ index: 0, delta: {}, finish_reason: value.calls ? 'tool_calls' : 'stop' }] },
    { choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } },
  ]) response.write('data: ' + JSON.stringify(chunk) + '\n\n');
  response.end('data: [DONE]\n\n');
};
const server = createServer(async (request, response) => {
  if (request.method !== 'POST' || !request.url.endsWith('/chat/completions')) { response.writeHead(404); response.end(); return; }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const payload = JSON.parse(Buffer.concat(chunks).toString());
  payloads.push(payload); await save();
  reply(response, payloads.length === 1 ? { calls: [{ id: 'cross-machine-question', name: 'student_ask',
    arguments: { question: '跨机恢复后仍回答这个原问题。', source: '固定学习依据', options: [], allowText: true, skippable: true } }] }
    : { text: '接管后按原回应与修订继续解释。' });
});
server.listen(port, host, () => console.log(JSON.stringify({ ready: true, host, port })));
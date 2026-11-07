import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map(item => {
  const [key, ...rest] = item.replace(/^--/, '').split('=');
  return [key, rest.join('=')];
}));
const port = Number(args.port ?? 47901), delay = Number(args['delay-ms'] ?? 15000);
const state = resolve(args.state ?? 'fixture-state.json');
let requests = 0;
const events = [];
const save = () => writeFile(state, JSON.stringify({ requests, events }, null, 2) + '\n');
const reply = (response, text) => {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const chunk of [
    { id: 'cross-machine', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] },
    { id: 'cross-machine', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } },
  ]) response.write('data: ' + JSON.stringify(chunk) + '\n\n');
  response.end('data: [DONE]\n\n');
};
const server = createServer(async (request, response) => {
  if (request.method !== 'POST' || !request.url.endsWith('/chat/completions')) {
    response.writeHead(404); response.end(); return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const payload = JSON.parse(Buffer.concat(chunks).toString());
  requests++;
  const event = { index: requests, at: new Date().toISOString(), delayMs: requests === 1 ? delay : 0,
    messageCount: payload.messages?.length ?? null };
  events.push(event); await save();
  if (requests === 1) await new Promise(done => setTimeout(done, delay));
  if (response.destroyed) return;
  reply(response, requests === 1 ? '原回答完成。' : '已按选择的输入继续。');
  await save();
});
server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ ready: true, port, delay })));

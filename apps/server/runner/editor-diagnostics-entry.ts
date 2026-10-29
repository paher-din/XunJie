import { connect } from 'node:net';
import { spawn } from 'node:child_process';

const [socketPath, originalEntry] = process.argv.slice(2);
const allowed = ['submit', 'query', 'cancel', 'readResult', 'readiness', 'hdl_readiness', 'hdl_build', 'hdl_program',
  'hdl_interact', 'hdl_query', 'hdl_stop', 'hdl_result', 'hdl_alu_probe', 'hdl_alu_check', 'hdl_alu_result'];
const forbidden = () => { process.stdout.write(JSON.stringify({ error: { code: 'FORBIDDEN', message: 'Fixed application operation required' } }) + '\n'); process.exit(1); };
if (!socketPath?.startsWith('/run/') || !originalEntry?.startsWith('/opt/xunjie-runner/') ||
  !['', 'xunjie-c1'].includes(process.env.SSH_ORIGINAL_COMMAND ?? '')) forbidden();
let body = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) { body += chunk; if (Buffer.byteLength(body) > 8 * 1024 * 1024) forbidden(); }
let request;
try { request = JSON.parse(body); } catch { forbidden(); }
if (!request || typeof request !== 'object' || Array.isArray(request) || ['actor', 'role', 'peer'].some(key => key in request)) forbidden();
function diagnosticRpc(value: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath!); let text = ''; socket.setEncoding('utf8');
    socket.setTimeout(25000, () => socket.destroy(new Error('Diagnostic service timeout')));
    socket.once('connect', () => socket.write(JSON.stringify(value) + '\n'));
    socket.on('data', chunk => { text += chunk; if (Buffer.byteLength(text) > 131072) socket.destroy(new Error('Diagnostic response limit')); });
    socket.once('error', reject); socket.once('end', () => resolve(text));
  });
}
if (request.op === 'editor_diagnostics') {
  try { process.stdout.write(await diagnosticRpc(request)); }
  catch { process.stdout.write(JSON.stringify({ error: { code: 'DEPENDENCY_UNAVAILABLE' } }) + '\n'); }
} else {
  if (!allowed.includes(request.op)) forbidden();
  if (['submit', 'hdl_build', 'hdl_program', 'hdl_alu_check'].includes(request.op)) {
    try { await diagnosticRpc({ op: 'preempt' }); } catch { /* The compiler also has an in-container deadline. */ }
  }
  // Original fixed SSH handler still validates and executes every existing command.
  const child = spawn(process.execPath, [originalEntry!], { env: process.env, stdio: ['pipe', 'inherit', 'inherit'] });
  child.stdin.on('error', () => {}); child.stdin.end(body);
  child.once('error', () => { process.exitCode = 1; }); child.once('close', code => { process.exitCode = code ?? 1; });
}

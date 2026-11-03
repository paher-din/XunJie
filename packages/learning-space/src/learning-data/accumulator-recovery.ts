/** Product code executed in the isolated child, never inside the browser or execution owner. */
export const recoverableAccumulatorSource = String.raw`
let value = 0, total = 0, applied = 0, seq = 0, mode = 'running', initialized = false;
const history = new Map();
const write = value => process.stdout.write(JSON.stringify(value) + '\n');
const state = () => ({ value, total, applied });
const snapshot = () => ({ formatVersion: 1, value, total, applied, mode });
const error = detail => write({ type: 'error', code: 'invalid-input', detail });
write({ type: 'ready', instanceId: process.env.XJ_SESSION_INSTANCE, observation: state() });
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  if (buffer.length > 65536) process.exit(2);
  for (;;) {
    const end = buffer.indexOf('\n'); if (end < 0) break;
    const line = buffer.slice(0,end); buffer = buffer.slice(end+1);
    let message; try { message = JSON.parse(line); } catch { error('消息格式无效。'); continue; }
    if (message.type === 'ready') { write({ type: 'ready', instanceId: process.env.XJ_SESSION_INSTANCE, observation: state() }); continue; }
    if (message.type === 'stop') { write({ type: 'stopped' }); process.exit(0); }
    if (message.type === 'status') { write({ type: 'status', observation: state(), sessionState: mode }); continue; }
    if (message.type === 'restore') {
      const s = message.snapshot;
      if (initialized || seq !== 0 || !s || s.formatVersion !== 1 || !Number.isInteger(s.value) || s.value < 0 || s.value > 3
        || !Number.isSafeInteger(s.total) || s.total < 0 || !Number.isSafeInteger(s.applied) || s.applied < 0
        || !['running','paused'].includes(s.mode) || Object.keys(s).sort().join(',') !== 'applied,formatVersion,mode,total,value') {
        error('检查点与模拟器版本不兼容。'); continue;
      }
      ({ value, total, applied, mode } = s); initialized = true;
      write({ type: 'restored', observation: state(), sessionState: mode }); continue;
    }
    if (message.type === 'reconcile') {
      const observation = history.get(message.controlId)?.reply;
      write({ type: 'reconcile', controlId: message.controlId, applied: !!observation, ...(observation ? { observation } : {}) }); continue;
    }
    if (!['input','control'].includes(message.type)) { error('未知会话操作。'); continue; }
    const effect = message.type === 'input' ? 'input' : message.effect;
    const fingerprint = JSON.stringify([effect, message.seq, message.parameters]);
    const previous = history.get(message.controlId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) error('同一操作身份不能改变参数。'); else write(previous.reply);
      continue;
    }
    if (message.seq !== seq + 1) { error('会话操作位置已变化。'); continue; }
    if (!['input','pause','resume','step','reset','checkpoint'].includes(effect)
      || (effect === 'input' && mode !== 'running') || (['step','checkpoint','resume'].includes(effect) && mode !== 'paused')
      || (effect === 'pause' && mode !== 'running')) { error('当前状态不允许此操作。'); continue; }
    const parameters = message.parameters;
    if (['input','step'].includes(effect)) {
      const amount = parameters?.value;
      if (!Number.isInteger(amount) || amount < 0 || amount > 99 || !Number.isSafeInteger(total + amount)
        || !Number.isSafeInteger(applied + 1) || Object.keys(parameters).length !== 1) { error('请输入 0 到 99 之间的整数。'); continue; }
      value = (value + amount) % 4; total += amount; applied++;
    } else if (!parameters || Array.isArray(parameters) || Object.keys(parameters).length) { error('此控制不接受参数。'); continue; }
    if (effect === 'pause') mode = 'paused';
    if (effect === 'resume') mode = 'running';
    if (effect === 'reset') { value = 0; total = 0; applied = 0; }
    seq = message.seq; initialized = true;
    const reply = { type: 'observation', seq, controlId: message.controlId, state: state(), at: new Date().toISOString(), sessionState: mode,
      ...(effect === 'checkpoint' ? { checkpoint: snapshot() } : {}) };
    history.set(message.controlId, { fingerprint, reply }); write(reply);
  }
});
process.stdin.on('end', () => process.exit(0));
`;

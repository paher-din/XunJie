import { randomUUID } from 'node:crypto';

/** External business boundary used ONLY by tests. Never imported by product packages. */
export function controlledActionReceiver(receiverId = 'controlled-agent') {
  const records = new Map(), inputs = new Map();
  let loseReply = false, offlineAfterLoss = false, unavailable = false, accepting;
  const identity = { receiverId, location: 'remote', kind: 'question' };
  function reachable() { if (unavailable) throw Object.assign(new Error('Controlled receiver outage'), { code: 'unavailable' }); }
  const result = (requestId, inputDigest, state) => ({ requestId, receiver: identity, inputDigest,
    state, receiptId: randomUUID(), detail: state === 'rejected' ? '接收方拒绝此动作' : '' });
  const check = (id, digest) => {
    const known = records.get(id);
    if (known && known.inputDigest !== digest) throw Object.assign(new Error('Identity changed'), { code: 'identity-conflict' });
    return known ?? null;
  };
  return {
    identity,
    async accept(input, inputDigest) {
      reachable();
      if (accepting) await accepting;
      const receipt = check(input.requestId, inputDigest) ?? result(input.requestId, inputDigest,
        input.draft.question === '拒绝此问题' ? 'rejected' : 'accepted');
      if (!records.has(input.requestId)) { records.set(input.requestId, receipt); inputs.set(input.requestId, structuredClone(input)); }
      if (loseReply) { loseReply = false; if (offlineAfterLoss) unavailable = true; throw new Error('Accepted, but response was lost'); }
      return structuredClone(receipt);
    },
    async query(id, digest) { reachable(); return structuredClone(check(id, digest)); },
    async cancel(id, digest) {
      reachable();
      const receipt = check(id, digest) ?? result(id, digest, 'cancelled');
      records.set(id, receipt); return structuredClone(receipt);
    },
    acceptedInput: id => structuredClone(inputs.get(id)),
    acceptedIds: () => [...records].filter(([, receipt]) => receipt.state === 'accepted').map(([id]) => id),
    loseNextReply(options = {}) { loseReply = true; offlineAfterLoss = options.offline === true; },
    offline(value) { unavailable = value; },
    holdAccept() { let release; accepting = new Promise(resolve => { release = resolve; }); return () => { accepting = undefined; release(); }; },
  };
}

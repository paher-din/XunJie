import assert from 'node:assert/strict';
import { createCancellationRunner } from '../../packages/agent-runtime/src/interruption.ts';
let state = 'pending';
let tasks = [];
const cancelled = [];
const scheduled = [];
const store = {
 async acknowledgeCancellation(_turn, delivered, done) { state = done ? 'delivered' : 'pending'; },
 async pendingCancellations() { return state === 'pending' ? [{sessionId:'session', turnId:'turn', delivered:[]}] : []; },
};
const port = { async listNonTerminal() { return tasks; }, async cancel(_session, task) { cancelled.push(task); } };
const timers = { setTimeout(fn, delay) { scheduled.push({fn, delay}); return 1; }, clearTimeout() {} };
const runner = createCancellationRunner(store, port, timers);
await runner.deliverTurn('session', 'turn');
assert.equal(state, 'delivered');
tasks = [{taskId:'accepted-after-stop'}];
await runner.resumePending();
await runner.drain();
assert.deepEqual(cancelled, []);
assert.equal(scheduled.length, 0);
console.log(JSON.stringify({scenario:'late acceptance after empty cancellation scan', state, remainingTasks:tasks, cancelled, scheduledRetries:scheduled.length}, null, 2));
runner.close();

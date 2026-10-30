import { openSyntheticDatabase, type SyntheticDatabase } from '../../server/db/transaction.ts';
import { createDesignVerificationApp } from '../../server/design/app.ts';

type Input = { kind: 'init'; file: string; origin: string; signingSecret: string; timestamp: number; generation: string }
  | { kind: 'request'; method: 'POST' | 'PATCH'; url: string; headers: Record<string, string>; payload: object }
  | { kind: 'hold' } | { kind: 'stop' };
let db: SyntheticDatabase | undefined;
let service: Awaited<ReturnType<typeof createDesignVerificationApp>> | undefined;
process.on('message', async (input: Input) => {
  try {
    if (input.kind === 'init') {
      db = openSyntheticDatabase(input.file);
      service = await createDesignVerificationApp({ db, origin: input.origin, signingSecret: input.signingSecret,
        now: () => input.timestamp, currentGeneration: () => input.generation });
      process.send?.({ kind: 'ready' });
    } else if (input.kind === 'request' && service) {
      const response = await service.app.inject({ method: input.method, url: input.url, headers: input.headers, payload: input.payload });
      process.send?.({ kind: 'response', statusCode: response.statusCode, body: response.body });
    } else if (input.kind === 'hold' && db) {
      db.withTransaction(tx => {
        tx.run('INSERT INTO courses(id) VALUES (?)', 'synthetic-busy-marker');
        process.send?.({ kind: 'holding' });
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
      });
      process.send?.({ kind: 'released' });
    } else if (input.kind === 'stop') {
      await service?.app.close(); db?.close(); process.exit(0);
    } else throw new Error('Invalid synthetic child instruction.');
  } catch {
    process.send?.({ kind: 'error' });
  }
});

import { z } from 'zod';
import { openSyntheticDatabase } from '../../server/db/transaction.ts';

process.once('message', (input: unknown) => {
  try {
    const command = z.strictObject({ file: z.string(), mode: z.enum(['commit', 'hold']), id: z.string() }).parse(input);
    const db = openSyntheticDatabase(command.file);
    db.withTransaction(tx => {
      tx.run('INSERT INTO courses(id) VALUES (?)', command.id);
      if (command.mode === 'hold') {
        process.send?.({ state: 'holding' });
        // Deliberately stop inside the transaction until the parent terminates this fault fixture.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      }
    });
    process.send?.({ state: 'committed' });
    setInterval(() => {}, 1000);
  } catch {
    process.send?.({ state: 'failed' });
    process.exitCode = 1;
    process.disconnect?.();
  }
});

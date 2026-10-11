import { openSyntheticDatabase } from '../db/transaction.ts';
import type { SyntheticDatabase } from '../db/transaction.ts';
import { createWorkspaceApp } from './application.ts';

type Input = { kind: 'init';file: string;origin: string;signingSecret: string;generation: string;timestamp: number }
  | { kind: 'request';url: string;headers: Record<string,string>;payload: object } | { kind: 'stop' };
let db: SyntheticDatabase | undefined;
let service: Awaited<ReturnType<typeof createWorkspaceApp>> | undefined;
process.on('message', async (input: Input) => {
  try {
    if (input.kind === 'init') {
      db = openSyntheticDatabase(input.file);
      service = await createWorkspaceApp({ db,origin: input.origin,signingSecret: input.signingSecret,
        currentGeneration: () => input.generation,now: () => input.timestamp });
      process.send?.({ kind: 'ready' });
    } else if (input.kind === 'request' && service) {
      const res = await service.app.inject({ method: 'POST',url: input.url,headers: input.headers,payload: input.payload });
      process.send?.({ kind: 'response',status: res.statusCode,body: res.body });
    } else if (input.kind === 'stop') {
      await service?.app.close(); db?.close(); process.exit(0);
    } else throw new Error('Invalid synthetic child instruction.');
  } catch { process.send?.({ kind: 'error' }); }
});

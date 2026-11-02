import { z } from 'zod';
import { StorageError, type OwnedStorage } from '@xunjie/storage';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import { modelScopeOf } from './selection.js';

export const modelRoutingMigrations = [{ version: 7, name: 'installed-client-model-route-bindings', sql: `
  CREATE TABLE model_client_routes(scope text NOT NULL,kind text NOT NULL,id uuid NOT NULL,body jsonb NOT NULL,PRIMARY KEY(scope,kind,id));
` }];
const bindingSchema = z.object({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/), destination: z.enum(['local', 'school']),
  schoolSource: z.object({ school: z.object({ connectionId: z.uuid(), version: z.number().int().positive() }).strict() }).strict().optional() }).strict();
export type ModelRouteBinding = z.infer<typeof bindingSchema>;
export function createModelRouting(storage: OwnedStorage, authorize: (identity: SpaceIdentity) => Promise<void>, assertWritable: () => void) {
  async function read(identity: SpaceIdentity, kind: 'attempt' | 'segment' | 'image', id: string) {
    await authorize(identity); z.uuid().parse(id);
    const { rows: [row] } = await storage.read('SELECT body FROM model_client_routes WHERE scope=$1 AND kind=$2 AND id=$3', [modelScopeOf(identity), kind, id]);
    return row ? bindingSchema.parse(row.body) : null;
  }
  async function bind(identity: SpaceIdentity, kind: 'attempt' | 'segment' | 'image', id: string, value: ModelRouteBinding) {
    assertWritable(); await authorize(identity); z.uuid().parse(id); const binding = bindingSchema.parse(value), scope = modelScopeOf(identity);
    const receipt = await storage.request({ requestId: 'model-client-route:' + scope + ':' + kind + ':' + id, fingerprint: binding.fingerprint }, async tx => {
      await tx.query('INSERT INTO model_client_routes VALUES($1,$2,$3,$4)', [scope, kind, id, binding]); return binding;
    });
    const saved = bindingSchema.parse(receipt.result);
    if (saved.fingerprint !== binding.fingerprint) throw new StorageError('identity-conflict');
    return saved;
  }
  async function validate() {
    const { rows } = await storage.read('SELECT body FROM model_client_routes'); for (const row of rows) bindingSchema.parse(row.body);
  }
  return { read, bind, validate };
}

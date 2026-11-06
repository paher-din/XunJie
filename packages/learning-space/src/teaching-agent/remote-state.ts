import { createHash } from 'node:crypto';
import { StorageError, type Migration, type OwnedStorage } from '@xunjie/storage';
import { runtimeConnectionSchema } from '@xunjie/contracts/product-runtime';
import { teachingDispatchAuthoritySchema } from '@xunjie/contracts/teaching-agent';
import type { z } from 'zod';
export { teachingDispatchAuthoritySchema } from '@xunjie/contracts/teaching-agent';

export const teachingDeploymentMigration: Migration = { version: 3, name: 'agent-dependency-identity-and-permits', sql: `
  CREATE TABLE teaching_dependency_bindings(name text PRIMARY KEY,body jsonb NOT NULL);
  ALTER TABLE teaching_steps ADD COLUMN dispatch_generation integer;
` };
export type TeachingDispatchAuthority = z.infer<typeof teachingDispatchAuthoritySchema>;

export function createTeachingDependencyBinding(storage: OwnedStorage) {
  return async (value: unknown) => {
    const connection = runtimeConnectionSchema.parse(value);
    const { rows: [row] } = await storage.read("SELECT body FROM teaching_dependency_bindings WHERE name='dependencies'");
    if (row) {
      if (JSON.stringify(row.body) !== JSON.stringify(connection)) {
        // PostgreSQL jsonb key order differs; compare the schema's stable field order.
        if (JSON.stringify(runtimeConnectionSchema.parse(row.body)) !== JSON.stringify(connection)) throw new StorageError('identity-conflict');
      }
      return connection;
    }
    await storage.request({ requestId: 'teaching-dependency-binding',
      fingerprint: createHash('sha256').update(JSON.stringify(connection)).digest('hex') }, async tx => {
      await tx.query("INSERT INTO teaching_dependency_bindings VALUES('dependencies',$1)", [connection]);
      return null;
    });
    return connection;
  };
}

export async function validateTeachingDependencyBindings(storage: OwnedStorage) {
  const { rows } = await storage.read('SELECT name,body FROM teaching_dependency_bindings');
  for (const row of rows) {
    const connection = runtimeConnectionSchema.parse(row.body);
    if (row.name !== 'dependencies' || connection.sourceEnvironmentId !== storage.owner.environmentId
      || connection.sourceServiceId !== storage.owner.serviceId || !connection.requiredCapabilities.includes('teaching.dependencies'))
      throw new StorageError('corrupt');
  }
}

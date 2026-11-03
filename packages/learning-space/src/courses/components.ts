import { createHash } from 'node:crypto';
import { z } from 'zod';
import { StorageError, type Migration, type OwnedStorage } from '@xunjie/storage';
import { componentImportSchema, componentDefinitionSchema, type ComponentDefinition } from '@xunjie/contracts/components';

export const componentMigration: Migration = { version: 7, name: 'immutable-course-components', sql: `
  CREATE TABLE course_components(component_id uuid NOT NULL,version integer NOT NULL,definition jsonb NOT NULL,
    PRIMARY KEY(component_id,version));
` };
export const componentStatusMigration: Migration = { version: 8, name: 'component-mount-availability', sql: `
  CREATE TABLE course_component_status(component_id uuid NOT NULL,version integer NOT NULL,enabled boolean NOT NULL,
    PRIMARY KEY(component_id,version),FOREIGN KEY(component_id,version) REFERENCES course_components(component_id,version));
` };
export const componentDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Course-owned definitions, independent of any student state. Resources share this owner's maintenance gate. */
export function createComponents(storage: OwnedStorage) {
  async function read(componentId: string, version: number): Promise<ComponentDefinition> {
    componentId = z.uuid().parse(componentId).toLowerCase();
    const { rows: [row] } = await storage.read('SELECT definition FROM course_components WHERE component_id=$1 AND version=$2', [componentId, version]);
    if (!row) throw new StorageError('missing');
    const result = componentDefinitionSchema.parse(row.definition);
    if (result.digest !== componentDigest(result.manifest) || result.manifest.componentId.toLowerCase() !== componentId || result.manifest.version !== version) throw new StorageError('corrupt');
    return result;
  }
  async function bytes(definition: ComponentDefinition) {
    const data = Buffer.from(await storage.readResource(definition.manifest.entry.resourceId));
    if (data.length !== definition.manifest.entry.byteLength || createHash('sha256').update(data).digest('hex') !== definition.manifest.entry.sha256
      || Buffer.from(data.toString('utf8')).compare(data) !== 0) throw new StorageError('corrupt');
    return data;
  }
  async function register(value: unknown) {
    const input = componentImportSchema.parse(value), { manifest } = input;
    const definition = { manifest, digest: componentDigest(manifest) };
    const fingerprint = componentDigest(definition);
    const data = Buffer.from(input.contentBase64, 'base64');
    if (data.toString('base64') !== input.contentBase64 || data.length !== manifest.entry.byteLength
      || createHash('sha256').update(data).digest('hex') !== manifest.entry.sha256
      || Buffer.from(data.toString('utf8')).compare(data) !== 0) throw new StorageError('invalid');
    const previous = await storage.receipt(input.requestId, fingerprint);
    if (previous) return componentDefinitionSchema.parse(previous.result);
    const resource = await storage.stageResource({ uploadId: manifest.entry.resourceId, scope: `component/${manifest.componentId}/${manifest.version}`,
      bytes: data, mediaType: 'text/html', contentVersion: 1 });
    if (resource.sha256 !== manifest.entry.sha256 || resource.byteLength !== manifest.entry.byteLength) throw new StorageError('invalid');
    const receipt = await storage.request({ requestId: input.requestId, fingerprint }, async tx => {
      await tx.query('INSERT INTO course_components VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [manifest.componentId, manifest.version, JSON.stringify(definition)]);
      const { rows: [row] } = await tx.query('SELECT definition FROM course_components WHERE component_id=$1 AND version=$2', [manifest.componentId, manifest.version]);
      if (!row || componentDefinitionSchema.parse(row.definition).digest !== definition.digest) throw new StorageError('identity-conflict');
      await tx.reference(`component/${manifest.componentId}/${manifest.version}`, manifest.entry.resourceId);
      return definition;
    });
    return componentDefinitionSchema.parse(receipt.result);
  }
  async function verify(expected: ComponentDefinition) {
    const actual = await read(expected.manifest.componentId, expected.manifest.version);
    if (actual.digest !== expected.digest || componentDigest(expected.manifest) !== expected.digest) throw new StorageError('identity-conflict');
    await bytes(actual);
    return actual;
  }
  async function assertEnabled(componentId: string, version: number) {
    const { rows: [row] } = await storage.read('SELECT enabled FROM course_component_status WHERE component_id=$1 AND version=$2', [componentId, version]);
    if (row && !row.enabled) throw new StorageError('unavailable');
  }
  async function setStatus(value: unknown) {
    const input = z.object({ requestId: z.uuid(), componentId: z.uuid(), version: z.number().int().positive(), enabled: z.boolean() }).strict().parse(value);
    await read(input.componentId, input.version);
    const receipt = await storage.request({ requestId: input.requestId, fingerprint: componentDigest(input) }, async tx => {
      await tx.query('INSERT INTO course_component_status VALUES($1,$2,$3) ON CONFLICT(component_id,version) DO UPDATE SET enabled=EXCLUDED.enabled',
        [input.componentId, input.version, input.enabled]);
      return { enabled: input.enabled };
    });
    return receipt.result;
  }
  async function validate() {
    const { rows } = await storage.read('SELECT component_id,version FROM course_components');
    for (const row of rows) {
      const definition = await read(String(row.component_id), Number(row.version));
      await bytes(definition);
      // Legacy manifests and their immutable digest/reference spelling must not be rewritten.
      const { rows: links } = await storage.read('SELECT resource_id FROM _storage_references WHERE reference_id=$1', [`component/${definition.manifest.componentId}/${row.version}`]);
      if (links.length !== 1 || links[0]!.resource_id !== definition.manifest.entry.resourceId) throw new StorageError('corrupt');
    }
  }
  return { read, bytes, register, verify, validate, assertEnabled, setStatus };
}

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
    const { rows: [row] } = await storage.read('SELECT definition FROM course_components WHERE component_id=$1 AND version=$2', [componentId, version]);
    if (!row) throw new StorageError('missing');
    const result = componentDefinitionSchema.parse(row.definition);
    if (result.digest !== componentDigest(result.manifest) || result.manifest.componentId !== componentId || result.manifest.version !== version) throw new StorageError('corrupt');
    return result;
  }
  async function resource(reference: { resourceId: string; sha256: string; byteLength: number }) {
    const data = Buffer.from(await storage.readResource(reference.resourceId));
    if (data.length !== reference.byteLength || createHash('sha256').update(data).digest('hex') !== reference.sha256)
      throw new StorageError('corrupt');
    return data;
  }
  async function bytes(definition: ComponentDefinition) {
    const data = await resource(definition.manifest.entry);
    // The view is served as HTML, so its bytes must survive a UTF-8 round trip unchanged.
    if (Buffer.from(data.toString('utf8')).compare(data) !== 0) throw new StorageError('corrupt');
    return data;
  }
  async function register(value: unknown) {
    const input = componentImportSchema.parse(value), { manifest } = input;
    const definition = { manifest, digest: componentDigest(manifest) };
    const fingerprint = componentDigest(definition);
    const uploads = [{ resource: manifest.entry, data: Buffer.from(input.contentBase64, 'base64'), encoding: input.contentBase64 },
      ...(manifest.algorithm && input.algorithmBase64 ? [{ resource: manifest.algorithm.resource,
        data: Buffer.from(input.algorithmBase64, 'base64'), encoding: input.algorithmBase64 }] : [])];
    for (const upload of uploads) {
      if (upload.data.toString('base64') !== upload.encoding || upload.data.length !== upload.resource.byteLength
        || createHash('sha256').update(upload.data).digest('hex') !== upload.resource.sha256) throw new StorageError('invalid');
    }
    const previous = await storage.receipt(input.requestId, fingerprint);
    if (previous) return componentDefinitionSchema.parse(previous.result);
    const scope = `component/${manifest.componentId}/${manifest.version}`;
    for (const upload of uploads) {
      const staged = await storage.stageResource({ uploadId: upload.resource.resourceId, scope,
        bytes: upload.data, mediaType: upload.resource.mediaType, contentVersion: 1 });
      if (staged.sha256 !== upload.resource.sha256 || staged.byteLength !== upload.resource.byteLength) throw new StorageError('invalid');
    }
    const receipt = await storage.request({ requestId: input.requestId, fingerprint }, async tx => {
      await tx.query('INSERT INTO course_components VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [manifest.componentId, manifest.version, JSON.stringify(definition)]);
      const { rows: [row] } = await tx.query('SELECT definition FROM course_components WHERE component_id=$1 AND version=$2', [manifest.componentId, manifest.version]);
      if (!row || componentDefinitionSchema.parse(row.definition).digest !== definition.digest) throw new StorageError('identity-conflict');
      await tx.reference(scope, manifest.entry.resourceId);
      if (manifest.algorithm) await tx.reference(`${scope}/algorithm`, manifest.algorithm.resource.resourceId);
      return definition;
    });
    return componentDefinitionSchema.parse(receipt.result);
  }
  async function verify(expected: ComponentDefinition) {
    const actual = await read(expected.manifest.componentId, expected.manifest.version);
    if (actual.digest !== expected.digest || componentDigest(expected.manifest) !== expected.digest) throw new StorageError('identity-conflict');
    await bytes(actual);
    // A pinned algorithm must still be the exact file the digest names.
    if (actual.manifest.algorithm) await resource(actual.manifest.algorithm.resource);
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
      const scope = `component/${row.component_id}/${row.version}`;
      const expected: { reference: string; resource: { resourceId: string; sha256: string; byteLength: number } }[] =
        [{ reference: scope, resource: definition.manifest.entry }];
      if (definition.manifest.algorithm) expected.push({ reference: `${scope}/algorithm`, resource: definition.manifest.algorithm.resource });
      for (const item of expected) {
        const { rows: links } = await storage.read('SELECT resource_id FROM _storage_references WHERE reference_id=$1', [item.reference]);
        if (links.length !== 1 || links[0]!.resource_id !== item.resource.resourceId) throw new StorageError('corrupt');
        await resource(item.resource);
      }
    }
  }
  return { read, bytes, resource, register, verify, validate, assertEnabled, setStatus };
}

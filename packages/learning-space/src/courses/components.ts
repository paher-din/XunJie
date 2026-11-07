import { createHash } from 'node:crypto';
import { z } from 'zod';
import { StorageError, type Migration, type OwnedStorage } from '@xunjie/storage';
import { componentImportSchema, componentDefinitionSchema, componentDependencyContentSchema,
  componentPreparationReportSchema, componentPreparationReportSubmissionSchema, componentPreparationReportsSchema,
  manifestDependencies, manifestResources, componentResourceReference, componentRuntimeResourceContentSchema,
  type ComponentDefinition, type ComponentPreparedManifest, type ComponentRuntimeManifest } from '@xunjie/contracts/components';

export const componentMigration: Migration = { version: 7, name: 'immutable-course-components', sql: `
  CREATE TABLE course_components(component_id uuid NOT NULL,version integer NOT NULL,definition jsonb NOT NULL,
    PRIMARY KEY(component_id,version));
` };
export const componentStatusMigration: Migration = { version: 8, name: 'component-mount-availability', sql: `
  CREATE TABLE course_component_status(component_id uuid NOT NULL,version integer NOT NULL,enabled boolean NOT NULL,
    PRIMARY KEY(component_id,version),FOREIGN KEY(component_id,version) REFERENCES course_components(component_id,version));
` };
/**
 * Preparation diagnostics submitted by one device under an explicit request identity. A row records what that
 * device observed; it is never a ready credential for another device and grants no installation or execution.
 */
export const componentReportMigration: Migration = { version: 9, name: 'component-preparation-reports', sql: `
  CREATE TABLE component_preparation_reports(report_id uuid PRIMARY KEY,
    component_id uuid NOT NULL,version integer NOT NULL,
    preparation_protocol_version integer NOT NULL,self_test_version integer NOT NULL,
    request_id uuid NOT NULL,fingerprint text NOT NULL,report jsonb NOT NULL,
    submitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY(component_id,version) REFERENCES course_components(component_id,version));
` };
export const componentDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const digestOf = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
/** Declared resources are text; bytes that are not valid UTF-8 are corrupt, not a different encoding. */
function verifiedText(base64: string, expected: { sha256: string; byteLength: number }): Buffer {
  const data = Buffer.from(base64, 'base64');
  if (data.toString('base64') !== base64 || data.length !== expected.byteLength
    || digestOf(data) !== expected.sha256 || Buffer.from(data.toString('utf8')).compare(data) !== 0) throw new StorageError('invalid');
  return data;
}
/** Binary resources are verified as bytes: decoding a WASM module as UTF-8 would reject valid files. */
function verifiedBytes(base64: string, expected: { sha256: string; byteLength: number }): Buffer {
  const data = Buffer.from(base64, 'base64');
  if (data.toString('base64') !== base64 || data.length !== expected.byteLength
    || digestOf(data) !== expected.sha256) throw new StorageError('invalid');
  return data;
}
/** Reports only exist for prepared components; a format 1 definition declares no preparation protocol. */
function prepared(manifest: ComponentDefinition['manifest']): ComponentPreparedManifest | ComponentRuntimeManifest {
  if (manifest.formatVersion === 1) throw new StorageError('invalid');
  return manifest;
}
/** Course-owned definitions, independent of any student state. Resources share this owner's maintenance gate. */
export function createComponents(storage: OwnedStorage) {
  async function read(componentId: string, version: number): Promise<ComponentDefinition> {
    componentId = z.uuid().parse(componentId).toLowerCase();
    const { rows: [row] } = await storage.read('SELECT definition FROM course_components WHERE component_id=$1 AND version=$2', [componentId, version]);
    if (!row) throw new StorageError('missing');
    const result = componentDefinitionSchema.parse(row.definition);
    if (result.digest !== componentDigest(result.manifest) || result.manifest.componentId.toLowerCase() !== componentId.toLowerCase() || result.manifest.version !== version) throw new StorageError('corrupt');
    return result;
  }
  async function resource(reference: { resourceId: string; sha256: string; byteLength: number }) {
    const data = Buffer.from(await storage.readResource(reference.resourceId));
    if (data.length !== reference.byteLength || createHash('sha256').update(data).digest('hex') !== reference.sha256)
      throw new StorageError('corrupt');
    return data;
  }
  async function resourceBytes(resourceId: string, expected: { sha256: string; byteLength: number }) {
    const data = await resource({ resourceId, ...expected });
    if (Buffer.from(data.toString('utf8')).compare(data) !== 0) throw new StorageError('corrupt');
    return data;
  }
  async function bytes(definition: ComponentDefinition) { return resourceBytes(definition.manifest.entry.resourceId, definition.manifest.entry); }
  /** Dependency bytes come from this owner's retained resource, re-verified per read; never from a client-supplied URL. */
  async function dependencyBytes(definition: ComponentDefinition, dependencyId: string) {
    const dependency = manifestDependencies(definition.manifest).find(item => item.dependencyId === dependencyId);
    if (!dependency) throw new StorageError('missing');
    return resourceBytes(dependency.resourceId, dependency);
  }
  async function dependencyContent(definition: ComponentDefinition, dependencyId: string) {
    const dependency = manifestDependencies(definition.manifest).find(item => item.dependencyId === dependencyId);
    if (!dependency) throw new StorageError('missing');
    const data = await dependencyBytes(definition, dependencyId);
    return componentDependencyContentSchema.parse({ dependencyId, resourceId: dependency.resourceId, sha256: dependency.sha256,
      byteLength: dependency.byteLength, mediaType: dependency.mediaType, contentBase64: data.toString('base64') });
  }
  /**
   * Every non-entry resource of a definition, addressed by the identity its own manifest declared. A
   * format 3 runtime is read this way: the host never fetches a course resource from a URL, and a
   * file whose digest no longer matches is refused instead of being run.
   */
  function declaredResource(definition: ComponentDefinition, selector: { path?: string; resourceId?: string }) {
    const found = manifestResources(definition.manifest).find(item => selector.path !== undefined
      ? 'path' in item && item.path === selector.path : item.resourceId === selector.resourceId);
    if (!found) throw new StorageError('missing');
    return found;
  }
  async function resourceContent(definition: ComponentDefinition, selector: { path?: string; resourceId?: string }) {
    const declared = declaredResource(definition, selector);
    // Only a format 3 runtime file reaches this reader; the v1/v2 dependency protocol has its own.
    if (declared.kind !== 'runtime') throw new StorageError('missing');
    const data = await resource(declared);
    return componentRuntimeResourceContentSchema.parse({ resourceId: declared.resourceId, path: declared.path,
      role: declared.role, sha256: declared.sha256, byteLength: declared.byteLength, mediaType: declared.mediaType,
      contentBase64: data.toString('base64') });
  }
  async function register(value: unknown) {
    const input = componentImportSchema.parse(value), { manifest } = input;
    const definition = { manifest, digest: componentDigest(manifest) };
    const fingerprint = componentDigest(definition);
    const uploads: { resource: { resourceId: string; sha256: string; byteLength: number; mediaType: string }; data: Buffer; encoding: string }[] = [{ resource: manifest.entry, data: Buffer.from(input.contentBase64, 'base64'), encoding: input.contentBase64 },
      ...(manifest.formatVersion === 1 && manifest.algorithm && input.algorithmBase64 ? [{ resource: manifest.algorithm.resource,
        data: Buffer.from(input.algorithmBase64, 'base64'), encoding: input.algorithmBase64 }] : [])];
    for (const upload of uploads) {
      if (upload.data.toString('base64') !== upload.encoding || upload.data.length !== upload.resource.byteLength
        || createHash('sha256').update(upload.data).digest('hex') !== upload.resource.sha256) throw new StorageError('invalid');
    }
    verifiedText(input.contentBase64, manifest.entry);
    const submitted = new Map((input.dependencies ?? []).map(item => [item.resourceId, item.contentBase64]));
    for (const dependency of manifestDependencies(manifest)) {
      const base64 = submitted.get(dependency.resourceId);
      if (base64 === undefined) throw new StorageError('invalid');
      uploads.push({ resource: dependency, data: verifiedText(base64, dependency), encoding: base64 });
    }
    // A format 3 runtime pins WASM and passive attachments too: those are verified as bytes, never as text,
    // and each one must be the exact file its own manifest names — a toolchain WASM included, because the six
    // toolchain files are the definition's own resources, not something the host is assumed to already own.
    const runtimeSubmitted = new Map((input.runtimeResources ?? []).map(item => [item.resourceId, item.contentBase64]));
    for (const item of manifestResources(manifest)) {
      if (item.kind !== 'runtime') continue;
      const base64 = runtimeSubmitted.get(item.resourceId);
      if (base64 === undefined) throw new StorageError('invalid');
      uploads.push({ resource: item, data: verifiedBytes(base64, item), encoding: base64 });
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
      // Every resource of one version is retained together; a partial set is an unusable definition.
      for (const item of manifestResources(manifest))
        await tx.reference(componentResourceReference(manifest, item), item.resourceId);
      return definition;
    });
    return componentDefinitionSchema.parse(receipt.result);
  }
  async function verify(expected: ComponentDefinition) {
    const actual = await read(expected.manifest.componentId, expected.manifest.version);
    if (actual.digest !== expected.digest || componentDigest(expected.manifest) !== expected.digest) throw new StorageError('identity-conflict');
    await bytes(actual);
    // Every pinned file must still be the exact bytes its digest names, and still be bound to this version.
    for (const item of manifestResources(actual.manifest)) {
      await resource(item);
      const { rows: retained } = await storage.read('SELECT resource_id FROM _storage_references WHERE reference_id=$1',
        [componentResourceReference(actual.manifest, item)]);
      if (retained.length !== 1 || retained[0]!.resource_id !== item.resourceId) throw new StorageError('corrupt');
    }
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
  async function submitReport(value: unknown) {
    const input = componentPreparationReportSubmissionSchema.parse(value), { report } = input;
    const definition = await read(report.componentId, report.version);
    if (definition.digest !== report.definitionDigest) throw new StorageError('identity-conflict');
    // Both prepared formats own a self-test and a protocol version; which one a report may declare is
    // decided by that manifest, so a v2 report cannot claim protocol 2 and a v3 one cannot fall back to 1.
    const manifest = prepared(definition.manifest);
    if (manifest.selfTest.selfTestVersion !== report.selfTestVersion
      || manifest.environment.preparationProtocolVersion !== report.preparationProtocolVersion) throw new StorageError('invalid');
    const fingerprint = componentDigest(report);
    const receipt = await storage.request({ requestId: input.requestId, fingerprint }, async tx => {
      await tx.query(`INSERT INTO component_preparation_reports(report_id,component_id,version,preparation_protocol_version,self_test_version,request_id,fingerprint,report)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(report_id) DO NOTHING`,
        [input.reportId, report.componentId, report.version, report.preparationProtocolVersion, report.selfTestVersion,
          input.requestId, fingerprint, JSON.stringify(report)]);
      const { rows: [row] } = await tx.query('SELECT report FROM component_preparation_reports WHERE report_id=$1', [input.reportId]);
      if (!row || componentDigest(componentPreparationReportSchema.parse(row.report)) !== fingerprint) throw new StorageError('identity-conflict');
      return { reportId: input.reportId, report };
    });
    return receipt.result;
  }
  /** Most recent first: callers read what devices actually reported, never a synthesized readiness. */
  async function readReports(componentId: string, version: number) {
    await read(componentId, version);
    const { rows } = await storage.read(`SELECT report FROM component_preparation_reports
      WHERE component_id=$1 AND version=$2 ORDER BY submitted_at DESC, report_id DESC LIMIT 50`, [componentId, version]);
    return componentPreparationReportsSchema.parse(rows.map(row => componentPreparationReportSchema.parse(row.report)));
  }
  async function validate() {
    const { rows } = await storage.read('SELECT component_id,version FROM course_components');
    for (const row of rows) {
      const definition = await read(String(row.component_id), Number(row.version));
      await bytes(definition);
      const scope = `component/${definition.manifest.componentId}/${row.version}`;
      const expected = [{ reference: scope, resource: definition.manifest.entry },
        ...manifestResources(definition.manifest).map(item => ({ reference: componentResourceReference(definition.manifest, item),
          resource: item }))];
      for (const item of expected) {
        const { rows: links } = await storage.read('SELECT resource_id FROM _storage_references WHERE reference_id=$1', [item.reference]);
        if (links.length !== 1 || links[0]!.resource_id !== item.resource.resourceId) throw new StorageError('corrupt');
        await resource(item.resource);
      }
    }
    const { rows: reports } = await storage.read(`SELECT report_id,component_id,version,preparation_protocol_version,self_test_version,fingerprint,report
      FROM component_preparation_reports`);
    for (const row of reports) {
      const report = componentPreparationReportSchema.parse(row.report);
      if (report.componentId !== row.component_id || report.version !== Number(row.version)
        || report.preparationProtocolVersion !== Number(row.preparation_protocol_version)
        || report.selfTestVersion !== Number(row.self_test_version) || componentDigest(report) !== row.fingerprint) throw new StorageError('corrupt');
      if ((await read(report.componentId, report.version)).digest !== report.definitionDigest) throw new StorageError('corrupt');
    }
  }
  return { read, bytes, resource, dependencyBytes, dependencyContent, resourceContent, register, verify, validate, assertEnabled, setStatus, submitReport, readReports };
}

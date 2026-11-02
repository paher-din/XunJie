import { createHash } from 'node:crypto';
import { z } from 'zod';
import { StorageError, type Migration, type OwnedStorage } from '@xunjie/storage';
import { componentImportSchema, componentDefinitionSchema, componentDependencyContentSchema,
  componentPreparationReportSchema, componentPreparationReportSubmissionSchema, componentPreparationReportsSchema,
  manifestDependencies, componentDependencyReference,
  type ComponentDefinition, type ComponentPreparedManifest } from '@xunjie/contracts/components';

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
/** Reports only exist for prepared components; a format 1 definition declares no preparation protocol. */
function prepared(manifest: ComponentDefinition['manifest']): ComponentPreparedManifest {
  if (manifest.formatVersion === 1) throw new StorageError('invalid');
  return manifest;
}
/** Course-owned definitions, independent of any student state. Resources share this owner's maintenance gate. */
export function createComponents(storage: OwnedStorage) {
  async function read(componentId: string, version: number): Promise<ComponentDefinition> {
    const { rows: [row] } = await storage.read('SELECT definition FROM course_components WHERE component_id=$1 AND version=$2', [componentId, version]);
    if (!row) throw new StorageError('missing');
    const result = componentDefinitionSchema.parse(row.definition);
    if (result.digest !== componentDigest(result.manifest) || result.manifest.componentId !== componentId || result.manifest.version !== version) throw new StorageError('corrupt');
    return result;
  }
  async function resourceBytes(resourceId: string, expected: { sha256: string; byteLength: number }) {
    const data = Buffer.from(await storage.readResource(resourceId));
    if (data.length !== expected.byteLength || digestOf(data) !== expected.sha256
      || Buffer.from(data.toString('utf8')).compare(data) !== 0) throw new StorageError('corrupt');
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
  async function register(value: unknown) {
    const input = componentImportSchema.parse(value), { manifest } = input;
    const definition = { manifest, digest: componentDigest(manifest) };
    const fingerprint = componentDigest(definition);
    const entry = verifiedText(input.contentBase64, manifest.entry);
    const submitted = new Map((input.dependencies ?? []).map(item => [item.resourceId, item.contentBase64]));
    const resources = manifestDependencies(manifest).map(dependency => {
      const base64 = submitted.get(dependency.resourceId);
      if (base64 === undefined) throw new StorageError('invalid');
      return { dependency, data: verifiedText(base64, dependency) };
    });
    const previous = await storage.receipt(input.requestId, fingerprint);
    if (previous) return componentDefinitionSchema.parse(previous.result);
    const scope = `component/${manifest.componentId}/${manifest.version}`;
    const staged = await storage.stageResource({ uploadId: manifest.entry.resourceId, scope, bytes: entry, mediaType: 'text/html', contentVersion: 1 });
    if (staged.sha256 !== manifest.entry.sha256 || staged.byteLength !== manifest.entry.byteLength) throw new StorageError('invalid');
    for (const { dependency, data } of resources) {
      const resource = await storage.stageResource({ uploadId: dependency.resourceId, scope, bytes: data, mediaType: dependency.mediaType, contentVersion: 1 });
      if (resource.sha256 !== dependency.sha256 || resource.byteLength !== dependency.byteLength) throw new StorageError('invalid');
    }
    const receipt = await storage.request({ requestId: input.requestId, fingerprint }, async tx => {
      await tx.query('INSERT INTO course_components VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [manifest.componentId, manifest.version, JSON.stringify(definition)]);
      const { rows: [row] } = await tx.query('SELECT definition FROM course_components WHERE component_id=$1 AND version=$2', [manifest.componentId, manifest.version]);
      if (!row || componentDefinitionSchema.parse(row.definition).digest !== definition.digest) throw new StorageError('identity-conflict');
      await tx.reference(scope, manifest.entry.resourceId);
      // Every resource of one version is retained together; a partial set is an unusable definition.
      for (const { dependency } of resources)
        await tx.reference(componentDependencyReference(manifest.componentId, manifest.version, dependency.dependencyId), dependency.resourceId);
      return definition;
    });
    return componentDefinitionSchema.parse(receipt.result);
  }
  async function verify(expected: ComponentDefinition) {
    const actual = await read(expected.manifest.componentId, expected.manifest.version);
    if (actual.digest !== expected.digest || componentDigest(expected.manifest) !== expected.digest) throw new StorageError('identity-conflict');
    await bytes(actual);
    for (const dependency of manifestDependencies(actual.manifest)) await dependencyBytes(actual, dependency.dependencyId);
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
      const { rows: links } = await storage.read('SELECT resource_id FROM _storage_references WHERE reference_id=$1', [`component/${row.component_id}/${row.version}`]);
      if (links.length !== 1 || links[0]!.resource_id !== definition.manifest.entry.resourceId) throw new StorageError('corrupt');
      for (const dependency of manifestDependencies(definition.manifest)) {
        await dependencyBytes(definition, dependency.dependencyId);
        const { rows: retained } = await storage.read('SELECT resource_id FROM _storage_references WHERE reference_id=$1',
          [componentDependencyReference(String(row.component_id), Number(row.version), dependency.dependencyId)]);
        if (retained.length !== 1 || retained[0]!.resource_id !== dependency.resourceId) throw new StorageError('corrupt');
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
  return { read, bytes, dependencyBytes, dependencyContent, register, verify, validate, assertEnabled, setStatus, submitReport, readReports };
}

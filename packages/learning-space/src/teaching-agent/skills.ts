import { createHash } from 'node:crypto';
import { z } from 'zod';
import { StorageError, type OwnedStorage, type OwnedTransaction, type Migration } from '@xunjie/storage';
import { spaceIdentitySchema, type SpaceIdentity } from '@xunjie/contracts/spaces';
import type { LearningActivity } from '@xunjie/contracts/learning-data';
import { teachingSkillImportSchema, teachingSkillSelectSchema, teachingSkillDisableSchema, teachingSkillReferencesSchema,
  teachingSkillPathSchema, teachingSkillLoadSchema, teachingSkillLoadedSchema, courseSkillPackagesSchema, teachingSkillLimits,
  type TeachingSkillImport, type TeachingSkillReference, type TeachingSkillVersion, type TeachingSkillCatalogEntry,
  type TeachingSkillState, type TeachingSkillLoaded, type TeachingSkillLoad, type CourseSkillPackage,
  type TeachingSkillUnavailable, type TeachingSkillRange } from '@xunjie/contracts/agent-skills';
import { canonicalDigest, operationId } from './identity.js';
import { parseTeachingSkillPackage, validateTeachingSkillVersion, skillFileBytes, parseStoredTeachingSkillLoad } from './skills-package.js';

export const teachingSkillsMigration: Migration = { version: 11, name: 'independent-fixed-skill-packages', sql: `
  CREATE TABLE teaching_skills(owner_key text NOT NULL,skill_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),
    disabled boolean NOT NULL DEFAULT false,PRIMARY KEY(owner_key,skill_id));
  CREATE TABLE teaching_skill_versions(owner_key text NOT NULL,skill_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),
    body jsonb NOT NULL,PRIMARY KEY(owner_key,skill_id,version),
    FOREIGN KEY(owner_key,skill_id) REFERENCES teaching_skills(owner_key,skill_id));
  CREATE TABLE teaching_skill_selections(owner_key text NOT NULL,range_key text NOT NULL,body jsonb NOT NULL,
    PRIMARY KEY(owner_key,range_key));
  CREATE TABLE teaching_skill_loads(command_id uuid PRIMARY KEY,owner_key text NOT NULL,activity_id uuid NOT NULL,
    run_id uuid NOT NULL,step_id uuid NOT NULL,fingerprint text NOT NULL,body jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp());
` };

export class TeachingSkillError extends Error {
  constructor(readonly unavailable: TeachingSkillUnavailable) { super(unavailable.reason + ': ' + unavailable.detail); this.name = 'TeachingSkillError'; }
}
export interface TeachingSkillsScope {
  identity: SpaceIdentity;
  activity: LearningActivity;
  input?: { draft: { skills?: TeachingSkillReference[] | undefined } };
  courseSkills?: CourseSkillPackage[];
  assertDispatch?: () => Promise<void>;
}
export type TeachingSkillsGuard = { assertDispatch?: () => Promise<void>; toolNames?: string[]; references?: TeachingSkillReference[] | undefined };
type Guard = TeachingSkillsGuard;
type Query = OwnedStorage['read'];
type Candidate = { fixed: TeachingSkillVersion; entry: TeachingSkillCatalogEntry; ownerKey?: string };
const key = (identity: SpaceIdentity) => [identity.environmentId, identity.spaceId, identity.principalId].join('/');
const person = (identity: SpaceIdentity) => [identity.environmentId, identity.principalId].join('/');
// Keep historical owner keys intact for receipts/recovery, but a personal library spans spaces.
const personalOwnerFilter = "split_part(owner_key,'/',1)||'/'||split_part(owner_key,'/',3)=ANY($1::text[])";
const same = (a: SpaceIdentity, b: SpaceIdentity) => key(a) === key(b);
const rangeKey = (range: TeachingSkillRange) => range.kind === 'course' ? 'course:' + range.courseId
  : range.kind === 'activity' ? 'activity:' + range.activityId : range.kind;
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const unavailable = (reason: TeachingSkillUnavailable['reason'], detail: string): TeachingSkillUnavailable => ({ reason, detail });
const supportedCompatibility = new Set(['xunjie', 'xunjie-teaching-agent', 'xunjie-teaching-agent-v1']);
const matches = (reference: string, other: Candidate) => reference === other.fixed.skillId || reference === other.fixed.metadata.name
  || reference === other.fixed.metadata.name + '@' + other.fixed.packageVersion || reference === other.fixed.skillId + '@' + other.fixed.packageVersion;
function meta(fixed: TeachingSkillVersion, origin: 'personal' | 'course', selected: boolean, disabled = false, required = false): TeachingSkillCatalogEntry {
  const { files: _files, ...rest } = fixed;
  return { ...rest, name: fixed.metadata.name, description: fixed.metadata.description, origin, selected, disabled, required,
    ...(disabled ? { unavailable: unavailable('disabled', 'The personal skill is disabled') }
      : !selected ? { unavailable: unavailable('not-selected', 'This version is not selected in the current scope') } : {}) };
}
function missingMeta(ref: TeachingSkillReference, why: TeachingSkillUnavailable, origin: 'personal' | 'course' = 'personal',
  source = '', packageVersion = '', required = false): TeachingSkillCatalogEntry {
  return { ...ref, name: ref.skillId, description: '', source, packageVersion, digest: sha(Buffer.alloc(0)),
    metadata: { name: 'unavailable', description: 'Unavailable skill', dependencies: [], conflicts: [], 'allowed-tools': [] },
    attachments: [], selected: true, disabled: false, required, origin, unavailable: why };
}

/** Independent configuration owner. Packages never become system rules or executable tools. */
export function createTeachingSkills(storage: OwnedStorage, options: {
  authorize(identity: SpaceIdentity): Promise<void>;
  activity(identity: SpaceIdentity, activityId: string): Promise<LearningActivity>;
  assertWritable(): void | Promise<void>;
  /** Trusted host association: a device's own personal identity and its connected school identities. */
  personalOwners?(identity: SpaceIdentity): Promise<SpaceIdentity[]>;
}) {
  async function authorize(identity: SpaceIdentity) { spaceIdentitySchema.parse(identity); await options.authorize(identity); }
  async function owners(identity: SpaceIdentity) {
    const identities = options.personalOwners ? await options.personalOwners(identity) : [identity];
    if (!identities.length) throw new StorageError('forbidden');
    return identities.map(value => spaceIdentitySchema.parse(value));
  }
  const subjects = async (identity: SpaceIdentity) => [...new Set((await owners(identity)).map(person))];
  async function activity(identity: SpaceIdentity, activityId: string) {
    z.uuid().parse(activityId);
    const value = await options.activity(identity, activityId);
    if (!same(value.identity, identity) || value.activityId !== activityId) throw new StorageError('forbidden');
    if (value.status !== 'open') throw new StorageError('forbidden');
    return value as TeachingSkillsScope['activity'];
  }
  async function lock(tx: OwnedTransaction, identity: SpaceIdentity) {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['teaching-skills:' + person((await owners(identity))[0]!)]);
  }
  async function write(identity: SpaceIdentity, requestId: string, input: unknown, effect: (tx: OwnedTransaction) => Promise<unknown>) {
    await authorize(identity); await options.assertWritable();
    return storage.request({ requestId: 'skills:' + requestId, fingerprint: canonicalDigest({ owner: key(identity), input }) }, async tx => {
      await lock(tx, identity); await authorize(identity); await options.assertWritable(); return effect(tx);
    });
  }
  async function personal(identity: SpaceIdentity, query: Query = storage.read.bind(storage)) {
    const { rows } = await query(`SELECT v.owner_key,v.body,s.disabled,s.version AS current_version FROM teaching_skill_versions v
      JOIN teaching_skills s USING(owner_key,skill_id) WHERE ${personalOwnerFilter} ORDER BY v.skill_id,v.version`, [await subjects(identity)]);
    return rows.map(row => ({ ownerKey: String(row.owner_key), fixed: validateTeachingSkillVersion(row.body),
      disabled: Boolean(row.disabled), current: Number(row.current_version) }));
  }
  async function build(scope: TeachingSkillsScope, toolNames?: string[], query: Query = storage.read.bind(storage)) {
    const { identity } = scope, current = scope.activity;
    const candidates: Candidate[] = [];
    const explicit = teachingSkillReferencesSchema.parse(scope.input?.draft.skills ?? []);
    let versions: Awaited<ReturnType<typeof personal>> = [];
    let ownerUnavailable = false;
    try {
      versions = await personal(identity, query);
    } catch (error) {
      if (!(error instanceof StorageError) || !['missing', 'unavailable'].includes(error.code)) throw error;
      ownerUnavailable = true;
    }
    // Imports are enabled globally. A question pin fixes that skill's version, without hiding
    // other enabled personal skills; an empty question selection is not a global opt-out.
    const selected: TeachingSkillReference[] = [...explicit, ...versions.filter(item => !item.disabled
      && item.fixed.version === item.current && !explicit.some(ref => ref.skillId === item.fixed.skillId))
      .map(item => ({ skillId: item.fixed.skillId, version: item.fixed.version }))];
    for (const item of versions) {
      const chosen = selected.some(ref => ref.skillId === item.fixed.skillId && ref.version === item.fixed.version);
      if (chosen || item.fixed.version === item.current) candidates.push({ fixed: item.fixed, ownerKey: item.ownerKey,
        entry: meta(item.fixed, 'personal', chosen, item.disabled) });
    }
    // Report explicit references that no longer have an owned package, without hiding unrelated skills.
    const missing: TeachingSkillCatalogEntry[] = [];
    for (const ref of selected) if (!versions.some(item => item.fixed.skillId === ref.skillId && item.fixed.version === ref.version)
      && !missing.some(item => item.skillId === ref.skillId && item.version === ref.version)) {
      missing.push(missingMeta(ref, unavailable(ownerUnavailable ? 'owner-unavailable'
        : versions.some(item => item.fixed.skillId === ref.skillId) ? 'version-missing' : 'skill-missing', ref.skillId + '@' + ref.version)));
    }
    if (ownerUnavailable && !missing.length) missing.push(missingMeta({ skillId: operationId('skills-owner:' + key(identity)), version: 1 },
      unavailable('owner-unavailable', 'Personal skill catalog is temporarily unavailable')));
    for (const item of courseSkillPackagesSchema.parse(scope.courseSkills ?? current.course?.skills ?? [])) {
      try {
        const fixed = { ...parseTeachingSkillPackage({ source: item.source, packageVersion: item.packageVersion,
          files: item.files, requestId: item.skillId }), skillId: item.skillId, version: item.version };
        candidates.push({ fixed, entry: meta(fixed, 'course', true, false, item.required) });
      } catch {
        missing.push(missingMeta(item, unavailable('invalid-package', 'Invalid fixed course package'), 'course',
          item.source, item.packageVersion, item.required));
      }
    }
    const selectedCandidates = candidates.filter(item => item.entry.selected);
    for (const candidate of selectedCandidates) {
      const { entry, fixed } = candidate;
      if (entry.unavailable) continue;
      const compatibility = fixed.metadata.compatibility?.trim();
      if (compatibility && !supportedCompatibility.has(compatibility.toLowerCase()))
        entry.unavailable = unavailable('compatibility-unsupported', compatibility);
      else if (toolNames && fixed.metadata['allowed-tools'].some(name => !toolNames.includes(name)))
        entry.unavailable = unavailable('tool-unavailable', fixed.metadata['allowed-tools'].filter(name => !toolNames.includes(name)).join(', '));
      const duplicate = selectedCandidates.find(other => other !== candidate && other.fixed.skillId === fixed.skillId
        && (other.fixed.version !== fixed.version || other.fixed.digest !== fixed.digest));
      const conflict = selectedCandidates.find(other => other !== candidate && (fixed.metadata.conflicts.some(ref => matches(ref, other))
        || other.fixed.metadata.conflicts.some(ref => matches(ref, candidate))));
      if (!entry.unavailable && (duplicate || conflict)) entry.unavailable = unavailable('conflict', (duplicate ?? conflict)!.fixed.metadata.name);
      if (!entry.unavailable) for (const dependency of fixed.metadata.dependencies) if (!selectedCandidates.some(other => matches(dependency, other))) {
        entry.unavailable = unavailable('dependency-missing', dependency); break;
      }
    }
    // Propagate unavailable dependencies to a fixed point, independent of catalog order.
    for (let pass = 0; pass < selectedCandidates.length; pass++) for (const candidate of selectedCandidates) {
      if (candidate.entry.unavailable) continue;
      const blocked = candidate.fixed.metadata.dependencies.find(ref => selectedCandidates.some(other => other.entry.unavailable && matches(ref, other)));
      if (blocked) candidate.entry.unavailable = unavailable('dependency-unavailable', blocked);
    }
    return { candidates, state: { catalog: [...candidates.map(item => item.entry), ...missing], loaded: [] } as TeachingSkillState };
  }
  async function resolve(scope: TeachingSkillsScope, toolNames?: string[]): Promise<TeachingSkillState> {
    await authorize(scope.identity); await scope.assertDispatch?.();
    const fresh = await activity(scope.identity, scope.activity.activityId);
    const result = await build({ ...scope, activity: fresh }, toolNames);
    await scope.assertDispatch?.(); return result.state;
  }
  async function inspect(identity: SpaceIdentity, activityId: string, ref: TeachingSkillReference, path: string, guard: Guard = {}, query?: Query) {
    await authorize(identity); await guard.assertDispatch?.();
    const current = await activity(identity, activityId);
    const result = await build({ identity, activity: current,
      ...(guard.references ? { input: { draft: { skills: guard.references } } } : {}) }, guard.toolNames, query);
    const candidates = result.candidates.filter(item => item.fixed.skillId === ref.skillId && item.fixed.version === ref.version
      && item.entry.selected && !item.entry.unavailable);
    if (!candidates.length) {
      const entry = result.state.catalog.find(item => item.skillId === ref.skillId && item.version === ref.version);
      throw new TeachingSkillError(entry?.unavailable ?? unavailable('not-selected', ref.skillId + '@' + ref.version));
    }
    const candidate = candidates[0]!;
    const file = candidate.fixed.files.find(item => item.path === teachingSkillPathSchema.parse(path));
    if (!file) throw new StorageError('missing');
    await guard.assertDispatch?.(); return { candidate, file };
  }
  function chunk(candidate: Candidate, file: TeachingSkillImport['files'][number], offset: number, length: number): TeachingSkillLoaded {
    const bytes = skillFileBytes(file);
    if (offset > bytes.length) throw new StorageError('invalid');
    const part = bytes.subarray(offset, Math.min(bytes.length, offset + length));
    const text = part.toString('utf8'), encoding = file.encoding === 'utf8' && Buffer.from(text).equals(part) ? 'utf8' : 'base64';
    const fixed = candidate.fixed;
    return { skillId: fixed.skillId, version: fixed.version, source: fixed.source, packageVersion: fixed.packageVersion,
      packageDigest: fixed.digest, path: file.path, encoding, mediaType: candidate.fixed.attachments.find(item => item.path === file.path)!.mediaType,
      byteLength: part.length, digest: sha(part), originalDigest: sha(bytes), content: encoding === 'utf8' ? text : part.toString('base64'),
      offset, totalByteLength: bytes.length, complete: offset === 0 && part.length === bytes.length };
  }
  return {
    resolve,
    async import(identity: SpaceIdentity, value: unknown): Promise<TeachingSkillCatalogEntry> {
      const input = teachingSkillImportSchema.parse(value), parsed = parseTeachingSkillPackage(input);
      const primary = (await owners(identity))[0]!;
      const skillId = input.skillId ?? operationId('teaching-skill:' + person(primary) + ':' + input.requestId);
      const receipt = await write(identity, input.requestId, { operation: 'import', input }, async tx => {
        const people = await subjects(identity);
        const { rows: [prior] } = await tx.query(`SELECT owner_key,version,disabled FROM teaching_skills WHERE ${personalOwnerFilter} AND skill_id=$2`, [people, skillId]);
        const ownerKey = prior ? String(prior.owner_key) : key(primary);
        if (input.skillId && !prior) throw new StorageError('missing');
        if (prior) {
          const { rows: history } = await tx.query('SELECT body FROM teaching_skill_versions WHERE owner_key=$1 AND skill_id=$2', [ownerKey, skillId]);
          const fixed = history.map(row => validateTeachingSkillVersion(row.body));
          if (fixed.some(item => item.source !== input.source)) throw new StorageError('identity-conflict');
          const published = fixed.find(item => item.packageVersion === input.packageVersion);
          if (published) {
            if (published.digest !== parsed.digest) throw new StorageError('identity-conflict');
            await tx.query('UPDATE teaching_skills SET disabled=false WHERE owner_key=$1 AND skill_id=$2', [ownerKey, skillId]);
            return meta(published, 'personal', true);
          }
        }
        if (!prior) {
          const { rows } = await tx.query(`SELECT skill_id FROM teaching_skills WHERE ${personalOwnerFilter}`, [people]);
          if (rows.length >= teachingSkillLimits.skills) throw new StorageError('invalid');
        }
        const version = prior ? Number(prior.version) + 1 : 1;
        if (version > teachingSkillLimits.versions) throw new StorageError('invalid');
        const fixed = { ...parsed, skillId, version };
        await tx.query(`INSERT INTO teaching_skills(owner_key,skill_id,version) VALUES($1,$2,$3)
          ON CONFLICT(owner_key,skill_id) DO UPDATE SET version=EXCLUDED.version,disabled=false`, [ownerKey, skillId, version]);
        await tx.query('INSERT INTO teaching_skill_versions(owner_key,skill_id,version,body) VALUES($1,$2,$3,$4)',
          [ownerKey, skillId, version, JSON.stringify(fixed)]);
        return meta(fixed, 'personal', true);
      });
      return receipt.result as TeachingSkillCatalogEntry;
    },
    async select(identity: SpaceIdentity, value: unknown) {
      const input = teachingSkillSelectSchema.parse(value);
      if (input.range.kind === 'activity') await activity(identity, input.range.activityId);
      const receipt = await write(identity, input.requestId, { operation: 'select', input }, async tx => {
        const versions = await personal(identity, tx.query.bind(tx));
        for (const ref of input.skills) if (!versions.some(item => item.fixed.skillId === ref.skillId && item.fixed.version === ref.version && !item.disabled))
          throw new StorageError('missing');
        const { rows } = await tx.query('SELECT range_key FROM teaching_skill_selections WHERE owner_key=$1', [key(identity)]);
        if (rows.length >= 64 && !rows.some(row => row.range_key === rangeKey(input.range))) throw new StorageError('invalid');
        await tx.query(`INSERT INTO teaching_skill_selections(owner_key,range_key,body) VALUES($1,$2,$3)
          ON CONFLICT(owner_key,range_key) DO UPDATE SET body=EXCLUDED.body`, [key(identity), rangeKey(input.range), JSON.stringify(input)]);
        const { rows: saved } = await tx.query('SELECT body FROM teaching_skill_selections WHERE owner_key=$1 ORDER BY range_key', [key(identity)]);
        const selections = saved.map(row => { const { range, skills } = teachingSkillSelectSchema.parse(row.body); return { range, skills }; });
        // Legacy selection receipts remain readable, but no longer gate runtime availability.
        return { skills: versions.filter(item => item.fixed.version === item.current)
          .map(item => meta(item.fixed, 'personal', !item.disabled, item.disabled)), selections };
      });
      return receipt.result as { skills: TeachingSkillCatalogEntry[]; selections: { range: TeachingSkillRange; skills: TeachingSkillReference[] }[] };
    },
    async disable(identity: SpaceIdentity, value: unknown): Promise<TeachingSkillCatalogEntry> {
      const input = teachingSkillDisableSchema.parse(value);
      const receipt = await write(identity, input.requestId, { operation: 'disable', input }, async tx => {
        const { rows } = await tx.query(`UPDATE teaching_skills SET disabled=$3 WHERE ${personalOwnerFilter} AND skill_id=$2 RETURNING version`,
          [await subjects(identity), input.skillId, input.disabled]);
        if (!rows.length) throw new StorageError('missing');
        const versions = await personal(identity, tx.query.bind(tx));
        return meta(versions.find(item => item.fixed.skillId === input.skillId && item.fixed.version === Number(rows[0]!.version))!.fixed,
          'personal', !input.disabled, input.disabled);
      });
      return receipt.result as TeachingSkillCatalogEntry;
    },
    async list(identity: SpaceIdentity, activityId?: string): Promise<{ skills: TeachingSkillCatalogEntry[];
      selections: { range: TeachingSkillRange; skills: TeachingSkillReference[] }[] }> {
      await authorize(identity);
      const { rows } = await storage.read('SELECT body FROM teaching_skill_selections WHERE owner_key=$1 ORDER BY range_key', [key(identity)]);
      const selections = rows.map(row => { const { range, skills } = teachingSkillSelectSchema.parse(row.body); return { range, skills }; });
      if (activityId) return { skills: (await resolve({ identity, activity: await activity(identity, activityId) })).catalog, selections };
      return { skills: (await personal(identity)).filter(item => item.fixed.version === item.current)
        .map(item => meta(item.fixed, 'personal', !item.disabled, item.disabled)), selections };
    },
    async freeze(identity: SpaceIdentity, references: TeachingSkillReference[]): Promise<CourseSkillPackage[]> {
      await authorize(identity);
      const refs = teachingSkillReferencesSchema.parse(references), versions = await personal(identity);
      return refs.map(ref => {
        const version = versions.find(item => item.fixed.skillId === ref.skillId && item.fixed.version === ref.version && !item.disabled);
        if (!version) throw new StorageError('missing');
        const { source, packageVersion, files } = version.fixed;
        return { ...ref, source, packageVersion, files, required: false };
      });
    },
    async read(identity: SpaceIdentity, activityId: string, skillId: string, version: number, path: string, guard: Guard = {}): Promise<TeachingSkillLoaded> {
      const ref = teachingSkillReferencesSchema.parse([{ skillId, version }])[0]!;
      const { candidate, file } = await inspect(identity, activityId, ref, path, guard);
      return chunk(candidate, file, 0, skillFileBytes(file).length);
    },
    async load(identity: SpaceIdentity, activityId: string, value: TeachingSkillLoad, guard: Guard = {}): Promise<TeachingSkillLoaded> {
      const input = teachingSkillLoadSchema.parse(value);
      // Even a repeated dispatch must pass today's read authority; reconciliation has its own historical API.
      await inspect(identity, activityId, input, input.path, guard);
      const { assertDispatch: _guard, ...transactionGuard } = guard;
      const receipt = await write(identity, input.commandId, { operation: 'load', activityId, input }, async tx => {
        const { candidate, file } = await inspect(identity, activityId, input, input.path, transactionGuard, tx.query.bind(tx));
        const body = chunk(candidate, file, input.offset, input.length);
        await tx.query(`INSERT INTO teaching_skill_loads(command_id,owner_key,activity_id,run_id,step_id,fingerprint,body)
          VALUES($1,$2,$3,$4,$5,$6,$7)`, [input.commandId, key(identity), activityId, input.runId, input.stepId,
          canonicalDigest({ activityId, input }), JSON.stringify({ ...body, ...(candidate.ownerKey ? { packageOwnerKey: candidate.ownerKey } : {}) })]);
        return body;
      });
      await guard.assertDispatch?.();
      return teachingSkillLoadedSchema.parse(receipt.result);
    },
    async loaded(identity: SpaceIdentity, activityId: string, runId: string): Promise<TeachingSkillLoaded[]> {
      await authorize(identity); z.uuid().parse(activityId); z.uuid().parse(runId);
      const { rows } = await storage.read(`SELECT body FROM teaching_skill_loads WHERE owner_key=$1 AND activity_id=$2
        AND run_id=$3 ORDER BY created_at,command_id`, [key(identity), activityId, runId]);
      return rows.map(row => parseStoredTeachingSkillLoad(row.body).loaded);
    },
    async reconcile(identity: SpaceIdentity, activityId: string, commandId: string): Promise<TeachingSkillLoaded | null> {
      await authorize(identity); z.uuid().parse(activityId); z.uuid().parse(commandId);
      const { rows: [row] } = await storage.read('SELECT body FROM teaching_skill_loads WHERE command_id=$1 AND owner_key=$2 AND activity_id=$3',
        [commandId, key(identity), activityId]);
      return row ? parseStoredTeachingSkillLoad(row.body).loaded : null;
    },
  };
}

export async function validateTeachingSkills(storage: OwnedStorage) {
  const { rows } = await storage.read('SELECT owner_key,skill_id,version,body FROM teaching_skill_versions');
  for (const row of rows) {
    const fixed = validateTeachingSkillVersion(row.body);
    if (fixed.skillId !== row.skill_id || fixed.version !== row.version) throw new StorageError('corrupt');
  }
  const { rows: selections } = await storage.read('SELECT range_key,body FROM teaching_skill_selections');
  for (const row of selections) if (rangeKey(teachingSkillSelectSchema.parse(row.body).range) !== row.range_key) throw new StorageError('corrupt');
  const { rows: loads } = await storage.read('SELECT body FROM teaching_skill_loads');
  for (const row of loads) {
    const body = parseStoredTeachingSkillLoad(row.body).loaded, bytes = skillFileBytes(body);
    if (sha(bytes) !== body.digest || bytes.length !== body.byteLength || body.offset + bytes.length > body.totalByteLength
      || body.complete !== (body.offset === 0 && body.byteLength === body.totalByteLength)) throw new StorageError('corrupt');
  }
}

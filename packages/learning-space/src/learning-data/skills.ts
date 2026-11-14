import { createHash } from 'node:crypto';
import { z } from 'zod';
import { StorageError, type OwnedStorage, type OwnedTransaction, type Migration } from '@xunjie/storage';
import { spaceIdentitySchema, type SpaceIdentity } from '@xunjie/contracts/spaces';
import type { LearningActivity } from '@xunjie/contracts/learning-data';
import { teachingSkillImportSchema, teachingSkillSelectSchema, teachingSkillDisableSchema, teachingSkillReferencesSchema,
  teachingSkillReferenceSchema, teachingSkillRemoveSchema, type TeachingSkillDocument,
  teachingSkillPathSchema, teachingSkillLoadSchema, teachingSkillLoadedSchema, courseSkillPackagesSchema, teachingSkillLimits,
  type TeachingSkillImport, type TeachingSkillReference, type TeachingSkillVersion, type TeachingSkillCatalogEntry,
  type TeachingSkillState, type TeachingSkillLoaded, type TeachingSkillLoad, type CourseSkillPackage,
  type TeachingSkillUnavailable, type TeachingSkillRange } from '@xunjie/contracts/agent-skills';
import { sessionSkillLoadSchema, sessionSkillSelectSchema, skillLibrarySnapshotSchema,
  type SessionSkillLoad, type SkillLibrarySnapshot, type SkillsPort } from '@xunjie/contracts/agent-skills';
import { canonicalDigest, operationId } from '@xunjie/storage/identity';
import { parseTeachingSkillPackage, validateTeachingSkillVersion, skillFileBytes, parseStoredTeachingSkillLoad, TeachingSkillImportError } from '../skill-packages.js';
import { agentSessionSchema, type AgentSession } from '@xunjie/contracts/agent-sessions';
import { activitySchema } from '@xunjie/contracts/learning-data';
import { collectSources, validateSources, type SourceSpec, type OwnerSourceClosure } from '@xunjie/storage/source-closure';

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

export const teachingSkillsRemovalMigration: Migration = { version: 15, name: 'personal-skill-library-removal', sql: `
  ALTER TABLE teaching_skills ADD COLUMN removed boolean NOT NULL DEFAULT false;
` };
/** The same library domain is now owned by learning-data; no Agent execution tables are queried. */
export const learningSkillsMigration: Migration = { version: 34, name: 'session-learning-skills', sql:
  teachingSkillsMigration.sql + teachingSkillsRemovalMigration.sql + `
  CREATE TABLE session_skill_loads(command_id uuid PRIMARY KEY,session_id uuid NOT NULL REFERENCES agent_session_directory(session_id),
    space_environment_id uuid NOT NULL,space_id uuid NOT NULL,principal_id uuid NOT NULL,identity_kind text NOT NULL,
    run_id uuid NOT NULL,step_id uuid NOT NULL,input_digest text NOT NULL,body jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp());
  CREATE INDEX session_skill_loads_run ON session_skill_loads(session_id,run_id);
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
interface ResolvedSkillsScope extends Omit<TeachingSkillsScope, 'activity'> {
  activity?: LearningActivity;
  selection?: TeachingSkillReference[];
}
export type TeachingSkillsGuard = { assertDispatch?: () => Promise<void>; toolNames?: string[]; references?: TeachingSkillReference[] | undefined };
/** Compatibility methods stay typed separately from the independent library/session consumer ports. */
export interface SkillsOwner extends SkillsPort {
  select(identity: SpaceIdentity, input: z.infer<typeof teachingSkillSelectSchema>): Promise<Awaited<ReturnType<SkillsPort['select']>>>;
  resolve(scope: TeachingSkillsScope, toolNames?: string[]): Promise<TeachingSkillState>;
  freeze(identity: SpaceIdentity, references: TeachingSkillReference[]): Promise<CourseSkillPackage[]>;
  read(identity: SpaceIdentity, activityId: string, skillId: string, version: number, path: string, guard?: TeachingSkillsGuard): Promise<TeachingSkillLoaded>;
  load(identity: SpaceIdentity, activityId: string, input: TeachingSkillLoad, guard?: TeachingSkillsGuard): Promise<TeachingSkillLoaded>;
  loaded(identity: SpaceIdentity, activityId: string, runId: string): Promise<TeachingSkillLoaded[]>;
  reconcile(identity: SpaceIdentity, activityId: string, commandId: string): Promise<TeachingSkillLoaded | null>;
}
type Guard = TeachingSkillsGuard;
type Query = OwnedStorage['read'];
type Candidate = { fixed: TeachingSkillVersion; entry: TeachingSkillCatalogEntry; ownerKey?: string };
const key = (identity: SpaceIdentity) => [identity.environmentId, identity.spaceId, identity.principalId].join('/');
const person = (identity: SpaceIdentity) => [identity.environmentId, identity.principalId].join('/');
// Keep historical owner keys intact for receipts/recovery, but a personal library spans spaces.
const personalOwnerFilter = "split_part(owner_key,'/',1)||'/'||split_part(owner_key,'/',3)=ANY($1::text[])";
const same = (a: SpaceIdentity, b: SpaceIdentity) => key(a) === key(b);
const rangeKey = (range: TeachingSkillRange) => range.kind === 'course' ? 'course:' + range.courseId
  : range.kind === 'activity' ? 'activity:' + range.activityId : range.kind === 'session' ? 'session:' + range.sessionId : range.kind;
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
export function createSkills(storage: OwnedStorage, options: {
  authorize(identity: SpaceIdentity): Promise<void>;
  activity(identity: SpaceIdentity, activityId: string): Promise<LearningActivity>;
  session?(identity: SpaceIdentity, sessionId: string): Promise<AgentSession>;
  assertWritable(): void | Promise<void>;
  /** Trusted host association: a device's own personal identity and its connected school identities. */
  personalOwners?(identity: SpaceIdentity): Promise<SpaceIdentity[]>;
}): SkillsOwner {
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
    if (!same(value.identity, identity) || value.identity.kind !== identity.kind || value.activityId !== activityId) throw new StorageError('forbidden');
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
      JOIN teaching_skills s USING(owner_key,skill_id) WHERE ${personalOwnerFilter} AND NOT s.removed ORDER BY v.skill_id,v.version`, [await subjects(identity)]);
    return rows.map(row => ({ ownerKey: String(row.owner_key), fixed: validateTeachingSkillVersion(row.body),
      disabled: Boolean(row.disabled), current: Number(row.current_version) }));
  }
  async function build(scope: ResolvedSkillsScope, toolNames?: string[], query: Query = storage.read.bind(storage)) {
    const { identity } = scope, current = scope.activity;
    const candidates: Candidate[] = [];
    const explicit = teachingSkillReferencesSchema.parse(scope.selection ?? scope.input?.draft.skills ?? []);
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
    const selected: TeachingSkillReference[] = [...explicit, ...versions.filter(item => scope.selection === undefined && !item.disabled
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
      && !(scope.courseSkills ?? current?.course?.skills ?? []).some(item => item.skillId === ref.skillId && item.version === ref.version)
      && !missing.some(item => item.skillId === ref.skillId && item.version === ref.version)) {
      missing.push(missingMeta(ref, unavailable(ownerUnavailable ? 'owner-unavailable'
        : versions.some(item => item.fixed.skillId === ref.skillId) ? 'version-missing' : 'skill-missing', ref.skillId + '@' + ref.version)));
    }
    if (ownerUnavailable && !missing.length) missing.push(missingMeta({ skillId: operationId('skills-owner:' + key(identity)), version: 1 },
      unavailable('owner-unavailable', 'Personal skill catalog is temporarily unavailable')));
    for (const item of courseSkillPackagesSchema.parse(scope.courseSkills ?? current?.course?.skills ?? [])) {
      try {
        const fixed = { ...parseTeachingSkillPackage({ source: item.source, packageVersion: item.packageVersion,
          files: item.files, requestId: item.skillId }), skillId: item.skillId, version: item.version };
        candidates.push({ fixed, entry: meta(fixed, 'course', item.required || scope.selection === undefined
          || selected.some(ref => ref.skillId === item.skillId && ref.version === item.version), false, item.required) });
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
  async function sessionScope(identity: SpaceIdentity, sessionId: string): Promise<ResolvedSkillsScope> {
    await authorize(identity); z.uuid().parse(sessionId);
    if (!options.session) throw new StorageError('forbidden');
    const session = agentSessionSchema.parse(await options.session(identity, sessionId));
    if (session.sessionId !== sessionId || !same(session.identity, identity) || session.identity.kind !== identity.kind
      || session.deleted) throw new StorageError('forbidden');
    let current: LearningActivity | undefined;
    if (session.workspace) {
      current = await activity(identity, session.workspace.activityId);
      if (canonicalDigest(current.target) !== canonicalDigest(session.workspace.target)) throw new StorageError('forbidden');
    }
    const ranges = ['session:' + sessionId, ...(current ? ['activity:' + current.activityId] : []),
      ...(current?.course ? ['course:' + current.course.courseId] : ['self-study']), 'all'];
    const { rows } = await storage.read('SELECT range_key,body FROM teaching_skill_selections WHERE owner_key=$1 AND range_key=ANY($2::text[])',
      [key(identity), ranges]);
    const row = ranges.map(range => rows.find(row => row.range_key === range)).find(Boolean);
    const selection = row ? teachingSkillSelectSchema.parse(row.body).skills : undefined;
    return { identity, ...(current ? { activity: current } : {}), ...(selection ? { selection } : {}) };
  }
  async function resolveSession(identity: SpaceIdentity, sessionId: string, toolNames?: string[]) {
    return (await sessionSnapshot(identity, sessionId, toolNames)).state;
  }
  async function sessionSnapshot(identity: SpaceIdentity, sessionId: string, toolNames?: string[], query?: Query) {
    const scope = await sessionScope(identity, sessionId), result = await build(scope, toolNames, query);
    const selectionDigest = canonicalDigest({ identity: { environmentId: identity.environmentId, spaceId: identity.spaceId,
      principalId: identity.principalId, kind: identity.kind }, sessionId, owner: storage.owner,
      course: scope.activity?.course ?? null, catalog: result.state.catalog });
    return { ...result, state: { ...result.state, selectionDigest } };
  }
  async function inspectSession(identity: SpaceIdentity, sessionId: string, input: z.output<typeof sessionSkillLoadSchema>,
    toolNames?: string[], query?: Query) {
    const snapshot = await sessionSnapshot(identity, sessionId, toolNames, query);
    if (snapshot.state.selectionDigest !== input.selectionDigest) throw new StorageError('identity-conflict');
    const candidates = snapshot.candidates.filter(item => item.fixed.skillId === input.skillId && item.fixed.version === input.version
      && item.fixed.digest === input.packageDigest && item.entry.selected && !item.entry.unavailable);
    if (candidates.length !== 1) throw new TeachingSkillError(unavailable('not-selected', input.skillId + '@' + input.version));
    const candidate = candidates[0]!, file = candidate.fixed.files.find(file => file.path === input.path);
    if (!file) throw new StorageError('missing');
    return { candidate, file };
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
    validate: () => validateSkills(storage),
    resolveSession,
    async exportLibrary(identity: SpaceIdentity): Promise<SkillLibrarySnapshot> {
      await authorize(identity);
      const { rows } = await storage.read(`SELECT owner_key,skill_id,version,disabled,removed FROM teaching_skills
        WHERE ${personalOwnerFilter} ORDER BY skill_id`, [await subjects(identity)]);
      const packages = [];
      for (const row of rows) {
        const { rows: versions } = await storage.read('SELECT body FROM teaching_skill_versions WHERE owner_key=$1 AND skill_id=$2 ORDER BY version',
          [row.owner_key, row.skill_id]);
        packages.push({ skillId: row.skill_id, version: row.version, disabled: row.disabled, removed: row.removed,
          versions: versions.map(version => validateTeachingSkillVersion(version.body)) });
      }
      const { rows: selections } = await storage.read('SELECT body FROM teaching_skill_selections WHERE owner_key=$1 ORDER BY range_key', [key(identity)]);
      return skillLibrarySnapshotSchema.parse({ formatVersion: 1, packages, selections: selections.map(row => {
        const { range, skills } = teachingSkillSelectSchema.parse(row.body); return { range, skills };
      }).filter(selection => selection.range.kind !== 'session') });
    },
    async adoptLibrary(identity: SpaceIdentity, value: { requestId: string; library: SkillLibrarySnapshot }): Promise<void> {
      const input = z.object({ requestId: z.uuid(), library: skillLibrarySnapshotSchema }).strict().parse(value);
      if (new Set(input.library.packages.map(item => item.skillId)).size !== input.library.packages.length
        || input.library.selections.some(selection => selection.range.kind === 'session')) throw new StorageError('invalid');
      const primary = (await owners(identity))[0]!;
      await write(identity, input.requestId, { operation: 'adopt-library', input }, async tx => {
        const people = await subjects(identity);
        const { rows: retained } = await tx.query(`SELECT skill_id FROM teaching_skills WHERE ${personalOwnerFilter} AND NOT removed`, [people]);
        const active = new Set([...retained.map(row => String(row.skill_id)), ...input.library.packages.filter(item => !item.removed).map(item => item.skillId)]);
        if (active.size > teachingSkillLimits.skills) throw new StorageError('invalid');
        for (const item of input.library.packages) {
          const versions = item.versions.map(validateTeachingSkillVersion);
          if (versions.length !== item.version || versions.some((version, index) => version.skillId !== item.skillId || version.version !== index + 1))
            throw new StorageError('corrupt');
          const { rows: [prior] } = await tx.query(`SELECT owner_key,version,disabled,removed FROM teaching_skills WHERE ${personalOwnerFilter} AND skill_id=$2`, [people, item.skillId]);
          const ownerKey = prior ? String(prior.owner_key) : key(primary);
          if (prior && (Number(prior.version) !== item.version || Boolean(prior.disabled) !== item.disabled || Boolean(prior.removed) !== item.removed))
            throw new StorageError('identity-conflict');
          await tx.query('INSERT INTO teaching_skills(owner_key,skill_id,version,disabled,removed) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
            [ownerKey, item.skillId, item.version, item.disabled, item.removed]);
          for (const version of versions) {
            const { rows: [stored] } = await tx.query('SELECT body FROM teaching_skill_versions WHERE owner_key=$1 AND skill_id=$2 AND version=$3',
              [ownerKey, item.skillId, version.version]);
            if (stored && canonicalDigest(stored.body) !== canonicalDigest(version)) throw new StorageError('identity-conflict');
            await tx.query('INSERT INTO teaching_skill_versions(owner_key,skill_id,version,body) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
              [ownerKey, item.skillId, version.version, version]);
          }
        }
        for (const selection of input.library.selections) {
          const range = rangeKey(selection.range), body = { requestId: operationId('adopt-skill-selection:' + input.requestId + ':' + range), ...selection };
          const { rows: [stored] } = await tx.query('SELECT body FROM teaching_skill_selections WHERE owner_key=$1 AND range_key=$2', [key(identity), range]);
          if (stored) {
            const prior = teachingSkillSelectSchema.parse(stored.body);
            if (canonicalDigest({ range: prior.range, skills: prior.skills }) !== canonicalDigest(selection)) throw new StorageError('identity-conflict');
          }
          await tx.query('INSERT INTO teaching_skill_selections(owner_key,range_key,body) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [key(identity), range, body]);
        }
        return null;
      });
    },
    async loadSession(identity: SpaceIdentity, sessionId: string, value: SessionSkillLoad, guard: Guard = {}): Promise<TeachingSkillLoaded> {
      const input = sessionSkillLoadSchema.parse(value);
      await guard.assertDispatch?.();
      await inspectSession(identity, sessionId, input, guard.toolNames);
      const fingerprint = canonicalDigest({ identity: { environmentId: identity.environmentId, spaceId: identity.spaceId,
        principalId: identity.principalId, kind: identity.kind }, sessionId, input });
      const receipt = await write(identity, input.commandId, { operation: 'session-load', sessionId, input }, async tx => {
        const { candidate, file } = await inspectSession(identity, sessionId, input, guard.toolNames, tx.query.bind(tx));
        const loaded = chunk(candidate, file, input.offset, input.length);
        await tx.query(`INSERT INTO session_skill_loads(command_id,session_id,space_environment_id,space_id,principal_id,
          identity_kind,run_id,step_id,input_digest,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [input.commandId, sessionId, identity.environmentId, identity.spaceId, identity.principalId, identity.kind,
          input.runId, input.stepId, fingerprint, { input, loaded, identity, ...(candidate.ownerKey ? { packageOwnerKey: candidate.ownerKey } : {}) }]);
        return loaded;
      });
      await guard.assertDispatch?.();
      return teachingSkillLoadedSchema.parse(receipt.result);
    },
    async reconcileSession(identity: SpaceIdentity, sessionId: string, value: SessionSkillLoad): Promise<TeachingSkillLoaded | null> {
      await sessionScope(identity, sessionId);
      const input = sessionSkillLoadSchema.parse(value);
      const { rows: [row] } = await storage.read('SELECT * FROM session_skill_loads WHERE command_id=$1', [input.commandId]);
      if (!row) return null;
      if (row.session_id !== sessionId || row.space_environment_id !== identity.environmentId || row.space_id !== identity.spaceId
        || row.principal_id !== identity.principalId || row.identity_kind !== identity.kind) throw new StorageError('forbidden');
      const fingerprint = canonicalDigest({ identity: { environmentId: identity.environmentId, spaceId: identity.spaceId,
        principalId: identity.principalId, kind: identity.kind }, sessionId, input });
      if (fingerprint !== row.input_digest) throw new StorageError('identity-conflict');
      const body = row.body as { input: unknown; loaded: unknown };
      if (canonicalDigest(body.input) !== canonicalDigest(input)) throw new StorageError('corrupt');
      return teachingSkillLoadedSchema.parse(body.loaded);
    },
    async selectSession(identity: SpaceIdentity, sessionId: string, value: { requestId: string; skills: TeachingSkillReference[] }) {
      const selected = sessionSkillSelectSchema.parse(value);
      const input = teachingSkillSelectSchema.parse({ ...selected, range: { kind: 'session', sessionId } });
      const scope = await sessionScope(identity, sessionId);
      await write(identity, input.requestId, { operation: 'session-select', input }, async tx => {
        const { candidates } = await build(scope, undefined, tx.query.bind(tx));
        const versions = await personal(identity, tx.query.bind(tx));
        for (const ref of input.skills) if (!versions.some(item => item.fixed.skillId === ref.skillId && item.fixed.version === ref.version && !item.disabled)
          && !candidates.some(item => item.entry.origin === 'course' && item.fixed.skillId === ref.skillId
            && item.fixed.version === ref.version && !item.entry.disabled)) throw new StorageError('missing');
        await tx.query(`INSERT INTO teaching_skill_selections(owner_key,range_key,body) VALUES($1,$2,$3)
          ON CONFLICT(owner_key,range_key) DO UPDATE SET body=EXCLUDED.body`, [key(identity), rangeKey(input.range), input]);
        return null;
      });
      return resolveSession(identity, sessionId);
    },
    async document(identity: SpaceIdentity, value: unknown): Promise<TeachingSkillDocument> {
      await authorize(identity);
      const ref = teachingSkillReferenceSchema.parse(value);
      const { rows: [row] } = await storage.read(`SELECT v.body FROM teaching_skill_versions v
        JOIN teaching_skills s USING(owner_key,skill_id) WHERE ${personalOwnerFilter}
        AND NOT s.removed AND v.skill_id=$2 AND v.version=$3`, [await subjects(identity), ref.skillId, ref.version]);
      if (!row) throw new StorageError('missing');
      const fixed = validateTeachingSkillVersion(row.body);
      return { ...ref, content: fixed.files.find(file => file.path === 'SKILL.md')!.content };
    },
    async remove(identity: SpaceIdentity, value: unknown): Promise<{ skillId: string }> {
      const input = teachingSkillRemoveSchema.parse(value);
      const receipt = await write(identity, input.requestId, { operation: 'remove', input }, async tx => {
        // Keep package versions, load provenance and frozen run snapshots intact. A new request
        // can repeat removal, but cannot remove another person's or a course-only package.
        const { rows } = await tx.query(`UPDATE teaching_skills SET removed=true WHERE ${personalOwnerFilter}
          AND skill_id=$2 RETURNING skill_id`, [await subjects(identity), input.skillId]);
        if (!rows.length) throw new StorageError('missing');
        return { skillId: input.skillId };
      });
      return receipt.result as { skillId: string };
    },
    async import(identity: SpaceIdentity, value: unknown): Promise<TeachingSkillCatalogEntry> {
      const input = teachingSkillImportSchema.parse(value), parsed = parseTeachingSkillPackage(input);
      const primary = (await owners(identity))[0]!;
      const skillId = input.skillId ?? operationId('teaching-skill:' + person(primary) + ':' + input.requestId);
      const receipt = await write(identity, input.requestId, { operation: 'import', input }, async tx => {
        const people = await subjects(identity);
        if (!input.skillId) {
          // Package digests also include the publication version. Compare original file
          // paths/bytes inside the write lock, returning only the matching package body.
          const files = Object.fromEntries(parsed.attachments.map(file => [file.path, file.digest]));
          const { rows: [duplicate] } = await tx.query(`SELECT v.body,s.disabled FROM teaching_skill_versions v
            JOIN teaching_skills s USING(owner_key,skill_id) WHERE ${personalOwnerFilter}
            AND NOT s.removed AND v.version=s.version AND v.body->>'source'=$2
            AND (SELECT jsonb_object_agg(file->>'path',file->'digest')
              FROM jsonb_array_elements(v.body->'attachments') AS file)=$3::jsonb
            ORDER BY v.owner_key,v.skill_id LIMIT 1`, [people, input.source, JSON.stringify(files)]);
          if (duplicate) return meta(validateTeachingSkillVersion(duplicate.body), 'personal', !duplicate.disabled, Boolean(duplicate.disabled));
        }
        const { rows: [prior] } = await tx.query(`SELECT owner_key,version,disabled,removed FROM teaching_skills WHERE ${personalOwnerFilter} AND skill_id=$2`, [people, skillId]);
        if (prior?.removed) throw new StorageError('missing');
        const ownerKey = prior ? String(prior.owner_key) : key(primary);
        if (input.skillId && !prior) throw new StorageError('missing');
        if (prior) {
          const { rows: history } = await tx.query('SELECT body FROM teaching_skill_versions WHERE owner_key=$1 AND skill_id=$2', [ownerKey, skillId]);
          const fixed = history.map(row => validateTeachingSkillVersion(row.body));
          if (fixed.some(item => item.source !== input.source)) throw new StorageError('identity-conflict');
          const published = fixed.find(item => item.packageVersion === input.packageVersion);
          if (published) {
            if (published.digest !== parsed.digest) throw new StorageError('identity-conflict');
            const current = fixed.find(item => item.version === Number(prior.version))!;
            if (current.packageVersion === input.packageVersion)
              return meta(current, 'personal', !prior.disabled, Boolean(prior.disabled));
            // A historical match must become current too. Publish a new internal
            // version so future updates stay monotonic and fixed references survive.
          }
        }
        if (!prior) {
          const { rows } = await tx.query(`SELECT skill_id FROM teaching_skills WHERE ${personalOwnerFilter} AND NOT removed`, [people]);
          if (rows.length >= teachingSkillLimits.skills) throw new TeachingSkillImportError('skill-limit');
        }
        const version = prior ? Number(prior.version) + 1 : 1;
        if (version > teachingSkillLimits.versions) throw new StorageError('invalid');
        const fixed = { ...parsed, skillId, version };
        await tx.query(`INSERT INTO teaching_skills(owner_key,skill_id,version) VALUES($1,$2,$3)
          ON CONFLICT(owner_key,skill_id) DO UPDATE SET version=EXCLUDED.version`, [ownerKey, skillId, version]);
        await tx.query('INSERT INTO teaching_skill_versions(owner_key,skill_id,version,body) VALUES($1,$2,$3,$4)',
          [ownerKey, skillId, version, JSON.stringify(fixed)]);
        return meta(fixed, 'personal', !prior?.disabled, Boolean(prior?.disabled));
      });
      return receipt.result as TeachingSkillCatalogEntry;
    },
    async select(identity: SpaceIdentity, value: unknown) {
      const input = teachingSkillSelectSchema.parse(value);
      if (input.range.kind === 'activity') await activity(identity, input.range.activityId);
      if (input.range.kind === 'session') throw new StorageError('invalid');
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
        const { rows } = await tx.query(`UPDATE teaching_skills SET disabled=$3 WHERE ${personalOwnerFilter} AND skill_id=$2 AND NOT removed RETURNING version`,
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

export const skillSourceSpecs: readonly SourceSpec[] = [
  { table: 'teaching_skills', kind: 'teaching_skills', id: ['owner_key', 'skill_id'], version: ['version'] },
  { table: 'teaching_skill_versions', kind: 'teaching_skill_versions', id: ['owner_key', 'skill_id', 'version'], version: ['version'] },
  { table: 'teaching_skill_selections', kind: 'teaching_skill_selections', id: ['owner_key', 'range_key'] },
  { table: 'teaching_skill_loads', kind: 'teaching_skill_loads', id: ['command_id'], version: ['fingerprint'] },
  { table: 'session_skill_loads', kind: 'session_skill_loads', id: ['command_id'], version: ['input_digest'] },
];
const skillSourceOwner = 'xunjie.learning-data.skills';
export function collectSkillSources(storage: OwnedStorage): Promise<OwnerSourceClosure> {
  return collectSources(storage, skillSourceOwner, skillSourceSpecs);
}
export function validateSkillSources(storage: OwnedStorage, material: unknown): Promise<void> {
  return validateSources(storage, material, skillSourceOwner, skillSourceSpecs);
}
/** Checks retained source packages and exact load ranges, with no current dispatch or remote membership. */
export async function validateSkills(storage: OwnedStorage): Promise<void> {
  try { await validateTeachingSkills(storage); }
  catch (error) {
    if (error instanceof z.ZodError || error instanceof StorageError && error.code === 'invalid') throw new StorageError('corrupt');
    throw error;
  }
  const { rows: [relation] } = await storage.read("SELECT to_regclass('session_skill_loads') AS relation");
  if (!relation?.relation) return; // The retiring activity-only owner has no session ledger.
  const { rows } = await storage.read('SELECT * FROM session_skill_loads');
  for (const row of rows) {
    try {
      const body = z.object({ input: sessionSkillLoadSchema, loaded: teachingSkillLoadedSchema, identity: spaceIdentitySchema,
        packageOwnerKey: z.string().optional() }).strict().parse(row.body);
      const input = body.input, loaded = body.loaded;
      const fingerprint = canonicalDigest({ identity: { environmentId: body.identity.environmentId, spaceId: body.identity.spaceId,
        principalId: body.identity.principalId, kind: body.identity.kind }, sessionId: row.session_id, input });
      if (input.commandId !== row.command_id || input.runId !== row.run_id || input.stepId !== row.step_id
        || body.identity.environmentId !== row.space_environment_id || body.identity.spaceId !== row.space_id
        || body.identity.principalId !== row.principal_id || body.identity.kind !== row.identity_kind || fingerprint !== row.input_digest
        || loaded.skillId !== input.skillId || loaded.version !== input.version || loaded.path !== input.path
        || loaded.packageDigest !== input.packageDigest || loaded.offset !== input.offset) throw new StorageError('corrupt');
      const { rows: [parent] } = await storage.read('SELECT body FROM agent_session_directory WHERE session_id=$1', [row.session_id]);
      const session = agentSessionSchema.parse(parent?.body);
      if (!same(session.identity, body.identity) || session.identity.kind !== body.identity.kind) throw new StorageError('corrupt');
      let fixed: TeachingSkillVersion;
      if (body.packageOwnerKey) {
        const { rows: [version] } = await storage.read('SELECT body FROM teaching_skill_versions WHERE owner_key=$1 AND skill_id=$2 AND version=$3',
          [body.packageOwnerKey, input.skillId, input.version]);
        fixed = validateTeachingSkillVersion(version?.body);
      } else {
        if (!session.workspace) throw new StorageError('corrupt');
        const { rows: [parent] } = await storage.read('SELECT body FROM activities WHERE id=$1', [session.workspace.activityId]);
        const activity = activitySchema.parse(parent?.body), course = activity.course?.skills?.find(item => item.skillId === input.skillId && item.version === input.version);
        if (!course || !same(activity.identity, body.identity) || activity.identity.kind !== body.identity.kind) throw new StorageError('corrupt');
        fixed = { ...parseTeachingSkillPackage({ source: course.source, packageVersion: course.packageVersion,
          files: course.files, requestId: course.skillId }), skillId: course.skillId, version: course.version };
      }
      const file = fixed.files.find(file => file.path === input.path);
      if (!file || fixed.digest !== input.packageDigest) throw new StorageError('corrupt');
      const original = skillFileBytes(file), bytes = skillFileBytes(loaded), expected = original.subarray(input.offset, input.offset + input.length);
      if (input.offset > original.length || !bytes.equals(expected) || sha(bytes) !== loaded.digest || sha(original) !== loaded.originalDigest
        || original.length !== loaded.totalByteLength || bytes.length !== loaded.byteLength
        || loaded.complete !== (loaded.offset === 0 && loaded.byteLength === loaded.totalByteLength)) throw new StorageError('corrupt');
      const receipt = await storage.receipt('skills:' + input.commandId,
        canonicalDigest({ owner: key(body.identity), input: { operation: 'session-load', sessionId: row.session_id, input } }));
      if (!receipt || canonicalDigest(receipt.result) !== canonicalDigest(loaded)) throw new StorageError('corrupt');
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof StorageError && ['identity-conflict', 'invalid', 'missing'].includes(error.code))
        throw new StorageError('corrupt');
      throw error;
    }
  }
}

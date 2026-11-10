import { createHash } from 'node:crypto';
import { z } from 'zod';
import { StorageError, type Migration, type OwnedStorage, type OwnedTransaction } from '@xunjie/storage';
import { activitySchema, type LearningActivity, type WorkFile } from '@xunjie/contracts/learning-data';
import { spaceIdentitySchema, type SpaceIdentity } from '@xunjie/contracts/spaces';
import { canonicalValue } from '@xunjie/contracts/execution';
import { schoolAcquisitionInputSchema, schoolAcquisitionReceiptSchema, schoolDeliveryCourseSchema,
  schoolSubmissionInputSchema, schoolSubmissionReceiptSchema, schoolSubmissionSchema, schoolSubmissionListSchema,
  type SchoolAcquisitionInput, type SchoolAcquisitionReceipt, type SchoolSubmissionInput,
  type SchoolSubmissionReceipt, type SchoolSubmission, type SchoolSubmissionList } from '@xunjie/contracts/school-deliveries';

/** These records and their resource pins belong to the learning-data owner's normal backup. */
export const schoolDeliveryMigration: Migration = { version: 30, name: 'school-acquisitions-and-submissions', sql: `
CREATE TABLE school_acquisitions(request_id uuid PRIMARY KEY,activity_id uuid NOT NULL REFERENCES activities(id),body jsonb NOT NULL);
CREATE INDEX school_acquisitions_activity ON school_acquisitions(activity_id);
CREATE TABLE school_submissions(submission_id uuid PRIMARY KEY,request_id uuid NOT NULL UNIQUE,
  activity_id uuid NOT NULL REFERENCES activities(id),body jsonb NOT NULL);
CREATE INDEX school_submissions_activity ON school_submissions(activity_id);
` };

const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const json = (value: unknown) => JSON.stringify(canonicalValue(value));
const hash = (value: unknown) => sha(json(value));
const same = (a: unknown, b: unknown) => hash(a) === hash(b);
function fail(code: 'invalid' | 'forbidden' | 'missing' | 'identity-conflict' | 'corrupt'): never { throw new StorageError(code); }
const scopeOf = (activity: LearningActivity) => ({ environmentId: activity.identity.environmentId,
  spaceId: activity.identity.spaceId, principalId: activity.identity.principalId, activityId: activity.activityId });
const courseOf = (activity: LearningActivity) => schoolDeliveryCourseSchema.parse(activity.course && {
  courseId: activity.course.courseId, taskId: activity.course.taskId,
  releaseId: activity.course.releaseId, contentDigest: activity.course.contentDigest });
const fingerprint = (kind: 'acquire' | 'submit', activity: LearningActivity, input: unknown) => hash({ kind, scope: scopeOf(activity), input });
function assertActivity(storage: OwnedStorage, activity: LearningActivity, identity: SpaceIdentity, activityId: string) {
  if (identity.kind !== 'school' || activity.identity.kind !== 'school' || !activity.course || activity.purpose === 'preview'
    || !same(scopeOf(activity), { environmentId: identity.environmentId, spaceId: identity.spaceId,
      principalId: identity.principalId, activityId }) || !same(activity.target, { ...storage.owner, version: 1 })) fail('forbidden');
}
/** Stable namespace IDs make simultaneous retries stage the same originals. */
function resourceId(requestId: string, key: string) {
  const hex = sha(`school-delivery/1/${requestId}/${key}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function textBytes(text: string) {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.toString('utf8') !== text) fail('invalid');
  return bytes;
}
function workBytes(file: WorkFile) {
  if (file.encoding === 'base64') {
    const bytes = Buffer.from(file.value, 'base64');
    if (bytes.toString('base64') !== file.value) fail('invalid');
    return bytes;
  }
  if (file.encoding === 'json') { try { JSON.parse(file.value); } catch { fail('invalid'); } }
  return textBytes(file.value);
}
type Original = { key: string; bytes: Buffer; mediaType: string };
function originals(input: SchoolSubmissionInput): Original[] {
  const values: Original[] = input.works.map(file => ({ key: `work/${file.objectId}`, bytes: workBytes(file), mediaType: file.mediaType }));
  for (const artifact of input.artifacts) values.push({ key: `artifact/${artifact.artifactId}/${artifact.revisionId}`,
    bytes: textBytes(json(artifact.payload)), mediaType: 'application/json' });
  for (const evidence of input.evidence) {
    values.push({ key: `evidence/${evidence.requestId}`, bytes: textBytes(evidence.text), mediaType: evidence.mediaType });
    for (const resource of evidence.resources ?? []) {
      const bytes = textBytes(resource.text);
      if (bytes.byteLength !== resource.byteLength || sha(bytes) !== resource.sha256) fail('invalid');
      values.push({ key: `evidence/${evidence.requestId}/resource/${resource.contentId}`, bytes, mediaType: resource.mediaType });
    }
  }
  return values;
}
const submissionInput = (fixed: SchoolSubmission): SchoolSubmissionInput => ({ requestId: fixed.requestId,
  works: fixed.works, artifacts: fixed.artifacts, evidence: fixed.evidence });
const submissionReceipt = (fixed: SchoolSubmission): SchoolSubmissionReceipt => {
  const { works: _works, artifacts: _artifacts, evidence: _evidence, ...receipt } = fixed;
  return schoolSubmissionReceiptSchema.parse(receipt);
};
const pin = (requestId: string, key: string) => `school-submission/${requestId}/${key}`;
const resourceScope = (activityId: string, requestId: string) => `school-submission/${activityId}/${requestId}`;
async function verifyOriginal(storage: OwnedStorage, activityId: string, requestId: string, value: Original, retained: boolean) {
  const id = resourceId(requestId, value.key), reference = await storage.resource(id), bytes = await storage.readResource(id);
  if (!same(reference.owner, storage.owner) || reference.resourceId !== id || reference.contentVersion !== 1
    || reference.scope !== resourceScope(activityId, requestId) || reference.mediaType !== value.mediaType
    || reference.byteLength !== value.bytes.byteLength || reference.sha256 !== sha(value.bytes)
    || !Buffer.from(bytes).equals(value.bytes)) fail('corrupt');
  if (retained) {
    const { rows: [row] } = await storage.read('SELECT resource_id FROM _storage_references WHERE reference_id=$1', [pin(requestId, value.key)]);
    if (row?.resource_id !== id) fail('corrupt');
  }
}
async function guardActivity(storage: OwnedStorage, tx: OwnedTransaction, expected: LearningActivity) {
  const { rows: [row] } = await tx.query('SELECT body FROM activities WHERE id=$1 FOR SHARE', [expected.activityId]);
  if (!row) fail('forbidden');
  const actual = activitySchema.parse(row.body);
  assertActivity(storage, actual, expected.identity, expected.activityId);
  if (actual.status !== 'open' || !same(courseOf(actual), courseOf(expected))) fail('forbidden');
}
async function projectAcquisition(storage: OwnedStorage, row: Record<string, unknown>, activity: LearningActivity) {
  try {
    const fixed = schoolAcquisitionReceiptSchema.parse(row.body);
    const input = { requestId: fixed.requestId, releaseId: fixed.course.releaseId, contentDigest: fixed.course.contentDigest };
    const original = await storage.receipt(fixed.requestId, fingerprint('acquire', activity, input));
    if (row.request_id !== fixed.requestId || row.activity_id !== activity.activityId
      || !same(fixed.scope, scopeOf(activity)) || !same(fixed.course, courseOf(activity))
      || !original || !same(original.result, fixed)) fail('corrupt');
    return fixed;
  } catch { return fail('corrupt'); }
}
async function projectSubmission(storage: OwnedStorage, row: Record<string, unknown>, activity: LearningActivity) {
  try {
    const fixed = schoolSubmissionSchema.parse(row.body), input = schoolSubmissionInputSchema.parse(submissionInput(fixed));
    const { requestId: _requestId, ...content } = input;
    const original = await storage.receipt(fixed.requestId, fingerprint('submit', activity, input));
    if (row.submission_id !== fixed.submissionId || row.request_id !== fixed.requestId || row.activity_id !== activity.activityId
      || !same(fixed.scope, scopeOf(activity)) || !same(fixed.course, courseOf(activity)) || fixed.contentDigest !== hash(content)
      || !original || !same(original.result, submissionReceipt(fixed))) fail('corrupt');
    for (const value of originals(input)) await verifyOriginal(storage, activity.activityId, input.requestId, value, true);
    return fixed;
  } catch { return fail('corrupt'); }
}

export function createSchoolDeliveries(storage: OwnedStorage, options: {
  activity(identity: SpaceIdentity, activityId: string): Promise<LearningActivity>;
}) {
  async function activity(identity: SpaceIdentity, activityId: string, writable = false) {
    spaceIdentitySchema.parse(identity); z.uuid().parse(activityId);
    const current = activitySchema.parse(await options.activity(identity, activityId));
    assertActivity(storage, current, identity, activityId);
    if (writable && current.status !== 'open') fail('forbidden');
    return current;
  }
  async function acquisitionReceipt(identity: SpaceIdentity, activityId: string, requestId: string): Promise<SchoolAcquisitionReceipt | null> {
    const current = await activity(identity, activityId); z.uuid().parse(requestId);
    const { rows: [row] } = await storage.read('SELECT * FROM school_acquisitions WHERE activity_id=$1 AND request_id=$2', [activityId, requestId]);
    return row ? projectAcquisition(storage, row, current) : null;
  }
  async function acquire(identity: SpaceIdentity, activityId: string, value: SchoolAcquisitionInput): Promise<SchoolAcquisitionReceipt> {
    const current = await activity(identity, activityId, true), input = schoolAcquisitionInputSchema.parse(value), course = courseOf(current);
    if (input.releaseId !== course.releaseId || input.contentDigest !== course.contentDigest) fail('identity-conflict');
    const fp = fingerprint('acquire', current, input);
    if (await storage.receipt(input.requestId, fp)) {
      const found = await acquisitionReceipt(identity, activityId, input.requestId);
      return found ?? fail('identity-conflict');
    }
    const saved = await storage.request({ requestId: input.requestId, fingerprint: fp }, async tx => {
      await activity(identity, activityId, true); await guardActivity(storage, tx, current);
      const result = schoolAcquisitionReceiptSchema.parse({ version: 1, state: 'accepted', requestId: input.requestId,
        scope: scopeOf(current), course, receivedAt: new Date().toISOString() });
      await tx.query('INSERT INTO school_acquisitions VALUES($1,$2,$3)', [input.requestId, activityId, JSON.stringify(result)]);
      return result;
    });
    return schoolAcquisitionReceiptSchema.parse(saved.result);
  }
  async function receipt(identity: SpaceIdentity, activityId: string, requestId: string): Promise<SchoolSubmissionReceipt | null> {
    const current = await activity(identity, activityId); z.uuid().parse(requestId);
    const { rows: [row] } = await storage.read('SELECT * FROM school_submissions WHERE activity_id=$1 AND request_id=$2', [activityId, requestId]);
    return row ? submissionReceipt(await projectSubmission(storage, row, current)) : null;
  }
  async function submit(identity: SpaceIdentity, activityId: string, value: SchoolSubmissionInput): Promise<SchoolSubmissionReceipt> {
    // Authorization precedes even the idempotency lookup: an old receipt is not an access grant.
    const current = await activity(identity, activityId, true), input = schoolSubmissionInputSchema.parse(value);
    const fp = fingerprint('submit', current, input);
    if (await storage.receipt(input.requestId, fp)) {
      const found = await receipt(identity, activityId, input.requestId);
      return found ?? fail('identity-conflict');
    }
    const resources = originals(input);
    for (const resource of resources) {
      await storage.stageResource({ uploadId: resourceId(input.requestId, resource.key), scope: resourceScope(activityId, input.requestId),
        bytes: resource.bytes, mediaType: resource.mediaType, contentVersion: 1 });
      await verifyOriginal(storage, activityId, input.requestId, resource, false);
    }
    const saved = await storage.request({ requestId: input.requestId, fingerprint: fp }, async tx => {
      await activity(identity, activityId, true); await guardActivity(storage, tx, current);
      for (const resource of resources) await tx.reference(pin(input.requestId, resource.key), resourceId(input.requestId, resource.key));
      const { requestId: _requestId, ...content } = input;
      const fixed = schoolSubmissionSchema.parse({ version: 1, state: 'accepted', requestId: input.requestId,
        submissionId: resourceId(input.requestId, 'submission'), scope: scopeOf(current), course: courseOf(current),
        receivedAt: new Date().toISOString(), contentDigest: hash(content), ...content });
      await tx.query('INSERT INTO school_submissions VALUES($1,$2,$3,$4)', [fixed.submissionId, input.requestId, activityId, JSON.stringify(fixed)]);
      return submissionReceipt(fixed);
    });
    return schoolSubmissionReceiptSchema.parse(saved.result);
  }
  async function list(identity: SpaceIdentity, activityId: string): Promise<SchoolSubmissionList> {
    const current = await activity(identity, activityId);
    const { rows } = await storage.read("SELECT * FROM school_submissions WHERE activity_id=$1 ORDER BY body->>'receivedAt',submission_id", [activityId]);
    const submissions = [];
    for (const row of rows) submissions.push(submissionReceipt(await projectSubmission(storage, row, current)));
    return schoolSubmissionListSchema.parse({ submissions });
  }
  async function read(identity: SpaceIdentity, activityId: string, submissionId: string): Promise<SchoolSubmission> {
    const current = await activity(identity, activityId); z.uuid().parse(submissionId);
    const { rows: [row] } = await storage.read('SELECT * FROM school_submissions WHERE activity_id=$1 AND submission_id=$2', [activityId, submissionId]);
    return row ? projectSubmission(storage, row, current) : fail('missing');
  }
  return { acquire, acquisitionReceipt, submit, receipt, list, read };
}

/** Restore validation checks the same owner's original bytes, pins, immutable scope and request receipts. */
export async function validateSchoolDeliveries(storage: OwnedStorage) {
  for (const table of ['school_acquisitions', 'school_submissions'] as const) {
    const { rows } = await storage.read(`SELECT * FROM ${table}`);
    for (const row of rows) {
      try {
        const { rows: [parent] } = await storage.read('SELECT body FROM activities WHERE id=$1', [row.activity_id]);
        if (!parent) fail('corrupt');
        const activity = activitySchema.parse(parent.body);
        assertActivity(storage, activity, activity.identity, String(row.activity_id));
        if (table === 'school_acquisitions') await projectAcquisition(storage, row, activity);
        else await projectSubmission(storage, row, activity);
      } catch { fail('corrupt'); }
    }
  }
}

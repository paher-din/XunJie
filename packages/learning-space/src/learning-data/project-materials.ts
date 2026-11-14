import { z } from 'zod';
import { StorageError, type OwnedStorage } from '@xunjie/storage';
import { canonicalDigest, operationId } from '@xunjie/storage/identity';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import type { LearningActivity } from '@xunjie/contracts/learning-data';
import type { SessionMaterialPort } from '@xunjie/contracts/session-materials';
import { personalProjectMaterialReferenceSchema, type PersonalProjectMaterialReference } from '@xunjie/contracts/student-learning';

const inputSchema = z.object({ requestId: z.uuid(), activityId: z.uuid(), sourceSessionId: z.uuid(),
  references: z.array(personalProjectMaterialReferenceSchema).max(50) }).strict();
export type ProjectMaterialsInput = z.infer<typeof inputSchema>;
export interface ProjectMaterialsReceipt { requestId: string; activityId: string; references: PersonalProjectMaterialReference[]; }
export interface ProjectMaterialsHost {
  openActivity(identity: SpaceIdentity, activityId: string): Promise<LearningActivity>;
  materials: Pick<SessionMaterialPort, 'adopt'>;
  /** Resolve only through the host's current owner/identity mapping, including remote fixed sources. */
  authorizeReference(identity: SpaceIdentity, reference: PersonalProjectMaterialReference): Promise<void>;
  assertDispatch(): Promise<void>;
}
const subject = ({ environmentId, spaceId, principalId, kind }: Omit<SpaceIdentity, 'name'>) =>
  ({ environmentId, spaceId, principalId, kind });
const same = (a: unknown, b: unknown) => canonicalDigest(a) === canonicalDigest(b);

/** The learning owner preserves the original handoff and independently owned workspace copies. */
export function createProjectMaterials(storage: OwnedStorage, host: ProjectMaterialsHost) {
  async function access(identity: SpaceIdentity, activityId: string) {
    if (identity.kind !== 'personal') throw new StorageError('forbidden');
    const activity = await host.openActivity(identity, activityId);
    if (!same(subject(activity.identity), subject(identity)) || activity.course
      || activity.target.environmentId !== storage.owner.environmentId || activity.target.serviceId !== storage.owner.serviceId)
      throw new StorageError('forbidden');
    return activity;
  }
  async function receipt(identity: SpaceIdentity, requestId: string): Promise<ProjectMaterialsReceipt | null> {
    z.uuid().parse(requestId);
    const saved = await storage.receipt('project-materials:' + requestId);
    if (!saved) return null;
    const value = saved.result as { identity: SpaceIdentity; input: unknown };
    const input = inputSchema.parse(value.input);
    if (!same(subject(identity), subject(value.identity)) || input.requestId !== requestId) throw new StorageError('forbidden');
    await access(identity, input.activityId);
    return { requestId, activityId: input.activityId, references: input.references };
  }
  async function adopt(identity: SpaceIdentity, value: ProjectMaterialsInput): Promise<ProjectMaterialsReceipt> {
    const input = inputSchema.parse(value);
    await access(identity, input.activityId);
    const fingerprint = canonicalDigest({ identity: subject(identity), input });
    const key = 'project-materials:' + input.requestId;
    // Checking the original fingerprint precedes every recovery path, including an empty reference list.
    if (await storage.receipt(key, fingerprint)) return (await receipt(identity, input.requestId))!;
    for (const reference of input.references) await host.authorizeReference(identity, reference);
    await storage.request({ requestId: key + ':reserve', fingerprint }, async () => ({ identity: subject(identity), input }));
    for (const [index, reference] of input.references.entries()) {
      if (reference.kind !== 'personal-material' && reference.kind !== 'pdf') continue;
      // Remote sources stay fixed references in the project. Their owner reauthorizes later reads.
      if (reference.owner.environmentId !== storage.owner.environmentId || reference.owner.serviceId !== storage.owner.serviceId) continue;
      if (!same(subject(reference.identity), subject(identity))) throw new StorageError('forbidden');
      await host.assertDispatch();
      const requestId = operationId(`project-material:${input.requestId}:${index}:${canonicalDigest(reference)}`);
      const destination = { kind: 'workspace' as const, activityId: input.activityId };
      if (reference.kind === 'personal-material') await host.materials.adopt(identity, destination, {
        requestId, kind: 'personal-material', materialId: operationId('project-material-object:' + requestId),
        source: { scope: reference.scope, materialId: reference.objectId, version: Number(reference.version), sha256: reference.sha256 },
      });
      else await host.materials.adopt(identity, destination, { requestId, kind: 'pdf', documentId: operationId('project-document:' + requestId),
        source: { scope: reference.scope, documentId: reference.objectId, sha256: reference.sha256 } });
    }
    await host.assertDispatch();
    await access(identity, input.activityId);
    await storage.request({ requestId: key, fingerprint }, async () => ({ identity: subject(identity), input }));
    return (await receipt(identity, input.requestId))!;
  }
  return { adopt, receipt };
}

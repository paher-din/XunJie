import { z } from 'zod';
import { createHash } from 'node:crypto';
import { StorageError } from '@xunjie/storage';
import { activitySchema, workFileSchema } from '@xunjie/contracts/learning-data';
import { questionDraftSyncSchema } from '@xunjie/contracts/question-drafts';
import { pdfReadingSchema, pdfSearchResultSchema } from '@xunjie/contracts/pdf-materials';
import { personalMaterialReadResultSchema, personalMaterialVersionContentSchema } from '@xunjie/contracts/personal-materials';
import { teachingArtifactSchema, teachingArtifactRevisionSchema, teachingArtifactReceiptSchema,
  teachingArtifactOriginSchema, teachingArtifactPublishSchema } from '@xunjie/contracts/teaching-artifacts';
import { componentBundleSchema, componentAlgorithmBundleSchema } from '@xunjie/contracts/components';
import { courseMaterialContentSchema } from '@xunjie/contracts/courses';
import { canonicalValue } from '@xunjie/contracts/execution';
import { executionRecordEventSchema, executionRecordSchema, type ExecutionRecordEvent } from '@xunjie/contracts/execution-records';
import { teachingAgentBindingSchema, type TeachingAgentBinding } from '@xunjie/contracts/teaching-agent';
import type { ChunkConnectionSource } from './chunk-channel.js';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import type { TeachingDependencyCall } from './dependencies.js';
import type { TeachingToolData } from './tool-data.js';
import type { createLearningData } from '../learning-data/index.js';
import type { createCourses } from '../courses/index.js';
import { createMaterialSearch } from '../learning-data/material-search.js';

const inspection = z.object({ retained: z.boolean(), currentRevision: z.number().int().nonnegative(),
  isCurrent: z.boolean(), everPublished: z.boolean() }).strict();
type Data = ReturnType<typeof createLearningData>;
type Courses = Pick<ReturnType<typeof createCourses>, 'referenceText' | 'verifyComponentReference' | 'readComponent' | 'readComponentAlgorithm' | 'readMaterial'>;
export interface ExecutionRecordSourceContext {
  /** Current WP01 authenticated source, never reconstructed from a wire event. */
  source: Readonly<ChunkConnectionSource>;
  /** School-approved activity binding (or the member binding before the first activity pin). */
  binding: TeachingAgentBinding | null;
}
const eventDigest = (event: ExecutionRecordEvent) => createHash('sha256').update(JSON.stringify(canonicalValue(event))).digest('hex');

function approvedExecutionSource(context: ExecutionRecordSourceContext) {
  const parsed = teachingAgentBindingSchema.safeParse(context.binding), source = context.source;
  if (!parsed.success || !source.assertAuthorized || !source.sourceInstallationId) throw new StorageError('forbidden');
  const binding = parsed.data, modules = binding.deviceModules ?? [];
  const execution = modules.filter(module => module.unit === 'tool-execution');
  if (binding.delivery !== 'client' || !binding.executionGrantId || source.grantId !== binding.executionGrantId
    || source.grantId === binding.grantId || source.sourceInstallationId !== binding.installationId
    || new Set(modules.map(module => module.serviceId)).size !== modules.length
    || new Set(modules.map(module => module.unit)).size !== modules.length
    || modules.some(module => module.environmentId !== binding.target.environmentId)
    || execution.length !== 1 || execution[0]!.environmentId !== source.sourceEnvironmentId
    || execution[0]!.serviceId !== source.sourceServiceId || execution[0]!.serviceId === binding.target.serviceId) throw new StorageError('forbidden');
  return { sourceOwner: { environmentId: execution[0]!.environmentId, serviceId: execution[0]!.serviceId },
    installationId: binding.installationId, role: 'tool-execution' as const, nodeClass: 'device' as const,
    assertAuthorized: () => source.assertAuthorized!() };
}

/** Explicit data operations only. No model request, executable callback or Agent state crosses this seam. */
export function createTeachingDataService(options: { learning: Data; courses: Courses; assertWritable(): Promise<void>;
  executionSource?(identity: SpaceIdentity, activityId: string): Promise<ExecutionRecordSourceContext>;
}) {
  return async (input: TeachingDependencyCall) => {
    const identity = input.identity;
    if (!identity) throw new StorageError('invalid');
    if (input.operation === 'execution.record') {
      const activityId = z.uuid().parse(input.activityId);
      if (input.args.length !== 2) throw new StorageError('invalid');
      const event = executionRecordEventSchema.parse(input.args[0]);
      if (input.args[1] !== eventDigest(event)) throw new StorageError('identity-conflict');
      await options.learning.open(identity, activityId);
      await options.assertWritable();
      if (!options.executionSource) throw new StorageError('forbidden');
      const trusted = approvedExecutionSource(await options.executionSource(identity, activityId));
      return options.learning.executionRecords.sync(identity, activityId, event, trusted);
    }
    const method = z.string().parse(input.args[0]), args = z.array(z.unknown()).max(4).parse(input.args[1]);
    if (input.operation === 'course') {
      if (method === 'referenceText') return options.courses.referenceText(identity, args[0]);
      if (method === 'verifyComponentReference') { await options.courses.verifyComponentReference(identity, args[0]); return null; }
      const releaseId = z.uuid().parse(args[0]), key = z.string().min(1).max(80).parse(args[1]);
      if (method === 'readComponent') return options.courses.readComponent(identity, releaseId, key);
      if (method === 'readComponentAlgorithm') return options.courses.readComponentAlgorithm(identity, releaseId, key);
      if (method === 'readMaterial') return options.courses.readMaterial(identity, releaseId, key);
      throw new StorageError('missing');
    }
    if (input.operation !== 'data') throw new StorageError('invalid');
    const activityId = z.uuid().parse(args[0]);
    if (input.activityId !== activityId) throw new StorageError('forbidden');
    await options.learning.open(identity, activityId);
    const id = () => z.uuid().parse(args[1]);
    switch (method) {
      case 'open': return options.learning.open(identity, activityId);
      case 'works.content': return options.learning.works.content(identity, activityId, id());
      case 'works.inspectVersion': return options.learning.works.inspectVersion(identity, activityId,
        z.object({ objectId: z.uuid(), contentId: z.uuid() }).strict().parse(args[1]));
      case 'drafts.verifyReferences':
        await options.learning.drafts.verifyReferences(identity, activityId,
          questionDraftSyncSchema.pick({ references: true, bases: true }).parse(args[1])); return null;
      case 'pdf.read': return options.learning.pdf.read(identity, activityId, args[1]);
      case 'pdf.reading': return options.learning.pdf.reading(identity, activityId, id());
      case 'pdf.find': return options.learning.pdf.find(identity, activityId, args[1]);
      case 'materials.original': return options.learning.materials.original(identity, activityId, id(), z.number().int().positive().parse(args[2]));
      case 'materials.readRange': return options.learning.materials.readRange(identity, activityId, id(),
        z.number().int().positive().parse(args[2]), args[3]);
      case 'artifacts.list': return options.learning.artifacts.list(identity, activityId);
      case 'artifacts.read': return options.learning.artifacts.read(identity, activityId, id());
      case 'artifacts.revision': return options.learning.artifacts.revision(identity, activityId, id(), z.uuid().parse(args[2]));
      case 'artifacts.receipt': return options.learning.artifacts.receipt(identity, activityId, id());
      case 'artifacts.publish': return options.learning.artifacts.publish(identity, activityId,
        teachingArtifactPublishSchema.parse(args[1]), { origin: teachingArtifactOriginSchema.parse(args[2]), assertDispatch: options.assertWritable });
      default: throw new StorageError('missing');
    }
  };
}

/** Tools assemble beside their Agent and model owner; they borrow only authorized source data. */
export function createTeachingDataClient(call: (input: TeachingDependencyCall) => Promise<unknown>) {
  async function invoke<T>(operation: 'data' | 'course', method: string, identity: SpaceIdentity,
    args: unknown[], schema: z.ZodType<T>, activityId?: string): Promise<T> {
    const value = await call({ version: 1, operation, identity, ...(activityId ? { activityId } : {}), args: [method, args] });
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new StorageError('unavailable');
    return parsed.data;
  }
  const read = <T>(method: string, identity: SpaceIdentity, activityId: string, args: unknown[], schema: z.ZodType<T>) =>
    invoke('data', method, identity, [activityId, ...args], schema, activityId);
  const courses: Courses = {
    referenceText: (identity, value) => invoke('course', 'referenceText', identity, [value], z.object({ text: z.string() }).strict()),
    verifyComponentReference: async (identity, value) => { await invoke('course', 'verifyComponentReference', identity, [value], z.null()); },
    readComponent: (identity, releaseId, key) => invoke('course', 'readComponent', identity, [releaseId, key], componentBundleSchema),
    readComponentAlgorithm: (identity, releaseId, key) => invoke('course', 'readComponentAlgorithm', identity, [releaseId, key], componentAlgorithmBundleSchema),
    readMaterial: (identity, releaseId, materialId) => invoke('course', 'readMaterial', identity, [releaseId, materialId], courseMaterialContentSchema),
  };
  const pdf: TeachingToolData['pdf'] = {
    read: (identity, activityId, value) => read('pdf.read', identity, activityId, [value], pdfReadingSchema),
    reading: (identity, activityId, id) => read('pdf.reading', identity, activityId, [id], pdfReadingSchema.nullable()),
    find: (identity, activityId, value) => read('pdf.find', identity, activityId, [value], pdfSearchResultSchema),
  };
  const data: Omit<TeachingToolData, 'executions'> = {
    open: (identity, activityId) => read('open', identity, activityId, [], activitySchema),
    works: {
      content: (identity, activityId, id) => read('works.content', identity, activityId, [id], workFileSchema.omit({ name: true })),
      inspectVersion: (identity, activityId, value) => read('works.inspectVersion', identity, activityId, [value], inspection),
    },
    drafts: { verifyReferences: async (identity, activityId, value) => { await read('drafts.verifyReferences', identity, activityId, [value], z.null()); } },
    pdf,
    materials: { readRange: (identity, activityId, id, version, value) =>
      read('materials.readRange', identity, activityId, [id, version, value], personalMaterialReadResultSchema) },
    artifacts: {
      list: (identity, activityId) => read('artifacts.list', identity, activityId, [], z.array(teachingArtifactSchema)),
      read: (identity, activityId, id) => read('artifacts.read', identity, activityId, [id], teachingArtifactSchema),
      revision: (identity, activityId, id, revision) => read('artifacts.revision', identity, activityId, [id, revision], teachingArtifactRevisionSchema),
      receipt: (identity, activityId, id) => read('artifacts.receipt', identity, activityId, [id], teachingArtifactReceiptSchema.nullable()),
      publish: async (identity, activityId, value, trusted) => {
        if (!trusted) throw new StorageError('forbidden');
        await trusted.assertDispatch();
        return read('artifacts.publish', identity, activityId, [value, trusted.origin], teachingArtifactReceiptSchema);
      },
    },
    search: createMaterialSearch({
      open: (identity, activityId) => read('open', identity, activityId, [], activitySchema), courses, pdf,
      personal: { original: (identity, activityId, id, version) =>
        read('materials.original', identity, activityId, [id, version], personalMaterialVersionContentSchema) },
    }),
  };
  async function recordExecution(identity: SpaceIdentity, activityId: string, value: unknown) {
    const event = executionRecordEventSchema.parse(value);
    const reply = await call({ version: 1, operation: 'execution.record', identity, activityId: z.uuid().parse(activityId),
      // Include the immutable event digest in the existing transport association. Different
      // status facts for one business request cannot collide in the effect transfer journal.
      args: [event, eventDigest(event)] });
    const record = executionRecordSchema.safeParse(reply);
    if (!record.success) throw new StorageError('unavailable');
    if (record.data.requestId !== event.requestId || record.data.inputDigest !== event.inputDigest
      || record.data.executionRef !== event.executionRef || record.data.installationId !== event.installationId
      || record.data.sourceOwner.environmentId !== event.sourceOwner.environmentId
      || record.data.sourceOwner.serviceId !== event.sourceOwner.serviceId
      || record.data.query.scope.activityId !== activityId || record.data.query.scope.environmentId !== identity.environmentId
      || record.data.query.scope.spaceId !== identity.spaceId || record.data.query.scope.principalId !== identity.principalId)
      throw new StorageError('identity-conflict');
    return record.data;
  }
  return { data, courses, recordExecution };
}

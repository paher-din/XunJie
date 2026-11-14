import { z } from 'zod';
import { StorageError } from '@xunjie/storage';
import { activitySchema, workFileSchema } from '@xunjie/contracts/learning-data';
import { questionDraftSyncSchema } from '@xunjie/contracts/question-drafts';
import { pdfReadingSchema, pdfSearchResultSchema } from '@xunjie/contracts/pdf-materials';
import { personalMaterialReadResultSchema, personalMaterialVersionContentSchema } from '@xunjie/contracts/personal-materials';
import { teachingArtifactSchema, teachingArtifactRevisionSchema, teachingArtifactReceiptSchema,
  teachingArtifactOriginSchema, teachingArtifactPublishSchema } from '@xunjie/contracts/teaching-artifacts';
import { componentBundleSchema, componentAlgorithmBundleSchema } from '@xunjie/contracts/components';
import { courseMaterialContentSchema } from '@xunjie/contracts/courses';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import type { TeachingToolData } from '../workspace-assistant/tools/tool-data.js';
import type { createLearningData } from '@xunjie/learning-space/learning-data';
import type { createCourses } from '@xunjie/learning-space/courses';
import { createMaterialSearch } from '@xunjie/learning-space/learning-data/material-search';

const inspection = z.object({ retained: z.boolean(), currentRevision: z.number().int().nonnegative(),
  isCurrent: z.boolean(), everPublished: z.boolean() }).strict();
type Data = ReturnType<typeof createLearningData>;
type Courses = Pick<ReturnType<typeof createCourses>, 'referenceText' | 'verifyComponentReference' | 'readComponent' | 'readComponentAlgorithm' | 'readMaterial'>;
/** Domain codec only. Version, peer ownership and dispatch permits belong to its caller. */
export interface WorkspaceDataCall {
  operation: 'data' | 'course';
  identity: SpaceIdentity;
  activityId?: string;
  args: unknown[];
}
export function createWorkspaceDataService(options: { learning: Data; courses: Courses; assertWritable(): Promise<void> }) {
  return async (input: WorkspaceDataCall) => {
    const identity = input.identity;
    if (!identity) throw new StorageError('invalid');
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
export function createWorkspaceDataClient(call: (input: WorkspaceDataCall) => Promise<unknown>) {
  async function invoke<T>(operation: 'data' | 'course', method: string, identity: SpaceIdentity,
    args: unknown[], schema: z.ZodType<T>, activityId?: string): Promise<T> {
    const value = await call({ operation, identity, ...(activityId ? { activityId } : {}), args: [method, args] });
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
  return { data, courses };
}

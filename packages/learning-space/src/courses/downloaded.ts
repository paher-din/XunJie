import { createHash } from 'node:crypto';
import { StorageError } from '@xunjie/storage';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import { courseReleaseSchema, courseMaterialContentSchema, courseReferenceTextSourceSchema,
  courseReferenceVerificationSchema, courseComponentReferenceVerificationSchema } from '@xunjie/contracts/courses';
import type { CourseBindingAuthority } from '@xunjie/contracts/courses';
import { componentBundleSchema, componentAlgorithmBundleSchema } from '@xunjie/contracts/components';
import { canonicalValue } from '@xunjie/contracts/execution';
import { referenceSelectionDigest, referenceTextSelection } from '../reference-text.js';

/** A downloaded release supplies the same narrow course authority without a school round trip. */
export function createDownloadedCourses(copies: {
  cached(identity: SpaceIdentity, key: string): Promise<unknown | null>;
  assertCourse(identity: SpaceIdentity, pointer: { associationId: string; releaseId: string; contentDigest: string }): Promise<void>;
}, authorize: (identity: SpaceIdentity) => Promise<void>) {
  const same = (a: unknown, b: unknown) => JSON.stringify(canonicalValue(a)) === JSON.stringify(canonicalValue(b));
  function verified(base64: string, expected: { byteLength: number; sha256: string }) {
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.toString('base64') !== base64 || bytes.byteLength !== expected.byteLength
      || createHash('sha256').update(bytes).digest('hex') !== expected.sha256) throw new StorageError('corrupt');
    return bytes;
  }
  async function read(identity: SpaceIdentity, key: string) {
    await authorize(identity);
    const value = await copies.cached(identity, key);
    if (value === null) throw new StorageError('unavailable');
    return value;
  }
  async function release(identity: SpaceIdentity, releaseId: string) {
    return courseReleaseSchema.parse(await read(identity, `releases/${releaseId}`));
  }
  async function readMaterial(identity: SpaceIdentity, releaseId: string, materialId: string) {
    const fixed = await release(identity, releaseId);
    const material = fixed.materials.find(item => item.materialId === materialId);
    if (!material) throw new StorageError('forbidden');
    const content = courseMaterialContentSchema.parse(await read(identity, `releases/${releaseId}/materials/${materialId}`));
    if (content.materialId !== material.materialId || content.mediaType !== material.mediaType
      || content.sha256 !== material.sha256 || content.byteLength !== material.byteLength)
      throw new StorageError('corrupt');
    verified(content.contentBase64, material);
    return content;
  }
  async function referenceText(identity: SpaceIdentity, value: unknown) {
    const source = courseReferenceTextSourceSchema.parse(value), fixed = await release(identity, source.releaseId);
    if (fixed.courseId !== source.courseId || fixed.taskId !== source.taskId || fixed.contentDigest !== source.contentDigest)
      throw new StorageError('forbidden');
    if (source.kind === 'course-field') return { text: fixed.requirements };
    const content = await readMaterial(identity, source.releaseId, source.materialId);
    if (content.sha256 !== source.materialSha256 || content.mediaType !== source.mediaType
      || !/^(?:text\/|application\/(?:json|xml))/i.test(content.mediaType)) throw new StorageError('forbidden');
    return { text: Buffer.from(content.contentBase64, 'base64').toString('utf8') };
  }
  async function readComponent(identity: SpaceIdentity, releaseId: string, key: string) {
    const fixed = await release(identity, releaseId), binding = fixed.components?.find(item => item.key === key);
    if (!binding) throw new StorageError('forbidden');
    const bundle = componentBundleSchema.parse(await read(identity, `releases/${releaseId}/components/${key}`));
    if (!same(bundle.definition, binding.definition)) throw new StorageError('corrupt');
    verified(bundle.contentBase64, binding.definition.manifest.entry);
    return bundle;
  }
  const verifyComponentReference = async (identity: SpaceIdentity, value: unknown) => {
    const reference = courseComponentReferenceVerificationSchema.parse(value);
    const bundle = await readComponent(identity, reference.releaseId, reference.key);
    if (bundle.definition.digest !== reference.definitionDigest) throw new StorageError('forbidden');
    return undefined;
  };
  const authority: CourseBindingAuthority = {
    prepare: async () => { throw new StorageError('forbidden'); },
    confirm: async () => { throw new StorageError('forbidden'); },
    authorize: async (identity, pointer) => { await authorize(identity); await copies.assertCourse(identity, pointer); },
    readMaterial,
    verifyReference: async (identity, value) => {
      const reference = courseReferenceVerificationSchema.parse(value);
      const { text } = await referenceText(identity, reference.source);
      if (referenceSelectionDigest(referenceTextSelection(text, reference.range)) !== reference.selectionDigest)
        throw new StorageError('invalid');
    },
    verifyComponentReference,
  };
  return { ...authority, readMaterial, verifyComponentReference, referenceText, readComponent,
    readComponentAlgorithm: async (identity: SpaceIdentity, releaseId: string, key: string) => {
      const component = await readComponent(identity, releaseId, key), manifest = component.definition.manifest;
      if (manifest.formatVersion !== 1 || !manifest.algorithm) throw new StorageError('forbidden');
      const algorithm = componentAlgorithmBundleSchema.parse(await read(identity, `releases/${releaseId}/components/${key}/algorithm`));
      if (!same(algorithm.definition, component.definition) || algorithm.entry !== manifest.algorithm.entry
        || algorithm.memoryPages !== manifest.algorithm.memoryPages || algorithm.sha256 !== manifest.algorithm.resource.sha256
        || algorithm.byteLength !== manifest.algorithm.resource.byteLength || algorithm.mediaType !== manifest.algorithm.resource.mediaType)
        throw new StorageError('corrupt');
      verified(algorithm.contentBase64, manifest.algorithm.resource);
      return algorithm;
    } };
}

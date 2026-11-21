import { MODEL_MESSAGE_IMAGE_LIMIT, modelMessageImagesSchema, type ModelImageRef } from '@xunjie/contracts/model-connections';
import type { LearningModelPort } from '@xunjie/model-gateway/service';
import { StorageError } from '@xunjie/storage';
import { canonicalDigest } from '@xunjie/storage/identity';
import type { GenerateInput } from './ports.js';
import { AgentError } from './errors.js';

/** Authorize fixed message images for the actual model segment before the request is committed. */
export async function resolveMessageImages(identity: GenerateInput['identity'], source: NonNullable<GenerateInput['messageImages']>,
  segmentId: string, supportsImages: boolean,
  gateway: LearningModelPort, previous: readonly ModelImageRef[]): Promise<ModelImageRef[]> {
  try {
    const fixed = await source.resolve({ segmentId, includeRetained: supportsImages });
    if (!fixed) return [...previous];
    const retained = fixed.retained ?? [];
    const attachments = [...fixed.images, ...retained.map(item => item.image)];
    if (attachments.length > MODEL_MESSAGE_IMAGE_LIMIT) throw new AgentError('image-continuation-capacity');
    const requested = modelMessageImagesSchema.parse(attachments);
    if (requested.length && !supportsImages) throw new AgentError('image-input-unavailable');
    const references = new Map(previous.map(image => [image.imageId, image]));
    const unique = new Map(requested.map(image => [image.imageId, image]));
    if (requested.some(image => canonicalDigest(unique.get(image.imageId)) !== canonicalDigest(image)))
      throw new StorageError('identity-conflict');
    if (new Set([...references.keys(), ...unique.keys()]).size > MODEL_MESSAGE_IMAGE_LIMIT)
      throw new AgentError('image-continuation-capacity');
    const retainedById = new Map(retained.map(item => [item.image.imageId, item]));
    const verify = async ({ imageId, version, sha256 }: typeof requested[number]) => {
      await source.assertActive();
      const image = await gateway.images.read(identity, { imageId, version });
      if (image.imageId !== imageId || image.version !== version || image.sha256 !== sha256
        || !image.attachmentScope || canonicalDigest(image.attachmentScope) !== canonicalDigest(fixed.scope))
        throw new StorageError('forbidden');
    };
    for (const image of unique.values()) {
      if (!retainedById.has(image.imageId) || fixed.images.some(item => item.imageId === image.imageId)) await verify(image);
    }
    for (const { image, dataBase64 } of retainedById.values()) {
      await source.assertActive();
      await gateway.images.upload(identity, { requestId: image.imageId, imageId: image.imageId,
        mediaType: 'image/png', dataBase64, attachmentScope: fixed.scope }, segmentId);
      await verify(image);
    }
    for (const { imageId, version } of unique.values()) references.set(imageId, { imageId, version });
    return [...references.values()];
  } catch (cause) {
    if (cause instanceof StorageError) throw new AgentError('image-source-unavailable');
    throw cause;
  }
}

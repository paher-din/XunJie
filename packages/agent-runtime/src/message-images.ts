import { MODEL_MESSAGE_IMAGE_LIMIT, modelMessageImageSchema, type ModelImageRef, type ModelMessageImage } from '@xunjie/contracts/model-connections';
import type { LearningModelPort } from '@xunjie/model-gateway/service';
import { StorageError } from '@xunjie/storage';
import { canonicalDigest, operationId } from '@xunjie/storage/identity';
import type { GenerateInput, MessageImages } from './ports.js';
import { AgentError } from './errors.js';

type Attachment = { image: ModelMessageImage; dataBase64?: string };

/** Authorize fixed message images for the actual model segment before the request is committed. */
export async function resolveMessageImages(identity: GenerateInput['identity'], source: NonNullable<GenerateInput['messageImages']>,
  segmentId: string, supportsImages: boolean,
  gateway: LearningModelPort, previous: readonly ModelImageRef[], rebuilt = false): Promise<ModelImageRef[]> {
  try {
    const route = { segmentId, includeRetained: supportsImages };
    const fixed = await source.resolve(route);
    const references = new Map(previous.map(image => [image.imageId, image]));
    function attachments(message: MessageImages | undefined) {
      const result = new Map<string, Attachment>();
      for (const item of [...(message?.images ?? []).map(image => ({ image })), ...(message?.retained ?? [])]) {
        const image = modelMessageImageSchema.parse(item.image);
        const existing = result.get(image.imageId);
        if (existing && canonicalDigest(existing.image) !== canonicalDigest(image)) throw new StorageError('identity-conflict');
        if (!existing) result.set(image.imageId, { ...item, image });
      }
      return result;
    }
    const current = attachments(fixed);
    if (current.size && !supportsImages) throw new AgentError('image-input-unavailable');
    if (current.size + references.size > MODEL_MESSAGE_IMAGE_LIMIT)
      throw new AgentError('image-continuation-capacity');
    async function importImage(scope: MessageImages['scope'], item: Attachment) {
      const { image, dataBase64 } = item;
      await source.assertActive();
      const original = dataBase64 === undefined
        ? await gateway.images.readAttachment(identity, { imageId: image.imageId, version: image.version }, scope)
        : { dataBase64, sha256: image.sha256 };
      if (original.sha256 !== image.sha256) throw new StorageError('forbidden');
      const imageId = dataBase64 === undefined
        ? operationId(`agent-message-image:${segmentId}:${image.imageId}:${image.version}`) : image.imageId;
      await source.assertActive();
      await gateway.images.upload(identity, { requestId: imageId, imageId,
        mediaType: 'image/png', dataBase64: original.dataBase64, attachmentScope: scope }, segmentId);
      const copy = await gateway.images.read(identity, { imageId, version: 1 });
      if (copy.imageId !== imageId || copy.version !== 1 || copy.sha256 !== image.sha256
        || !copy.attachmentScope || canonicalDigest(copy.attachmentScope) !== canonicalDigest(scope))
        throw new StorageError('forbidden');
      references.set(imageId, { imageId, version: 1 });
    }
    if (fixed) for (const item of current.values()) await importImage(fixed.scope, item);
    if (rebuilt && supportsImages && references.size < MODEL_MESSAGE_IMAGE_LIMIT) {
      const restored = await source.restore?.(route);
      if (restored) {
        for (const [id, item] of [...attachments(restored)].reverse()) {
          if (references.size >= MODEL_MESSAGE_IMAGE_LIMIT) break;
          if (current.has(id)) continue;
          try { await importImage(restored.scope, item); }
          catch (error) {
            if (!(error instanceof StorageError) || !['missing', 'forbidden', 'resource-gone'].includes(error.code)) throw error;
          }
        }
      }
    }
    return [...references.values()];
  } catch (cause) {
    if (cause instanceof StorageError) throw new AgentError('image-source-unavailable');
    throw cause;
  }
}

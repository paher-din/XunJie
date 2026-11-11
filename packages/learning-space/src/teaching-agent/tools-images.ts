import { createHash } from 'node:crypto';
import { StorageError } from '@xunjie/storage';
import type { WorkFile } from '@xunjie/contracts/learning-data';
import type { LearningModelPort } from '../model-connections/service.js';
import type { TeachingToolScope } from './tool-types.js';
import type { PdfReading } from '@xunjie/contracts/pdf-materials';
import { modelAllowsImages } from '@xunjie/contracts/model-connections';
export type TeachingImageModels = Pick<LearningModelPort, 'images' | 'segments'>;
export async function imageRoute(scope: TeachingToolScope, models?: TeachingImageModels) {
  if (!models || !scope.segmentId) return { available: false as const, reason: 'fixed-model-segment-required' };
  const segment = await models.segments.read(scope.identity, scope.segmentId);
  return { available: modelAllowsImages(segment.connection), segmentId: segment.segmentId,
    connection: segment.connection };
}
function imageIdentity(kind: string, commandId: string, contentId: string) {
  const hex = createHash('sha256').update(`${kind}:${commandId}:${contentId}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
/** Only WP06 validates PNG structure, dimensions and CRC; no image capability is learned here. */
export async function retainWorkImage(scope: TeachingToolScope, models: TeachingImageModels, commandId: string, file: WorkFile) {
  if (file.mediaType !== 'image/png' || file.encoding !== 'base64' || file.value.length > 350000) throw new StorageError('invalid');
  const bytes = Buffer.from(file.value, 'base64');
  if (bytes.length > 262144 || bytes.toString('base64') !== file.value) throw new StorageError('invalid');
  const reference = { imageId: imageIdentity('teaching-work-image', commandId, file.contentId), version: 1 as const };
  await models.images.upload(scope.identity, { requestId: imageIdentity('teaching-work-image-upload', commandId, file.contentId),
    imageId: reference.imageId, mediaType: 'image/png', dataBase64: file.value });
  const image = await models.images.read(scope.identity, reference);
  return { reference, image, byteLength: bytes.length };
}

/** Image identities are tied to the original command and retained PDF rendition, never a filename. */
export async function retainPdfImages(scope: TeachingToolScope, models: TeachingImageModels, commandId: string, reading: PdfReading) {
  const retained = [];
  for (const page of reading.pages) {
    if (page.state !== 'ready' || !page.image) continue;
    const bytes = Buffer.from(page.image.dataBase64, 'base64');
    if (createHash('sha256').update(bytes).digest('hex') !== page.image.sha256) throw new StorageError('corrupt');
    const key = reading.readingId + ':' + page.page;
    const reference = { imageId: imageIdentity('teaching-pdf-image', commandId, key), version: 1 as const };
    await models.images.upload(scope.identity, { requestId: imageIdentity('teaching-pdf-image-upload', commandId, key),
      imageId: reference.imageId, mediaType: 'image/png', dataBase64: page.image.dataBase64 });
    const image = await models.images.read(scope.identity, reference);
    retained.push({ page: page.page, reference, sha256: image.sha256 });
  }
  return retained;
}

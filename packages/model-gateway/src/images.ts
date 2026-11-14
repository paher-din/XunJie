import { createHash } from 'node:crypto';
import { crc32, inflateSync } from 'node:zlib';
import { StorageError, type OwnedStorage, type OwnedTransaction } from '@xunjie/storage';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import { modelImageInputSchema, modelImageRefSchema } from '@xunjie/contracts/model-connections';
import type { ModelImageRef } from '@xunjie/contracts/model-connections';
import { modelScopeOf } from './selection.js';

type Image = ModelImageRef & { resourceId: string; mediaType: 'image/png'; byteLength: number; sha256: string;
  source?: ModelImageRef & { transformation: string } };
function validatePng(bytes: Buffer) {
  if (bytes.length > 262144 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new StorageError('invalid');
  let offset = 8, header = false, ended = false, width = 0, height = 0, depth = 0, color = 0, palette = false, dataEnded = false;
  const data: Buffer[] = [];
  while (offset + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(offset), end = offset + size + 12;
    if (end > bytes.length) throw new StorageError('invalid');
    const type = bytes.toString('ascii', offset + 4, offset + 8), chunk = bytes.subarray(offset + 8, end - 4);
    if (!/^[A-Za-z]{4}$/.test(type) || !header && type !== 'IHDR') throw new StorageError('invalid');
    if (data.length && type !== 'IDAT') dataEnded = true;
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) throw new StorageError('invalid');
    if (type === 'IHDR') {
      if (header || offset !== 8 || size !== 13) throw new StorageError('invalid');
      width = chunk.readUInt32BE(0); height = chunk.readUInt32BE(4); header = true;
      depth = chunk[8]!; color = chunk[9]!;
      if (!width || !height || width > 2048 || height > 2048 || chunk[10] !== 0 || chunk[11] !== 0 || chunk[12] !== 0) throw new StorageError('invalid');
      const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!depths[color]?.includes(depth)) throw new StorageError('invalid');
    } else if (type === 'PLTE') {
      if (palette || data.length || !size || size % 3 || size > 768 || color === 3 && size / 3 > 2 ** depth) throw new StorageError('invalid');
      palette = true;
    } else if (type === 'IDAT') {
      if (dataEnded || color === 3 && !palette) throw new StorageError('invalid'); data.push(chunk);
    }
    else if (type === 'IEND') { if (size !== 0 || end !== bytes.length) throw new StorageError('invalid'); ended = true; }
    else if (type[0] === type[0]!.toUpperCase()) throw new StorageError('invalid');
    offset = end;
  }
  if (!header || !ended || offset !== bytes.length || !data.length) throw new StorageError('invalid');
  try {
    const pixels = inflateSync(Buffer.concat(data), { maxOutputLength: 17000000 });
    const channels: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
    const rowBytes = 1 + Math.ceil(width * channels[color]! * depth / 8);
    if (pixels.length !== height * rowBytes) throw new Error();
    for (let row = 0; row < height; row++) if (pixels[row * rowBytes]! > 4) throw new Error();
  }
  catch { throw new StorageError('invalid'); }
}
export function createModelImages(storage: OwnedStorage, authorize: (identity: SpaceIdentity) => Promise<void>, assertWritable: () => void) {
  async function read(identity: SpaceIdentity, reference: ModelImageRef): Promise<Image> {
    await authorize(identity); modelImageRefSchema.parse({ imageId: reference.imageId, version: reference.version });
    const { rows: [row] } = await storage.read('SELECT body FROM model_images WHERE id=$1 AND scope=$2', [reference.imageId, modelScopeOf(identity)]);
    if (!row) throw new StorageError('forbidden');
    const image = row.body as Image;
    if (image.version !== reference.version) throw new StorageError('conflict');
    return image;
  }
  async function upload(identity: SpaceIdentity, value: unknown) {
    assertWritable(); await authorize(identity);
    const input = modelImageInputSchema.parse(value), bytes = Buffer.from(input.dataBase64, 'base64');
    if (bytes.toString('base64') !== input.dataBase64) throw new StorageError('invalid');
    validatePng(bytes);
    const source = input.source ? await read(identity, input.source) : null;
    const sha256 = createHash('sha256').update(bytes).digest('hex'), scope = modelScopeOf(identity);
    const hash = createHash('sha256').update(JSON.stringify({ scope, ...input, dataBase64: sha256 })).digest('hex');
    const prior = await storage.receipt('model-image:' + input.requestId, hash); if (prior) return prior.result;
    const resource = await storage.stageResource({ uploadId: input.imageId, scope: 'model-image:' + input.imageId,
      bytes, mediaType: 'image/png', contentVersion: 1 });
    const body: Image = { imageId: input.imageId, version: 1, mediaType: 'image/png', byteLength: bytes.length, sha256,
      resourceId: resource.resourceId, ...(input.source ? { source: input.source } : {}) };
    return (await storage.request({ requestId: 'model-image:' + input.requestId, fingerprint: hash }, async tx => {
      await tx.query('INSERT INTO model_images VALUES($1,$2,$3)', [input.imageId, scope, body]);
      await tx.reference('model-image:' + input.imageId, resource.resourceId);
      if (source) await tx.reference('model-image-source:' + input.imageId, source.resourceId);
      return body;
    })).result;
  }
  async function materialize(identity: SpaceIdentity, references: ModelImageRef[]) {
    const images: Image[] = [], content: { type: 'image_url'; image_url: { url: string } }[] = [];
    for (const reference of references) {
      const image = await read(identity, reference), bytes = Buffer.from(await storage.readResource(image.resourceId));
      validatePng(bytes); images.push(image);
      content.push({ type: 'image_url', image_url: { url: 'data:image/png;base64,' + bytes.toString('base64') } });
    }
    return { content, async retain(tx: OwnedTransaction, attemptId: string) {
      for (const image of images) await tx.reference('model-attempt-image:' + attemptId + ':' + image.imageId, image.resourceId);
    } };
  }
  async function validate() {
    const { rows } = await storage.read('SELECT body FROM model_images');
    for (const row of rows) {
      const image = row.body as Image; modelImageRefSchema.parse({ imageId: image.imageId, version: image.version });
      const bytes = Buffer.from(await storage.readResource(image.resourceId)); validatePng(bytes);
      if (image.mediaType !== 'image/png' || image.byteLength !== bytes.length || image.sha256 !== createHash('sha256').update(bytes).digest('hex')) throw new StorageError('corrupt');
    }
  }
  return { upload, read, materialize, validate };
}

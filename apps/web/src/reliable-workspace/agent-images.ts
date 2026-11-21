import { useEffect, useState } from 'react'
import { modelImageAttachmentScopeSchema, modelMessageImageSchema } from '@xunjie/contracts/model-connections'
import type { ModelImageAttachmentScope, ModelMessageImage } from '@xunjie/contracts/model-connections'
import { ReliableRecordStore } from './record-store'

export const AGENT_IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp'
export const IMAGE_MODEL_HINT = '请选择支持图片输入的模型。'
export type AgentImageSource = File | { name: string; dataBase64: string }
const previews = new ReliableRecordStore<{ key: string; src: string }>('agentImages')
const previewKey = (subject: string, image: ModelMessageImage) => JSON.stringify([subject, image.imageId, image.sha256])

export const isAgentImage = (file: File) => /^image\//i.test(file.type) || /\.(png|jpe?g|webp)$/i.test(file.name)

async function convertImage(file: File): Promise<ArrayBuffer> {
  if (!file.size || file.size > 20 * 1024 * 1024) throw new Error('请选择 20 MiB 以内的图片。')
  if (file.type ? !/^image\/(png|jpeg|webp)$/i.test(file.type) : !/\.(png|jpe?g|webp)$/i.test(file.name))
    throw new Error('请选择 PNG、JPEG 或 WebP 图片。')
  const image = await createImageBitmap(file).catch(() => { throw new Error('无法读取这张图片。') })
  try {
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) throw new Error('当前浏览器无法处理图片。')
    for (let ratio = Math.min(1, 2048 / Math.max(image.width, image.height)); ratio >= 0.02; ratio *= 0.8) {
      canvas.width = Math.max(1, Math.round(image.width * ratio))
      canvas.height = Math.max(1, Math.round(image.height * ratio))
      context.fillStyle = 'white'
      context.fillRect(0, 0, canvas.width, canvas.height)
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
      if (blob && blob.size <= 262_144) return blob.arrayBuffer()
    }
    throw new Error('图片压缩后仍超出大小限制。')
  } finally { image.close() }
}

export async function uploadAgentImage(subject: string, attachmentScope: ModelImageAttachmentScope, source: AgentImageSource,
  upload: (body: unknown) => Promise<unknown>): Promise<ModelMessageImage> {
  const isPage = 'dataBase64' in source
  const bytes = isPage ? Uint8Array.from(atob(source.dataBase64), character => character.charCodeAt(0)) : new Uint8Array(await convertImage(source))
  if (!bytes.length || bytes.length > 262_144) throw new Error('图片超出大小限制。')
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    byte => byte.toString(16).padStart(2, '0')).join('')
  const chunks: string[] = []
  if (!isPage) for (let offset = 0; offset < bytes.length; offset += 32768)
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)))
  const dataBase64 = isPage ? source.dataBase64 : btoa(chunks.join(''))
  const imageId = crypto.randomUUID(), name = source.name.trim().slice(0, 240) || '粘贴的图片'
  const result = await upload({ requestId: imageId, imageId, mediaType: 'image/png', dataBase64, attachmentScope }) as Record<string, unknown>
  const image = modelMessageImageSchema.parse({ imageId: result.imageId, version: result.version, sha256: result.sha256, name })
  const confirmed = modelImageAttachmentScopeSchema.safeParse(result.attachmentScope)
  if (image.imageId !== imageId || image.sha256 !== sha256 || !confirmed.success
    || JSON.stringify(confirmed.data) !== JSON.stringify(attachmentScope)) throw new Error('图片回执与所选附件不一致。')
  const key = previewKey(subject, image)
  await previews.change(key, () => ({ key, src: 'data:image/png;base64,' + dataBase64 })).catch(() => {})
  return image
}

export function useAgentImagePreviews(subject: string, images: readonly ModelMessageImage[]) {
  const keys = JSON.stringify(images.map(image => [image.imageId, previewKey(subject, image)]))
  const [loaded, setLoaded] = useState<{ keys: string; urls: Record<string, string> }>({ keys: '', urls: {} })
  useEffect(() => {
    let active = true
    const entries = JSON.parse(keys) as [string, string][]
    if (entries.length) void Promise.all(entries.map(async ([id, key]) =>
      [id, (await previews.read(key).catch(() => undefined))?.src ?? ''] as const))
      .then(values => { if (active) setLoaded({ keys, urls: Object.fromEntries(values) }) })
    return () => { active = false }
  }, [keys])
  return loaded.keys === keys ? loaded.urls : {}
}

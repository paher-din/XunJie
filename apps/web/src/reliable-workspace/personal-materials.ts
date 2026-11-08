import { PERSONAL_MATERIAL_LIMITS, personalMaterialRemoveSchema, personalMaterialSaveSchema,
  personalMaterialSchema, personalMaterialUpdateSchema, type PersonalMaterial, type PersonalMaterialMediaType,
  type PersonalMaterialRemove, type PersonalMaterialSave, type PersonalMaterialUpdate } from '@xunjie/contracts/personal-materials'
import { openWorkspaceDatabase } from './draft-store'
import { ReliableRecordStore } from './record-store'

/** A material change commits to this browser before any network request is attempted. */
export type PersonalMaterialRequest = { key: string; scope: string; activityId: string; name: string; sha256?: string
  material?: PersonalMaterial } & (
  | { kind: 'save'; input: PersonalMaterialSave }
  | { kind: 'update'; input: PersonalMaterialUpdate }
  | { kind: 'remove'; input: PersonalMaterialRemove }
)
export type PersonalMaterialSaveRequest = PersonalMaterialRequest & { kind: 'save'; input: PersonalMaterialSave }
export type PersonalMaterialUpdateRequest = PersonalMaterialRequest & { kind: 'update'; input: PersonalMaterialUpdate }
export type PersonalMaterialRemoveRequest = PersonalMaterialRequest & { kind: 'remove'; input: PersonalMaterialRemove }

const records = new ReliableRecordStore<PersonalMaterialRequest>('personalMaterials')
export async function listPersonalMaterialRequests(scope: string): Promise<PersonalMaterialRequest[]> {
  const db = await openWorkspaceDatabase()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('personalMaterials', 'readonly')
    const request = tx.objectStore('personalMaterials').index('scope').getAll(scope)
    tx.oncomplete = () => resolve(request.result)
    tx.onabort = () => reject(tx.error)
    tx.onerror = () => {}
  })
}

const requestKey = (scope: string, requestId: string) => JSON.stringify([scope, requestId])
const encoder = new TextEncoder()
function base64Of(bytes: Uint8Array) {
  const chunks: string[] = []
  for (let offset = 0; offset < bytes.length; offset += 32768) chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)))
  return btoa(chunks.join(''))
}
async function sha256Of(bytes: Uint8Array<ArrayBuffer>) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('')
}
function validatedText(text: string) {
  if (!text.trim()) throw new Error('个人笔记正文不能为空。')
  const bytes = encoder.encode(text)
  if (bytes.length > PERSONAL_MATERIAL_LIMITS.inputBytes) throw new Error('个人笔记超过 2 MiB，请缩减后再添加。')
  return bytes
}
function validatedName(name: string) {
  const value = name.trim()
  if (!value) throw new Error('请填写个人笔记名称。')
  if (value.length > PERSONAL_MATERIAL_LIMITS.nameLength) throw new Error(`个人笔记名称需在 ${PERSONAL_MATERIAL_LIMITS.nameLength} 个字符以内。`)
  return value
}

export async function retainPersonalMaterialSave(scope: string, activityId: string, input: {
  name: string; mediaType: PersonalMaterialMediaType; text: string
}): Promise<PersonalMaterialSaveRequest> {
  const name = validatedName(input.name), bytes = validatedText(input.text)
  const save = personalMaterialSaveSchema.parse({ requestId: crypto.randomUUID(), materialId: crypto.randomUUID(),
    name, mediaType: input.mediaType, dataBase64: base64Of(bytes) })
  const record: PersonalMaterialSaveRequest = { key: requestKey(scope, save.requestId), scope, activityId, name,
    sha256: await sha256Of(bytes), kind: 'save', input: save }
  try { return await records.change<PersonalMaterialSaveRequest>(record.key, saved => (saved as PersonalMaterialSaveRequest | undefined) ?? record) }
  catch { throw new Error('个人笔记尚未在本机可靠保存，未开始提交。请检查浏览器存储空间后重试。') }
}

export async function retainPersonalMaterialUpdate(scope: string, activityId: string, material: PersonalMaterial, input: {
  name?: string; mediaType?: PersonalMaterialMediaType; text?: string
}): Promise<PersonalMaterialUpdateRequest> {
  if (material.currentVersion >= PERSONAL_MATERIAL_LIMITS.versions)
    throw new Error(`个人笔记已达到 ${PERSONAL_MATERIAL_LIMITS.versions} 个版本上限，请新建一份材料。`)
  if (input.name === undefined && input.mediaType === undefined && input.text === undefined)
    throw new Error('没有需要更新的内容。')
  const name = input.name === undefined ? undefined : validatedName(input.name)
  const bytes = input.text === undefined ? undefined : validatedText(input.text)
  const update = personalMaterialUpdateSchema.parse({ requestId: crypto.randomUUID(), materialId: material.materialId,
    expectedVersion: material.currentVersion, ...(name === undefined ? {} : { name }),
    ...(input.mediaType === undefined ? {} : { mediaType: input.mediaType }),
    ...(bytes === undefined ? {} : { dataBase64: base64Of(bytes) }) })
  const record: PersonalMaterialUpdateRequest = { key: requestKey(scope, update.requestId), scope, activityId,
    name: name ?? material.name, ...(bytes === undefined ? {} : { sha256: await sha256Of(bytes) }), kind: 'update', input: update }
  try { return await records.change<PersonalMaterialUpdateRequest>(record.key, saved => (saved as PersonalMaterialUpdateRequest | undefined) ?? record) }
  catch { throw new Error('个人笔记更新尚未在本机可靠保存，未开始提交。请检查浏览器存储空间后重试。') }
}

export async function retainPersonalMaterialRemove(scope: string, activityId: string, material: PersonalMaterial): Promise<PersonalMaterialRemoveRequest> {
  const remove = personalMaterialRemoveSchema.parse({ requestId: crypto.randomUUID(), materialId: material.materialId,
    expectedVersion: material.currentVersion })
  const record: PersonalMaterialRemoveRequest = { key: requestKey(scope, remove.requestId), scope, activityId, name: material.name,
    kind: 'remove', input: remove }
  try { return await records.change<PersonalMaterialRemoveRequest>(record.key, saved => (saved as PersonalMaterialRemoveRequest | undefined) ?? record) }
  catch { throw new Error('个人笔记移除请求尚未在本机可靠保存，未开始提交。请检查浏览器存储空间后重试。') }
}

/** An acknowledgement must match the original immutable request; a rename or newer version never rebinds it. */
export async function acknowledgePersonalMaterialRequest(record: PersonalMaterialRequest, value: unknown): Promise<PersonalMaterial> {
  const material = personalMaterialSchema.parse(value)
  const versionAt = (version: number) => material.versions.find(item => item.version === version)
  if (material.materialId !== record.input.materialId)
    throw new Error('个人笔记接收身份或内容不一致，已保留原请求，请核对原服务。')
  if (record.kind === 'save') {
    const version = versionAt(1)
    if (!version || version.requestId !== record.input.requestId || (record.sha256 && version.sha256 !== record.sha256)
      || version.name !== record.input.name || version.mediaType !== record.input.mediaType)
      throw new Error('个人笔记接收身份或内容不一致，已保留原请求，请核对原服务。')
  } else if (record.kind === 'update') {
    const version = versionAt(record.input.expectedVersion + 1)
    if (!version || version.requestId !== record.input.requestId || (record.sha256 && version.sha256 !== record.sha256)
      || material.currentVersion < version.version
      || (record.input.name !== undefined && version.name !== record.input.name)
      || (record.input.mediaType !== undefined && version.mediaType !== record.input.mediaType))
      throw new Error('个人笔记更新回执与本次请求不一致，已保留原请求，请核对原服务。')
  } else if (!material.removedAt || !versionAt(record.input.expectedVersion)) {
    throw new Error('个人笔记移除回执与本次请求不一致，已保留原请求，请核对原服务。')
  }
  await records.change(record.key, saved => ({ ...(saved ?? record), material }))
  return material
}

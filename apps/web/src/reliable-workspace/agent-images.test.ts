import 'fake-indexeddb/auto'
import { expect, it, vi } from 'vitest'
import type { ModelImageAttachmentScope } from '@xunjie/contracts/model-connections'
import { uploadAgentImage } from './agent-images'

it('replays the fixed upload after a lost receipt and deduplicates confirmed attachments', async () => {
  const scope: ModelImageAttachmentScope = { kind: 'session', sessionId: crypto.randomUUID() }
  const source = { name: 'page.png', dataBase64: 'AA==' }
  const sha256 = '6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d'
  const upload = vi.fn(async (value: unknown) => ({ ...value as object, version: 1, sha256 }))
    .mockRejectedValueOnce(new TypeError('Connection closed after commit'))
  const subject = crypto.randomUUID()

  await expect(uploadAgentImage(subject, scope, source, upload)).rejects.toThrow('Connection closed after commit')
  const retried = await uploadAgentImage(subject, scope, source, upload)
  expect(upload.mock.calls[1]).toEqual(upload.mock.calls[0])
  expect(await uploadAgentImage(subject, scope, source, upload)).toEqual(retried)
  expect(upload).toHaveBeenCalledTimes(2)
})

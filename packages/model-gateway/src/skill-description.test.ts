import { expect, it, vi } from 'vitest'
import type { OwnedStorage } from '@xunjie/storage'
import type { LearningModelPort } from './service'
import { createSkillDescriptionTranslator, skillDescriptionText } from './skill-description'

it('unwraps JSON descriptions and fenced translations, including cached JSON strings', () => {
  expect(skillDescriptionText('{"description":"在此工作区内教授技能。"}')).toBe('在此工作区内教授技能。')
  expect(skillDescriptionText('```json\n{"description":"中文说明"}\n```')).toBe('中文说明')
  expect(skillDescriptionText('保持这段中文。')).toBe('保持这段中文。')
})

it('shares in-flight translation, caches by owner and Skill version, and skips Chinese descriptions', async () => {
  const saved = new Map<string, { result: unknown }>()
  const storage = { receipt: async (key: string) => saved.get(key),
    request: async ({ requestId }: { requestId: string }, action: () => Promise<unknown>) => {
      const receipt = { result: await action() }; saved.set(requestId, receipt); return receipt
    } } as unknown as OwnedStorage
  const receive = vi.fn(async () => ({ state: 'completed', physicalRequestEnded: true, text: '用例子解释概念。' }))
  const models = { selection: { read: async () => ({ version: 1, selected: { connection: { maxOutputTokens: 4096 } } }) },
    segments: { create: vi.fn(async () => {}), read: async () => ({ sequence: 1 }), close: async () => {} },
    checks: { receive } } as unknown as LearningModelPort
  const translate = createSkillDescriptionTranslator(storage, models)
  const identity = { environmentId: crypto.randomUUID(), spaceId: crypto.randomUUID(), principalId: crypto.randomUUID() }
  const reference = { skillId: crypto.randomUUID(), version: 1 }
  expect(await Promise.all([translate(identity, 'Explain concepts with examples.', reference),
    translate(identity, 'Explain concepts with examples.', reference)])).toEqual(['用例子解释概念。', '用例子解释概念。'])
  await translate(identity, 'Explain concepts with examples.', reference)
  expect(receive).toHaveBeenCalledTimes(1)
  await translate(identity, 'Explain concepts with examples.', { ...reference, version: 2 })
  await translate({ ...identity, principalId: crypto.randomUUID() }, 'Explain concepts with examples.', reference)
  expect(receive).toHaveBeenCalledTimes(3)
  expect(await translate(identity, '这是中文说明。', reference)).toBe('这是中文说明。')
  expect(receive).toHaveBeenCalledTimes(3)
})

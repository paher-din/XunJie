// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { skillCommandAt } from './ProductPromptInput'
import { consumeSessionSkillSelection, sessionDraftSkillsKey, sessionSkillResetKey } from './session-draft-skills'

it('finds only the slash command at the caret and leaves surrounding draft text outside its range', () => {
  expect(skillCommandAt('/teach')).toEqual({ start: 0, end: 6, query: 'teach' })
  const value = '请先 /te 后续内容'
  const command = skillCommandAt(value, 6)!
  expect(command).toEqual({ start: 3, end: 6, query: 'te' })
  expect(value.slice(0, command.start) + value.slice(command.end)).toBe('请先  后续内容')
  expect(skillCommandAt('下一步 /')).toEqual({ start: 4, end: 5, query: '' })
  expect(skillCommandAt('/讲解')).toEqual({ start: 0, end: 3, query: '讲解' })
})

it('does not turn URLs, file paths, ordinary slash text or stale caret positions into commands', () => {
  for (const value of ['https://example.com/file', '/folder/file', 'word/teach', '/teach 已结束', '/' + 'a'.repeat(81)])
    expect(skillCommandAt(value)).toBeNull()
  expect(skillCommandAt('/teach', -1)).toBeNull()
  expect(skillCommandAt('/teach', 20)).toBeNull()
})

it('consumes a skill selection only for the target conversation and records its server reset turn', () => {
  localStorage.clear()
  const identity = { kind: 'personal' as const, environmentId: crypto.randomUUID(), spaceId: crypto.randomUUID(),
    principalId: crypto.randomUUID(), name: '个人' }
  const nextSession = crypto.randomUUID(), otherSession = crypto.randomUUID(), turnId = crypto.randomUUID()
  const newKey = sessionDraftSkillsKey(identity, 'personal', 'test')
  localStorage.setItem(newKey, JSON.stringify([{ skillId: crypto.randomUUID(), version: 1 }]))
  consumeSessionSkillSelection({ identity, spaceKey: 'personal', namespace: 'test', nextSessionId: nextSession,
    clientScope: 'scope', turnId })
  expect(localStorage.getItem(newKey)).toBeNull()
  expect(localStorage.getItem(sessionDraftSkillsKey(identity, 'personal', 'test', nextSession))).toBe('[]')
  expect(localStorage.getItem(sessionDraftSkillsKey(identity, 'personal', 'test', otherSession))).toBeNull()
  expect(JSON.parse(localStorage.getItem(sessionSkillResetKey('scope', nextSession))!)).toMatchObject({ turnId })
})

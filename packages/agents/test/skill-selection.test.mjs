import assert from 'node:assert/strict'
import { test } from 'node:test'
import { selectedSkillInstruction } from '../dist/capabilities/skills/index.js'

const skill = { skillId: '11111111-1111-4111-8111-111111111111', version: 2, name: 'evidence-check',
  description: '检查证据和结论。', selected: true, disabled: false, unavailable: undefined }

test('turns explicit session Skills into a mandatory load instruction for the current Turn', () => {
  const instruction = selectedSkillInstruction({ catalog: [skill] })
  assert.match(instruction, /必须/)
  assert.match(instruction, /skill_load/)
  assert.match(instruction, /evidence-check/)
  assert.match(instruction, new RegExp(skill.skillId))
  assert.match(instruction, /不得只凭名称/)
})

test('does not instruct the model to load unavailable, disabled, or unselected Skills', () => {
  assert.equal(selectedSkillInstruction({ catalog: [{ ...skill, selected: false }] }), undefined)
  assert.equal(selectedSkillInstruction({ catalog: [{ ...skill, disabled: true }] }), undefined)
  assert.equal(selectedSkillInstruction({ catalog: [{ ...skill, unavailable: { reason: 'not-selected', detail: 'none' } }] }), undefined)
})

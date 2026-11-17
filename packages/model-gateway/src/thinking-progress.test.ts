import { expect, it } from 'vitest'
import { createThinkingProgress } from './thinking-progress'

it('keeps split credentials out of live and final thinking', () => {
  const received: string[] = [], secret = 'synthetic-test-secret'
  const thinking = createThinkingProgress(secret, text => received.push(text))
  thinking.append('检查条件。'.repeat(10) + 'synthetic-test-')
  thinking.append('secret')
  thinking.finish()
  expect(received.length).toBeGreaterThan(0)
  expect(received.every(text => !text.includes(secret))).toBe(true)
  expect(received.at(-1)).toContain('[redacted]')
})

it('bounds thinking and flushes short final text without generating placeholders', () => {
  const received: string[] = [], thinking = createThinkingProgress('synthetic-test-secret', text => received.push(text))
  thinking.append('检查条件'); thinking.finish()
  expect(received.at(-1)).toBe('检查条件')
  thinking.append('更多'.repeat(10000)); thinking.finish()
  expect(received.at(-1)!.length).toBeLessThanOrEqual(16000)
})

import { expect, it } from 'vitest'
import { orderedAgentTrace } from './trace-order'

it('interleaves thinking and tools by Step and event time while preserving thinking-first ties', () => {
  const at = (second: number) => new Date(Date.UTC(2026, 10, 16, 0, 0, second)).toISOString()
  const ordered = orderedAgentTrace([
    { id: 'thinking-2', stepNo: 2, createdAt: at(4) },
    { id: 'thinking-1', stepNo: 1, createdAt: at(1) },
    { id: 'thinking-tie', stepNo: 1, createdAt: at(2) },
  ], [
    { id: 'tool-2', stepNo: 2, createdAt: at(5) },
    { id: 'tool-1', stepNo: 1, createdAt: at(2) },
  ])
  expect(ordered.map(entry => entry.item.id)).toEqual([
    'thinking-1', 'thinking-tie', 'tool-1', 'thinking-2', 'tool-2',
  ])
})

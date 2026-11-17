type Ordered = { stepNo?: number; createdAt?: string }

export type AgentTraceEntry<T extends Ordered, U extends Ordered> =
  | { kind: 'thinking'; item: T; order: number }
  | { kind: 'tool'; item: U; order: number }

/** One chronological stream uses Step order first and the real event time within that Step. */
export function orderedAgentTrace<T extends Ordered, U extends Ordered>(thinking: readonly T[], tools: readonly U[]) {
  return [
    ...thinking.map((item, index) => ({ kind: 'thinking' as const, item, order: index * 2 })),
    ...tools.map((item, index) => ({ kind: 'tool' as const, item, order: index * 2 + 1 })),
  ].sort((left, right) => {
    const leftStep = left.item.stepNo ?? Number.MAX_SAFE_INTEGER
    const rightStep = right.item.stepNo ?? Number.MAX_SAFE_INTEGER
    if (leftStep !== rightStep) return leftStep - rightStep
    const leftAt = left.item.createdAt ?? '9999-12-31T23:59:59.999Z'
    const rightAt = right.item.createdAt ?? '9999-12-31T23:59:59.999Z'
    const time = leftAt.localeCompare(rightAt)
    if (time) return time
    const kind = (left.kind === 'thinking' ? 0 : 1) - (right.kind === 'thinking' ? 0 : 1)
    return kind || left.order - right.order
  })
}

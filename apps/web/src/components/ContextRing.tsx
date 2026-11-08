import { ContextRing as ContextRingView } from '@xunjie/ui/foundation'

/** 旧版演示窗口上限，真实容量由正式组件的调用方显式传入。 */
export const CONTEXT_LIMIT = 300_000
export function ContextRing({ tokens }: { tokens: number }) {
  return <ContextRingView tokens={tokens} limit={CONTEXT_LIMIT} />
}

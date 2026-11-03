import type { ComponentEvent } from '@xunjie/contracts/components'

export interface ComponentInteraction { instanceId: string; connectionId: string; event: ComponentEvent }
/** Transient host observations only; no learning judgement, model invocation or persistence queue. */
export class ComponentInteractions {
  private latest = new Map<string, ComponentInteraction>()
  private listeners = new Set<(value: ComponentInteraction) => void>()
  accept(value: ComponentInteraction) {
    this.latest.set(value.instanceId, structuredClone(value))
    for (const listener of this.listeners) listener(structuredClone(value))
  }
  read(instanceId: string) { const value = this.latest.get(instanceId); return value && structuredClone(value) }
  subscribe(listener: (value: ComponentInteraction) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
}

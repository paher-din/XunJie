import { canonicalDigest, operationId } from '@xunjie/storage/identity';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import type { AgentStore } from './store.js';
import type { ModelGatewaySource } from './model.js';
import { resolveGateway } from './model.js';
import { AgentError } from './errors.js';
import type { Facts, RuleVersion, TurnRuntime } from './ports.js';

export interface TurnRuntimeSource {
  scenario: { id: string; version: number };
  gateway: ModelGatewaySource;
}

/** Freeze the selected route once before any Step runs. A later selection edit cannot affect this Turn. */
export async function ensureTurnRuntime(store: AgentStore, source: TurnRuntimeSource,
  identity: SpaceIdentity, sessionId: string, turnId: string): Promise<TurnRuntime> {
  const existing = await store.turnRuntime(turnId);
  if (existing) return existing;
  const gateway = await resolveGateway(source.gateway, identity, sessionId);
  const selection = await gateway.selection.read(identity);
  if (!selection.selected) throw new AgentError('model-not-selected');
  const pinId = operationId('agent-turn-pin:' + turnId);
  const pinned = await gateway.selection.pin(identity, pinId, selection.version);
  const runtime: TurnRuntime = {
    formatVersion: 1,
    scenario: source.scenario,
    model: { selectionVersion: selection.version, pinId, connection: pinned.choice.connection,
      source: pinned.source as unknown as Facts },
    createdAt: new Date().toISOString(),
  };
  try { return await store.saveTurnRuntime(turnId, runtime); }
  catch (error) {
    // A second owner transition can observe the event written by the first transition.
    const saved = await store.turnRuntime(turnId);
    if (saved) return saved;
    throw error;
  }
}

export function frozenRuleDigest(system: string, versions: readonly RuleVersion[]) {
  return canonicalDigest({ system, versions });
}

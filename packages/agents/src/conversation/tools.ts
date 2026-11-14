import type { AgentDispatchPermit, AgentWait } from '@xunjie/contracts/agent-runtime';
import type { ModelTool, ModelToolIntent, ModelToolResult } from '@xunjie/contracts/model-connections';
import type { AgentExecutionSnapshot, Facts } from '@xunjie/agent-runtime';
import type { ConversationContext } from './index.js';

export interface ConversationToolContext {
  snapshot: AgentExecutionSnapshot;
  context: ConversationContext;
  /** Null only while enumerating a catalogue before a model call exists. */
  basisStepId: string | null;
  inputIds: string[];
}
export interface ConversationToolOffer {
  definition: ModelTool;
  effect: 'read' | 'write' | 'execute' | 'ask';
  scope: Facts;
}
export interface ConversationToolBinding extends ConversationToolOffer {
  bindingId: string;
  moduleId: string;
  moduleVersion: number;
  modelName: string;
}
export interface ConversationPreparedTool {
  commandId: string;
  name: string;
  effect: ConversationToolOffer['effect'];
  input: Facts;
}
export interface ConversationToolOutcome {
  state: 'completed' | 'accepted' | 'failed' | 'unknown' | 'not-dispatched';
  feedback: Omit<ModelToolResult, 'callId'>;
  result: Facts;
  /** A trusted module may propose another fixed command in this same native tool call. */
  nextCommand?: ConversationPreparedTool;
  /** Keep this original command's permit until its associated wait resolves or core revokes it. */
  continuation?: boolean;
  wait?: { kind: string; presentation: Facts; deadline: string | null; interruptible?: boolean };
}
/** Installed code supplies this interface; discovery never chooses an executable by model name. */
export interface ConversationToolModule {
  id: string;
  version: number;
  list(context: ConversationToolContext): Promise<ConversationToolOffer[]>;
  prepare(context: ConversationToolContext, offer: ConversationToolOffer, intent: ModelToolIntent, commandId: string): Promise<ConversationPreparedTool>;
  dispatch(context: ConversationToolContext, command: ConversationPreparedTool, permit: AgentDispatchPermit,
    assertDispatch: () => Promise<void>): Promise<ConversationToolOutcome>;
  reconcile(context: ConversationToolContext, command: ConversationPreparedTool): Promise<ConversationToolOutcome | null>;
  stop?(context: ConversationToolContext, command: ConversationPreparedTool): Promise<ConversationToolOutcome | null>;
  validateResponse?(context: ConversationToolContext, wait: AgentWait, answer: Facts): Promise<void>;
}

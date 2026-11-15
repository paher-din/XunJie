import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import type { AgentExecutionMode, AgentToolResult, AgentTurnBudget, AgentRuntimeSession } from '@xunjie/contracts/agent-runtime';
import type { ModelImageRef, ModelTool, ModelToolIntent, ModelToolResult, ModelUsage, ModelConnection } from '@xunjie/contracts/model-connections';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Facts = { [key: string]: Json };

/** One main-model tool call dispatched by the kernel, with a stable id and batch index. */
export interface ToolCall {
  toolCallId: string; nativeCallId: string; callIndex: number;
  name: string; input: Facts; executionMode: AgentExecutionMode;
}
export interface AskInput {
  presentation: Facts; deadline: string | null;
}
export type AskOutcome =
  | { kind: 'answered'; questionId: string; version: number; answer: Facts }
  | { kind: 'skipped'; questionId: string }
  | { kind: 'closed'; questionId: string }
  | { kind: 'expired'; questionId: string };
/** Identity, correlation ids, cancellation and the ability to save a real question. No kernel DB. */
export interface ToolContext {
  identity: SpaceIdentity;
  sessionId: string; turnId: string; stepId: string; toolCallId: string;
  signal: AbortSignal;
  /** The input range the model actually saw for this Step. */
  inputIds: readonly string[];
  ask(input: AskInput): Promise<AskOutcome>;
}
export interface AgentTool {
  definition: ModelTool;
  /** Tools that do not support background never expose the executionMode parameter. */
  supportsBackground: boolean;
  execute(call: ToolCall, context: ToolContext): Promise<AgentToolResult>;
}

export interface HistoryEntry { id: string; version: number; role: 'user' | 'assistant'; text: string; resultRef?: string; images?: ModelImageRef[]; }

export interface ScenarioInput {
  identity: SpaceIdentity; sessionId: string; turnId: string; stepId: string;
  inputIds: readonly string[]; sessionState: Facts;
}
export interface ScenarioContext { system: string; facts: Facts; sources: Facts[]; }
export interface CompactionSource { messages: HistoryEntry[]; remainder: HistoryEntry[]; sourceDigest: string;
  sourceVersions: Facts; retainedDigest: string; policy: { maxSummaryTokens: number }; }
export interface CompactionProvider {
  id: string; version: number;
  prompt(source: CompactionSource): { system: string; text: string };
  parse(text: string, source: CompactionSource): Facts;
}
export interface AgentScenario {
  id: string; version: number;
  context(input: ScenarioInput): Promise<ScenarioContext>;
  tools(input: ScenarioInput): Promise<readonly AgentTool[]>;
  modelFacts?(facts: Facts): Facts;
  authorizeHistory?(input: ScenarioInput, history: readonly HistoryEntry[]): Promise<HistoryEntry[]>;
  validateAnswer?(presentation: Facts, answer: Facts): Promise<void>;
  compaction?: {
    provider: CompactionProvider; maxPerTurn: number;
    needed(history: readonly HistoryEntry[], connection: ModelConnection, inputText: string): boolean;
    select(history: readonly HistoryEntry[], blocks: { id: string; content: Facts }[]): CompactionSource | null;
  };
  /** A per-session scene dispatcher resolves the concrete scene's compaction without hiding it. */
  compactionFor?(input: ScenarioInput): Promise<AgentScenario['compaction']>;
}

/** The selected valid response of one logical generate (after any Attempts). */
export interface GeneratedResponse {
  attemptId: string; requestRef: string; responseRef: string | null;
  text: string; toolIntents: readonly ModelToolIntent[]; usage: ModelUsage;
  segmentId: string; segmentSequence: number;
}
export interface GenerateInput {
  identity: SpaceIdentity; sessionId: string; turnId: string; stepId: string;
  system: string; tools: readonly ModelTool[];
  history: readonly HistoryEntry[];
  text: string; images: readonly ModelImageRef[];
  toolResults: readonly ModelToolResult[];
  budget: AgentTurnBudget;
  spent: { inputTokens: number; outputTokens: number; inputReserved: number; outputReserved: number };
  signal: AbortSignal;
  onProgress?(progress: { attemptId: string; text: string; revision: number; tools?: readonly Json[] }): Promise<void>;
}
/** Wraps the existing Gateway communication steps for one logical generate; no second loop. */
export interface ModelPort {
  generate(input: GenerateInput): Promise<GeneratedResponse>;
  settleTools(identity: SpaceIdentity, segmentId: string, expectedSequence: number, results: readonly ModelToolResult[]): Promise<{ segmentId: string; sequence: number }>;
  cancel(identity: SpaceIdentity, attemptId: string): Promise<void>;
}

export interface AgentProgressPort {
  recordProgress(identity: SpaceIdentity, sessionId: string, turnId: string, stepId: string, attemptId: string,
    progress: { revision: number; text: string; tools?: readonly Json[] }): Promise<boolean>;
}
export interface AgentCancellationTimers {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timer: unknown): void;
}
export interface AgentRuntimeLifecyclePort {
  closeWrites(): void;
  closeDispatch(): void;
  drain(): Promise<void>;
  resume(): Promise<void>;
  close(): Promise<void>;
}
/** A task owner's terminal observation, converted to a notification by the product bridge. */
export interface TaskTerminalFact {
  taskId: string; taskVersion: string; terminalStatus: 'success' | 'failed' | 'cancelled';
  summary: string; resultRef: string | null;
}
export interface SessionOwnerLock {
  readonly instanceId: string;
  readonly lost: Promise<void>;
  release(): Promise<void>;
}
export type { AgentRuntimeSession };

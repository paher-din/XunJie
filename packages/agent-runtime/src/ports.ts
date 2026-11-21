import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import type { AgentExecutionMode, AgentToolResult, AgentTurnBudget, AgentRuntimeSession } from '@xunjie/contracts/agent-runtime';
import type { ModelImageAttachmentScope, ModelImageRef, ModelMessageImage, ModelTool, ModelToolIntent, ModelToolResult, ModelUsage, ModelConnection } from '@xunjie/contracts/model-connections';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Facts = { [key: string]: Json };

export interface RuleVersion {
  kind: 'platform' | 'scene' | 'course' | 'output';
  id: string;
  version: string | number;
}
export type MaterialReadState = 'included' | 'reference-only' | 'omitted' | 'denied' | 'failed';
export interface ContextMaterial {
  inputId?: string;
  /** Stable within this Step and safe to cite; never an owner locator exposed to a student. */
  materialId: string;
  /** Owner-facing identity used only to authorize and to rebuild later views. */
  sourceId: string;
  kind: 'student-message' | 'student-reference' | 'student-work' | 'history-summary'
    | 'system-observation' | 'tool-result' | 'course-material' | 'private-material';
  author: 'student' | 'teacher' | 'tool' | 'system' | 'model';
  label: string;
  version: string | null;
  range: Facts | null;
  digest: string;
  content: string | null;
  readState: MaterialReadState;
  readReason?: string;
  /** The same fixed source is still present in this native segment's visible history. */
  visibleInHistory?: boolean;
  /** A fixed source ref (QuestionReferenceSource, LearningReference or tool record) for later opening. */
  source: Facts;
  citationAllowed: boolean;
}
export interface HistorySource {
  sourceId: string;
  label: string;
  source: Facts;
  inlineDigest?: string;
  range?: Facts;
}
export interface TurnRuleSet {
  formatVersion: 1;
  system: string;
  digest: string;
  versions: RuleVersion[];
}
export interface FrozenTurnModel {
  selectionVersion: number;
  pinId: string;
  connection: ModelConnection;
  source: Facts;
}
export interface TurnRuntime {
  formatVersion: 1;
  scenario: { id: string; version: number };
  model: FrozenTurnModel;
  rules?: TurnRuleSet;
  createdAt: string;
}

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
/** Trusted owner handles, reported by the tool rather than inferred from model arguments. */
export interface ToolEffectReference { taskId?: string; requestRef?: string; }
/** Identity, correlation ids, cancellation and the ability to save a real question. No kernel DB. */
export interface ToolContext {
  identity: SpaceIdentity;
  sessionId: string; turnId: string; stepId: string; toolCallId: string;
  /** Actual model segment that produced this ToolCall; host-owned, never model input. */
  segmentId?: string;
  signal: AbortSignal;
  /** The Turn's hard deadline, host-owned; tools may wait only within it. */
  deadline?: string;
  /** Narrow execution fence: still the live Turn owner and not stopped; call before each independent write. */
  assertActive(): Promise<void>;
  /** Report a dispatched request/accepted task before waiting; late reports re-deliver cancellation. */
  reportEffect?(reference: ToolEffectReference): Promise<void>;
  /** The input range the model actually saw for this Step. */
  inputIds: readonly string[];
  /** The stable real user request of this Turn, even in a later Step with no newly adopted input. */
  originInputId: string | null;
  /** Real answers already shown to this Session's model, inherited across Steps and Turns. */
  visibleAnswerInputIds: readonly string[];
  ask(input: AskInput): Promise<AskOutcome>;
}
export interface AgentTool {
  definition: ModelTool;
  /** Business waits enforce their own question/task deadline, capped by the Turn hard deadline.
   * Ordinary tools (the default) additionally use the short maxCallMs RPC limit. */
  timeoutPolicy?: 'call' | 'business';
  /** Tools that do not support background never expose the executionMode parameter. */
  supportsBackground: boolean;
  execute(call: ToolCall, context: ToolContext): Promise<AgentToolResult>;
}

export interface HistoryEntry { id: string; version: number; role: 'user' | 'assistant'; text: string; resultRef?: string;
  turnId?: string; stepId?: string; kind?: 'message' | 'tool-result' | 'history-summary';
  attemptId?: string; nativeCallId?: string; readback?: boolean; feedbackCompressed?: boolean; images?: ModelImageRef[]; sources?: HistorySource[]; }
export interface HistoryProjectionReplacement {
  entryId: string; attemptId?: string; callId?: string; text: string;
}
/**
 * The kernel's representation decision for existing history. Ordinary new messages do not
 * change this identity; a new value tells the Gateway which native results to replace.
 */
export interface HistoryProjection {
  projectionId: string;
  replacements: HistoryProjectionReplacement[];
}

export interface ScenarioInputEntry { inputId: string; requestId?: string; text: string; context: Facts; }
export interface ScenarioInput {
  identity: SpaceIdentity; sessionId: string; turnId: string; stepId: string;
  inputIds: readonly string[]; inputs?: readonly ScenarioInputEntry[]; sessionState: Facts;
}
export interface ScenarioContext { system: string; facts: Facts; sources: Facts[];
  materials?: readonly ContextMaterial[]; ruleVersions?: readonly RuleVersion[]; }
export interface MessageImageRoute { segmentId: string; includeRetained: boolean; }
export interface MessageImages {
  scope: ModelImageAttachmentScope;
  images: readonly ModelMessageImage[];
  retained?: readonly { image: ModelMessageImage; dataBase64: string }[];
}
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
  messageImages?(input: ScenarioInput, contexts: readonly Facts[], route: MessageImageRoute): Promise<MessageImages | undefined>;
  modelFacts?(facts: Facts): Facts;
  authorizeHistory?(input: ScenarioInput, history: readonly HistoryEntry[]): Promise<HistoryEntry[]>;
  validateAnswer?(presentation: Facts, answer: Facts): Promise<void>;
  compaction?: {
    provider: CompactionProvider; maxPerTurn: number;
    select(history: readonly HistoryEntry[], blocks: { id: string; content: Facts }[],
      target?: { targetInputBytes?: number; currentInputBytes?: number }): CompactionSource | null;
  };
  /** A per-session scene dispatcher resolves the concrete scene's compaction without hiding it. */
  compactionFor?(input: ScenarioInput): Promise<AgentScenario['compaction']>;
}

/** The selected valid response of one logical generate (after any Attempts). */
export interface GeneratedResponse {
  attemptId: string; requestRef: string; responseRef: string | null;
  text: string; toolIntents: readonly ModelToolIntent[]; usage: ModelUsage;
  segmentId: string; segmentSequence: number;
  rebuilt?: boolean;
  contextUsage?: { model: { connectionId: string; version: number }; tokens: number; lowerBound: boolean };
}
export interface GenerateInput {
  historySources?: NonNullable<HistoryEntry['sources']>;
  rebuildHistorySources?: NonNullable<HistoryEntry['sources']>;
  identity: SpaceIdentity; sessionId: string; turnId: string; stepId: string;
  system: string; tools: readonly ModelTool[];
  history: readonly HistoryEntry[];
  text: string; images: readonly ModelImageRef[];
  /** Text for a genuinely new native segment; may inline material omitted as a reference in text. */
  rebuildText?: string;
  factsDigest?: string;
  historyProjection?: HistoryProjection;
  messageImages?: {
    resolve(route: MessageImageRoute): Promise<MessageImages | undefined>;
    restore?(route: MessageImageRoute): Promise<MessageImages | undefined>;
    assertActive(): Promise<void>;
  };
  toolResults: readonly ModelToolResult[];
  budget: AgentTurnBudget;
  spent: { inputTokens: number; outputTokens: number; inputReserved: number; outputReserved: number };
  /** Increment only when prior material was removed/rebuilt; forces a fresh native segment. */
  segmentEpoch: number;
  signal: AbortSignal;
  adoptContext?(): Promise<void>;
  /** Re-authorize the exact materials and native history this Attempt is about to dispatch. */
  verifyContext?(input: { rebuilt: boolean }): Promise<void>;
  smallerThanBytes?: number;
  /** A final-payload pressure result may request one real compaction before dispatch. */
  allowPressureCompaction?: boolean;
  onProgress?(progress: { attemptId: string; text: string; revision: number; thinking?: string; tools?: readonly Json[] }): Promise<void>;
}
/** Wraps the existing Gateway communication steps for one logical generate; no second loop. */
export interface ModelPort {
  generate(input: GenerateInput): Promise<GeneratedResponse>;
  settleTools(identity: SpaceIdentity, segmentId: string, expectedSequence: number, results: readonly ModelToolResult[]): Promise<{ segmentId: string; sequence: number }>;
  cancel(identity: SpaceIdentity, attemptId: string): Promise<void>;
}

export interface RequestCapacity {
  formatVersion: 1;
  method: 'utf8-byte-estimate';
  dispatchable: boolean;
  reason: 'ok' | 'context-window' | 'transport-bytes' | 'input-budget' | 'output-budget' | 'unknown';
  model: { connectionId: string; version: number; protocol: string; modelId: string };
  requestFingerprint: string;
  bytes: number;
  inputEstimateTokens: number;
  outputReserveTokens: number;
  safetyMarginTokens: number;
  pressure: number | null;
  pressureState: 'ok' | 'compact' | 'blocked' | 'unknown';
  contextWindow: number | null;
  transportLimitBytes: number;
  parts: { systemBytes: number; toolsBytes: number; historyBytes: number; currentBytes: number; imageCount: number };
}

export interface AgentProgressPort {
  recordProgress(identity: SpaceIdentity, sessionId: string, turnId: string, stepId: string, attemptId: string,
    progress: { revision: number; text: string; thinking?: string; tools?: readonly Json[] }): Promise<boolean>;
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

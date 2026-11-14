import type { AgentDispatchPermit, AgentInput, AgentInputReceipt, AgentOperation, AgentRun, AgentRuntimeSession, AgentWait } from '@xunjie/contracts/agent-runtime';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Facts = { [key: string]: Json };
export interface AgentAcceptedRequest { receipt: AgentInputReceipt; input: AgentInput; }
/** Already filtered by the gateway. Only the Node host may publish operation progress. */
export interface AgentModelProgress { revision: number; text: string; tools?: readonly Json[] | undefined; }
export interface AgentProgressPort {
  recordProgress(identity: AgentRuntimeSession['identity'], permit: AgentDispatchPermit, progress: AgentModelProgress): Promise<boolean>;
}
export interface AgentRecoveryPort {
  /** Startup-only candidates. The host explicitly wakes them once; this starts no scanner. */
  recoverableRuns(): Promise<AgentRun[]>;
}
export interface AgentRuntimeLifecyclePort {
  closeWrites(): void;
  closeDispatch(): void;
  drain(): Promise<void>;
  resume(): Promise<void>;
  close(): Promise<void>;
}
/** Host timers for failed original cancellation delivery, never a scan or business wake. */
export interface AgentCancellationTimers {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timer: unknown): void;
}
export interface AgentRunBudgetOptions {
  maxSteps?: number | undefined; maxDispatches?: number | undefined; timeoutMs?: number | null | undefined;
}
export interface AgentRunBudget {
  maxSteps: number; maxDispatches: number; deadline: string | null; steps: number; dispatches: number;
}
export type AgentInputControl = { requestId: string; expectedVersion: number } & (
  | { operation: 'edit'; text?: string | undefined; context?: Facts | undefined; mode?: AgentInput['mode'] | undefined }
  | { operation: 'remove' }
  | { operation: 'move'; mode: AgentInput['mode'] }
);
export interface AgentInputControlReceipt { requestId: string; input: AgentSessionInput; previousRunId?: string; }
export interface AgentInputControlPort {
  request(identity: AgentRuntimeSession['identity'], sessionId: string, requestId: string): Promise<AgentAcceptedRequest | null>;
  inputControl(identity: AgentRuntimeSession['identity'], sessionId: string, inputId: string, control: AgentInputControl): Promise<AgentInputControlReceipt>;
}
export interface AgentSessionInput {
  inputId: string; runId: string; version: number; mode: AgentInput['mode'];
  state: 'pending' | 'adopted' | 'removed'; input: AgentInput; createdAt: string;
}
export interface AgentSessionSnapshot {
  session: AgentRuntimeSession; runs: AgentRun[]; inputs: AgentSessionInput[]; waits: AgentWait[];
}
/** Product projection boundary. Events and full operation snapshots are separate reads. */
export interface AgentSessionReadPort {
  sessionSnapshot(identity: AgentRuntimeSession['identity'], sessionId: string): Promise<AgentSessionSnapshot>;
}
/** Trusted Node host notification; this is not a browser input or dispatch authorization. */
export interface AgentWaitResolution {
  requestId: string; waitId: string; expectedVersion: number; result: Facts;
}
export interface FixedAgentInput { inputId: string; version: number; sequence: number; input: AgentInput; }
export interface AgentStep {
  stepId: string; number: number; operation: AgentOperation; snapshot: Facts;
  state: 'prepared' | 'dispatching' | 'waiting' | 'unknown' | 'completed';
  result: AgentOperationResult | null;
  continuationOpen: boolean;
}
export interface AgentExecutionSnapshot {
  /** sessionState spans runs; state belongs to this run. Both are facts, not dispatch authority. */
  session: AgentRuntimeSession; run: AgentRun; revision: number; state: Facts; sessionState: Facts;
  budget: AgentRunBudget;
  inputs: FixedAgentInput[]; steps: AgentStep[]; waits: AgentWait[];
}
export type AgentSnapshot = AgentExecutionSnapshot;
export interface AgentOperationResult {
  state: 'completed' | 'accepted' | 'failed' | 'unknown' | 'not-dispatched';
  value: Facts;
  /** Only an original operation known not to have started may be admitted again. */
  retryAfterMs?: number;
}
export type AgentDecision =
  | { kind: 'operation'; operation: AgentOperation; snapshot: Facts }
  | { kind: 'complete'; events?: { kind: string; body: Facts }[] }
  | { kind: 'pause'; reason: string };
export interface AgentSettlement {
  state: Facts;
  /** Replaces session facts in the same transaction as this result and its events. */
  sessionState?: Facts;
  events?: { kind: string; body: Facts }[];
  /** Explicitly retains authority for this original operation, independently of worker leases. */
  keepDispatch?: boolean;
  wait?: { kind: string; presentation: Facts; deadline: string | null; continuationOperationId?: string | undefined;
    interruptible?: boolean | undefined };
  complete?: boolean;
  pause?: string;
}
/** Preparation and application may read facts, but never dispatch an external effect. */
export interface AgentPipeline {
  plan(snapshot: AgentExecutionSnapshot, ids: { stepId: string; operationId: string }): Promise<AgentDecision>;
  dispatch(snapshot: AgentExecutionSnapshot, step: AgentStep, permit: AgentDispatchPermit,
    assertDispatch: () => Promise<void>): Promise<AgentOperationResult>;
  reconcile(snapshot: AgentExecutionSnapshot, step: AgentStep): Promise<AgentOperationResult | null>;
  apply(snapshot: AgentExecutionSnapshot, step: AgentStep, result: AgentOperationResult): Promise<AgentSettlement>;
  validateResponse?(snapshot: AgentExecutionSnapshot, wait: AgentWait, answer: Facts): Promise<void>;
  /** Stop has already revoked dispatch. Resolve once the original owner durably receives cancellation;
   * physical settlement belongs to that owner. Failed/unacknowledged delivery is retried idempotently. */
  cancel?(snapshot: AgentExecutionSnapshot, step: AgentStep): Promise<void>;
}
export interface AgentExecutionStrategy {
  wake(runId: string): void;
  closeDispatch(): void;
  drain(): Promise<void>;
  close?(): Promise<void> | void;
}

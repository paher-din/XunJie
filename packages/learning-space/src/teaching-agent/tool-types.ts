import type { ActionInput } from '@xunjie/contracts/action-intents';
import type { LearningActivity } from '@xunjie/contracts/learning-data';
import type { ModelTool, ModelToolIntent, ModelToolResult } from '@xunjie/contracts/model-connections';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';

/** Trusted caller context supplied by RunDriver, never accepted from a model or browser. */
export interface TeachingToolScope {
  identity: SpaceIdentity;
  activity: LearningActivity;
  input: ActionInput;
  runId: string;
  stepId: string;
  snapshotId: string;
  /** Original immutable model segment; image tools cannot select or upgrade a route. */
  segmentId?: string;
  /** Reconstructed from the durable Run permit; never serialized or model supplied. */
  assertDispatch?: () => Promise<void>;
}

/** Entire immutable command basis is committed before the host is allowed to dispatch. */
export interface TeachingPreparedTool {
  version: 1;
  commandId: string;
  name: string;
  arguments: Record<string, unknown>;
  effect: 'read' | 'execute' | 'input' | 'stop';
  conflictKey: string;
  location: 'owner' | 'browser' | 'native' | 'remote';
  basis: Record<string, unknown>;
}

export interface TeachingToolOutcome {
  state: 'not-dispatched' | 'accepted' | 'completed' | 'failed' | 'unknown';
  feedback: Omit<ModelToolResult, 'callId'>;
  /** Complete learning result, separately retained from the bounded model feedback. */
  result: Record<string, unknown>;
  source: { label: string; componentKey?: string; requestId?: string; contentId?: string };
  execution?: { requestId: string; executionRef: string; inputDigest: string };
}

export interface TeachingToolHost {
  definitions(scope: TeachingToolScope): Promise<ModelTool[]>;
  /** Validation and freezing only; must not execute a course operation. */
  prepare(scope: TeachingToolScope, intent: ModelToolIntent, commandId: string): Promise<TeachingPreparedTool>;
  dispatch(scope: TeachingToolScope, command: TeachingPreparedTool): Promise<TeachingToolOutcome>;
  /** Reads the original identity. null never authorizes replay. */
  reconcile(scope: TeachingToolScope, command: TeachingPreparedTool): Promise<TeachingToolOutcome | null>;
  stop(scope: TeachingToolScope, command: TeachingPreparedTool): Promise<TeachingToolOutcome | null>;
}

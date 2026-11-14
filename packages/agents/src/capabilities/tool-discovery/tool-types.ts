import type { ActionInput } from '@xunjie/contracts/action-intents';
import type { LearningActivity } from '@xunjie/contracts/learning-data';
import type { ModelTool, ModelToolIntent } from '@xunjie/contracts/model-connections';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import type { teachingPreparedToolSchema, teachingToolOutcomeSchema } from '@xunjie/contracts/teaching-agent';
import type { z } from 'zod';
import type { AgentToolBinding } from '@xunjie/contracts/teaching-agent';
import type { TeachingSkillState } from '@xunjie/contracts/agent-skills';

/** Fixed definitions and their owning executor; model aliases never select code. */
export type TeachingToolContribution = Omit<AgentToolBinding, 'bindingId' | 'modelName'>;

/** Trusted context supplied by the workspace adapter, never accepted from a model or browser. */
export interface TeachingToolScope {
  identity: SpaceIdentity;
  activity: LearningActivity;
  input: ActionInput;
  runId: string;
  stepId: string;
  snapshotId: string;
  /** Original model attempt which produced this step's immutable tool intent. */
  attemptId?: string;
  /** Original immutable model segment; image tools cannot select or upgrade a route. */
  segmentId?: string;
  /** Reconstructed from the durable Run permit; never serialized or model supplied. */
  assertDispatch?: () => Promise<void>;
  /** Snapshot-frozen selected skills for this step; search covers only permitted text attachments. */
  skillState?: TeachingSkillState;
}

/** Cleanup uses only the original stored scope, never current activity or source-content reads. */
export type TeachingToolCleanupScope = Omit<TeachingToolScope, 'activity'> & {
  activity: Pick<LearningActivity, 'activityId' | 'identity' | 'course'>;
};

/** Entire immutable command basis is committed before the host is allowed to dispatch. */
export type TeachingPreparedTool = z.infer<typeof teachingPreparedToolSchema>;

/** Complete learning result is retained separately from the bounded model feedback. */
export type TeachingToolOutcome = z.infer<typeof teachingToolOutcomeSchema>;

export interface TeachingToolHost {
  contributions?(scope: TeachingToolScope): Promise<TeachingToolContribution[]>;
  definitions(scope: TeachingToolScope): Promise<ModelTool[]>;
  /** Validation and freezing only; must not execute a course operation. */
  prepare(scope: TeachingToolScope, intent: ModelToolIntent, commandId: string): Promise<TeachingPreparedTool>;
  dispatch(scope: TeachingToolScope, command: TeachingPreparedTool): Promise<TeachingToolOutcome>;
  /** Reads the original identity. null never authorizes replay. */
  reconcile(scope: TeachingToolScope, command: TeachingPreparedTool): Promise<TeachingToolOutcome | null>;
  stop(scope: TeachingToolCleanupScope, command: TeachingPreparedTool): Promise<TeachingToolOutcome | null>;
}

import type { ActionInput } from '@xunjie/contracts/action-intents';
import type { LearningActivity } from '@xunjie/contracts/learning-data';
import type { ModelTool } from '@xunjie/contracts/model-connections';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import type { AgentToolResult } from '@xunjie/contracts/agent-runtime';
import type { teachingPreparedToolSchema, teachingToolOutcomeSchema } from '@xunjie/contracts/teaching-agent';
import type { z } from 'zod';
import type { TeachingSkillState } from '@xunjie/contracts/agent-skills';
import type { ToolCall, ToolContext } from '@xunjie/agent-runtime';

/** Trusted context supplied by the workspace adapter, never accepted from a model or browser. */
export interface TeachingToolScope {
  identity: SpaceIdentity;
  activity: LearningActivity;
  input: ActionInput;
  /** Kernel Turn id mapped to the gateway transport runId; tracking only, never an ownership fence. */
  runId: string;
  stepId: string;
  snapshotId: string;
  attemptId?: string;
  /** Actual kernel session owning this call, supplied by the workspace adapter. */
  sessionId?: string;
  segmentId?: string;
  /** Reconstructed from the kernel cancellation signal; never serialized or model supplied. */
  assertDispatch?: () => Promise<void>;
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

/** Fixed definitions and their owning executor; the kernel serial loop calls execute directly. */
export interface TeachingToolHost {
  definitions(scope: TeachingToolScope): ModelTool[];
  execute(scope: TeachingToolScope, call: ToolCall, ctx: ToolContext): Promise<AgentToolResult>;
}

import { z } from 'zod';
import { StorageError } from '@xunjie/storage';
import { canonicalDigest } from '@xunjie/storage/identity';
import { actionInputSchema, type ActionInput } from '@xunjie/contracts/action-intents';
import { activitySchema, type LearningActivity } from '@xunjie/contracts/learning-data';
import type { AgentTool, Facts, ScenarioInput, ToolCall, ToolContext } from '@xunjie/agent-runtime';
import type { TeachingToolScope } from '../../capabilities/tool-discovery/tool-types.js';
import { errored } from '../../capabilities/tool-support.js';
import { createTeachingTools } from './tools.js';
import type { TeachingToolData } from './tool-data.js';
import { teachingPublicArguments } from '../help-policy.js';

type ToolHostOptions = Parameters<typeof createTeachingTools>[0];
export interface WorkspaceToolOptions {
  /** The host resolves and authorizes the session's actual fixed workspace. */
  workspace(sessionId: string): Promise<LearningActivity>;
  learning: TeachingToolData;
  courses: ToolHostOptions['courses'];
  models?: ToolHostOptions['models'];
  studentFacts?: ToolHostOptions['studentFacts'];
  executionOrigin?: ToolHostOptions['executionOrigin'];
  device?: ToolHostOptions['device'];
  environment?: ToolHostOptions['environment'];
}
export const workspaceFacts = (value: unknown): Facts => z.record(z.string(), z.json()).parse(JSON.parse(JSON.stringify(value)));
const subject = (value: LearningActivity['identity']) => canonicalDigest({ kind: value.kind,
  environmentId: value.environmentId, spaceId: value.spaceId, principalId: value.principalId });

export async function authorizedWorkspace(options: WorkspaceToolOptions, sessionId: string, identity: ScenarioInput['identity']) {
  const authorized = activitySchema.parse(await options.workspace(sessionId));
  if (subject(authorized.identity) !== subject(identity)) throw new StorageError('forbidden');
  const activity = await options.learning.open(identity, authorized.activityId);
  if (subject(activity.identity) !== subject(identity)
    || canonicalDigest(activity.course ?? null) !== canonicalDigest(authorized.course ?? null)) throw new StorageError('identity-conflict');
  if (activity.status !== 'open' || activity.course?.helpPolicy?.questions === 'disabled') throw new StorageError('forbidden');
  return activity;
}

const workspaceInputSchema = z.object({ inputId: z.uuid(), action: z.unknown() }).strict();
/** Scene data always comes from the authorized owner and the retained inputs the kernel selected for this Step. */
export async function resolveWorkspace(options: WorkspaceToolOptions, input: ScenarioInput) {
  const activity = await authorizedWorkspace(options, input.sessionId, input.identity);
  const stored = (input.sessionState.workspaceInputs ?? []) as unknown[];
  const selected = z.array(workspaceInputSchema).parse(stored).filter(item => input.inputIds.includes(item.inputId));
  if (!selected.length || input.inputIds.some(id => !selected.some(item => item.inputId === id))) throw new StorageError('invalid');
  const actions = selected.map(item => {
    const parsed = actionInputSchema.safeParse(item.action);
    if (!parsed.success) throw new StorageError('invalid');
    const action = parsed.data;
    const expected = { environmentId: input.identity.environmentId, spaceId: input.identity.spaceId,
      principalId: input.identity.principalId, activityId: activity.activityId };
    if (canonicalDigest(action.scope) !== canonicalDigest(expected) || action.receiver.kind !== 'question') throw new StorageError('forbidden');
    return { inputId: item.inputId, action };
  });
  const fixed = actions.at(-1)!;
  for (const { action } of actions) {
    for (const file of [...action.works, ...action.draft.bases]) {
      const storedFile = await options.learning.works.content(input.identity, activity.activityId, file.contentId);
      if (storedFile.objectId !== file.objectId || storedFile.value !== file.value || storedFile.encoding !== file.encoding
        || storedFile.kind !== file.kind || storedFile.mediaType !== file.mediaType) throw new StorageError('corrupt');
    }
    await options.learning.drafts.verifyReferences(input.identity, activity.activityId,
      { references: action.draft.references, bases: action.draft.bases });
  }
  return { activity, action: fixed.action, inputId: fixed.inputId, actions };
}

function toolScope(ctx: ToolContext, workspace: { activity: LearningActivity; action: ActionInput }): TeachingToolScope {
  return { identity: ctx.identity, activity: workspace.activity, input: workspace.action,
    runId: ctx.turnId, stepId: ctx.stepId, snapshotId: ctx.stepId, attemptId: ctx.toolCallId,
    assertDispatch: async () => { if (ctx.signal.aborted) throw new StorageError('forbidden'); } };
}
const workspaceTools = new Set(['read_work', 'read_reference', 'read_material',
  'read_student_facts', 'read_result', 'execution_query', 'execution_stop', 'course_operation',
  'read_teaching_artifact', 'generate_teaching_artifact']);

/** Fixed workspace tools consumed by the kernel serial loop, with teaching permission and help-policy guards. */
export async function createWorkspaceTools(options: WorkspaceToolOptions, input: ScenarioInput): Promise<AgentTool[]> {
  const workspace = await resolveWorkspace(options, input);
  const host = createTeachingTools({ learning: () => options.learning, courses: options.courses,
    ...(options.models ? { models: options.models } : {}),
    ...(options.studentFacts ? { studentFacts: options.studentFacts } : {}),
    ...(options.executionOrigin ? { executionOrigin: options.executionOrigin } : {}),
    ...(options.device ? { device: options.device } : {}),
    ...(options.environment ? { environment: options.environment } : {}) });
  const scope = toolScope({ identity: input.identity, sessionId: input.sessionId, turnId: input.turnId, stepId: input.stepId,
    toolCallId: input.stepId, signal: new AbortController().signal, inputIds: input.inputIds, ask: async () => { throw new StorageError('forbidden'); } }, workspace);
  const definitions = host.definitions(scope).filter(definition => workspaceTools.has(definition.name)
    && (definition.name !== 'read_student_facts' || options.studentFacts));
  return definitions.map(definition => ({
    definition: definition.name !== 'read_student_facts' ? definition : { ...definition,
      inputSchema: { ...definition.inputSchema, required: ['scope'], properties: {
        ...(definition.inputSchema.properties as Record<string, unknown>),
        scope: { type: 'string', enum: ['current-activity', 'same-course'] } } } },
    supportsBackground: definition.name === 'course_operation',
    async execute(call: ToolCall, ctx: ToolContext) {
      // Ownership is re-checked at the actual call; origin Turn is tracking only, never a fence (PLAN 9).
      const current = await authorizedWorkspace(options, ctx.sessionId, ctx.identity);
      if (current.activityId !== workspace.activity.activityId || canonicalDigest(current.course ?? null) !== canonicalDigest(workspace.activity.course ?? null))
        throw new StorageError('identity-conflict');
      if (teachingPublicArguments(workspace.activity, call.input).rejectedByHelpPolicy)
        return errored('该工具参数违反课程帮助策略。');
      return host.execute(toolScope(ctx, workspace), call, ctx);
    },
  }));
}
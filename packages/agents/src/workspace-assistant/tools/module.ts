import { z } from 'zod';
import { StorageError } from '@xunjie/storage';
import { canonicalDigest } from '@xunjie/storage/identity';
import { actionInputSchema, type ActionInput } from '@xunjie/contracts/action-intents';
import { activitySchema, type LearningActivity } from '@xunjie/contracts/learning-data';
import { teachingPreparedToolSchema } from '@xunjie/contracts/teaching-agent';
import { compileOutputSchema } from '@xunjie/model-gateway/chat-native';
import type { AgentExecutionSnapshot, Facts } from '@xunjie/agent-runtime';
import type { ConversationToolContext, ConversationToolModule, ConversationToolOffer, ConversationPreparedTool, ConversationToolOutcome } from '../../conversation/tools.js';
import { requireConversationModelStep } from '../../conversation/basis.ts';
import type { TeachingToolScope, TeachingPreparedTool, TeachingToolOutcome } from '../../capabilities/tool-discovery/tool-types.js';
import { createTeachingTools } from './tools.js';
import type { TeachingToolData } from './tool-data.js';

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

export async function authorizedWorkspace(options: WorkspaceToolOptions, snapshot: AgentExecutionSnapshot) {
  const authorized = activitySchema.parse(await options.workspace(snapshot.session.sessionId));
  if (subject(authorized.identity) !== subject(snapshot.session.identity)) throw new StorageError('forbidden');
  const activity = await options.learning.open(snapshot.session.identity, authorized.activityId);
  if (subject(activity.identity) !== subject(snapshot.session.identity)
    || canonicalDigest(activity.course ?? null) !== canonicalDigest(authorized.course ?? null)) throw new StorageError('identity-conflict');
  if (activity.status !== 'open' || activity.course?.helpPolicy?.questions === 'disabled') throw new StorageError('forbidden');
  return activity;
}
/** Scene data always comes from the authorized owner and retained input, never sessionId aliases. */
export async function resolveWorkspace(options: WorkspaceToolOptions, snapshot: AgentExecutionSnapshot, inputIds?: readonly string[]) {
  const selected = inputIds?.length ? snapshot.inputs.filter(input => inputIds.includes(input.inputId))
    : snapshot.inputs.filter(input => input.inputId === snapshot.run.inputId || input.input.mode === 'steering');
  if (!selected.length || inputIds?.some(id => !selected.some(input => input.inputId === id))) throw new StorageError('invalid');
  const activity = await authorizedWorkspace(options, snapshot);
  const actions = selected.map(input => {
    const parsed = actionInputSchema.safeParse(input.input.context.action);
    if (!parsed.success) throw new StorageError('invalid');
    const action = parsed.data;
    const expected = { environmentId: snapshot.session.identity.environmentId, spaceId: snapshot.session.identity.spaceId,
      principalId: snapshot.session.identity.principalId, activityId: activity.activityId };
    if (canonicalDigest(action.scope) !== canonicalDigest(expected) || action.receiver.kind !== 'question') throw new StorageError('forbidden');
    return { inputId: input.inputId, action };
  });
  const fixed = actions.at(-1)!;
  for (const { action } of actions) {
    for (const file of [...action.works, ...action.draft.bases]) {
      const stored = await options.learning.works.content(snapshot.session.identity, activity.activityId, file.contentId);
      if (stored.objectId !== file.objectId || stored.value !== file.value || stored.encoding !== file.encoding
        || stored.kind !== file.kind || stored.mediaType !== file.mediaType) throw new StorageError('corrupt');
    }
    await options.learning.drafts.verifyReferences(snapshot.session.identity, activity.activityId,
      { references: action.draft.references, bases: action.draft.bases });
  }
  return { activity, action: fixed.action, inputId: fixed.inputId, actions };
}

const modelStep = requireConversationModelStep;
function toolScope(context: ConversationToolContext, workspace: { activity: LearningActivity; action: ActionInput }, stepId?: string): TeachingToolScope {
  const step = stepId !== undefined ? modelStep(context, stepId) : undefined;
  return { identity: context.snapshot.session.identity, activity: workspace.activity, input: workspace.action,
    runId: context.snapshot.run.runId, stepId: step?.stepId ?? context.snapshot.run.inputId,
    snapshotId: step?.stepId ?? context.snapshot.run.inputId,
    ...(step ? { attemptId: step.operation.operationId, segmentId: String(step.operation.input.segmentId) } : {}) };
}
interface FixedCommand { version: 1; offer: ConversationToolOffer; modelStepId: string; prepared: TeachingPreparedTool; }
const offerOf = (offer: ConversationToolOffer): ConversationToolOffer => ({ definition: offer.definition, effect: offer.effect, scope: offer.scope });
const workspaceTools = new Set(['read_work', 'read_reference', 'read_material',
  'read_student_facts', 'read_result', 'execution_query', 'execution_stop', 'course_operation',
  'read_teaching_artifact', 'generate_teaching_artifact']);
const effectOf = (effect: TeachingPreparedTool['effect'], name: string): ConversationToolOffer['effect'] =>
  effect === 'read' ? 'read' : name === 'generate_teaching_artifact' ? 'write' : 'execute';
function fixedCommand(command: ConversationPreparedTool): FixedCommand {
  const fixed = command.input as unknown as FixedCommand;
  if (!fixed || !teachingPreparedToolSchema.safeParse(fixed.prepared).success || !fixed.offer?.definition) throw new StorageError('corrupt');
  if (fixed.version !== 1 || typeof fixed.modelStepId !== 'string' || fixed.prepared?.commandId !== command.commandId || fixed.prepared.name !== command.name
    || effectOf(fixed.prepared.effect, command.name) !== command.effect || fixed.offer.definition.name !== command.name) throw new StorageError('identity-conflict');
  return fixed;
}
/** Cleanup and recovery retain the original sources even if input control has since replaced them. */
function retainedScope(context: ConversationToolContext, fixed: FixedCommand): TeachingToolScope {
  const activity = activitySchema.parse(context.context.facts.workspace);
  const stored = fixed.prepared.basis.scope as Record<string, unknown>;
  const action = actionInputSchema.parse(stored.input);
  const scope = toolScope(context, { activity, action }, fixed.modelStepId);
  const expected = { identity: scope.identity, activityId: activity.activityId, runId: scope.runId, stepId: scope.stepId,
    snapshotId: scope.snapshotId, segmentId: scope.segmentId ?? null, input: action, course: activity.course ?? null };
  if (canonicalDigest(stored) !== canonicalDigest(expected) || subject(activity.identity) !== subject(scope.identity)
    || canonicalDigest(action) !== fixed.offer.scope.actionDigest) throw new StorageError('identity-conflict');
  return scope;
}
const outcomeOf = (outcome: TeachingToolOutcome): ConversationToolOutcome => ({ state: outcome.state,
  feedback: outcome.feedback, result: workspaceFacts({ ...outcome.result, toolSource: outcome.source }) });
function executionOutcome(outcome: TeachingToolOutcome, scope: TeachingToolScope, command: TeachingPreparedTool): ConversationToolOutcome {
  const value = outcomeOf(outcome);
  return outcome.state !== 'accepted' || command.name !== 'course_operation' ? value : { ...value, continuation: true,
    wait: { kind: 'workspace-execution', deadline: null, presentation: workspaceFacts({ activityId: scope.activity.activityId,
      requestId: String(command.basis.requestId ?? command.commandId), commandId: command.commandId,
      association: { runId: scope.runId, stepId: scope.stepId, snapshotId: scope.snapshotId, commandId: command.commandId } }) } };
}

/** Fixed workspace tools are consumed by the shared conversation pipeline, without a teaching RunDriver. */
export function createWorkspaceToolModule(options: WorkspaceToolOptions): ConversationToolModule {
  const host = createTeachingTools({ learning: () => options.learning, courses: options.courses,
    ...(options.models ? { models: options.models } : {}),
    ...(options.studentFacts ? { studentFacts: options.studentFacts } : {}),
    ...(options.executionOrigin ? { executionOrigin: options.executionOrigin } : {}),
    ...(options.device ? { device: options.device } : {}),
    ...(options.environment ? { environment: options.environment } : {}) });
  async function list(context: ConversationToolContext): Promise<ConversationToolOffer[]> {
    const workspace = await resolveWorkspace(options, context.snapshot, context.inputIds);
    const scope = toolScope(context, workspace);
    return (await host.contributions!(scope)).filter(item => workspaceTools.has(item.definition.name)
      && (item.definition.name !== 'read_student_facts' || options.studentFacts)).map(contribution => {
      const definition = contribution.definition.name !== 'read_student_facts' ? contribution.definition : { ...contribution.definition,
        inputSchema: { ...contribution.definition.inputSchema, required: ['scope'], properties: {
          ...(contribution.definition.inputSchema.properties as Record<string, unknown>),
          scope: { type: 'string', enum: ['current-activity', 'same-course'] } } } };
      return { definition, effect: contribution.effect === 'read' ? 'read' : definition.name === 'generate_teaching_artifact' ? 'write' : 'execute',
        scope: workspaceFacts({ contribution, actionDigest: canonicalDigest(workspace.action), activityId: workspace.activity.activityId }) };
    });
  }
  return { id: 'workspace-tools', version: 1, list,
    async prepare(context, offer, intent, commandId) {
      if (intent.name !== offer.definition.name || !(await list(context)).some(current => canonicalDigest(current) === canonicalDigest(offerOf(offer))))
        throw new StorageError('incompatible');
      if (!compileOutputSchema(offer.definition.inputSchema)(intent.arguments)) throw new StorageError('invalid');
      const workspace = await resolveWorkspace(options, context.snapshot, context.inputIds), step = modelStep(context);
      if (intent.name === 'read_reference' && workspace.action.draft.references.some(reference => reference.referenceId === intent.arguments.referenceId
        && reference.source.kind === 'pdf')) throw new StorageError('incompatible');
      const prepared = await host.prepare(toolScope(context, workspace, step.stepId), intent, commandId);
      return { commandId, name: prepared.name, effect: effectOf(prepared.effect, prepared.name),
        input: workspaceFacts({ version: 1, offer: offerOf(offer), modelStepId: step.stepId, prepared }) };
    },
    async dispatch(context, command, permit, assertDispatch) {
      const fixed = fixedCommand(command);
      if (permit.sessionId !== context.snapshot.session.sessionId || permit.runId !== context.snapshot.run.runId
        || permit.operationId !== command.commandId || !context.snapshot.steps.some(step => step.stepId === permit.stepId
          && step.operation.kind === 'tool.call' && step.operation.operationId === command.commandId)) throw new StorageError('forbidden');
      if (!(await list(context)).some(offer => canonicalDigest(offer) === canonicalDigest(fixed.offer))) throw new StorageError('incompatible');
      const scope = retainedScope(context, fixed);
      const live = async () => {
        await assertDispatch();
        const current = await authorizedWorkspace(options, context.snapshot);
        if (current.activityId !== scope.activity.activityId || canonicalDigest(current.course ?? null) !== canonicalDigest(scope.activity.course ?? null))
          throw new StorageError('identity-conflict');
        await assertDispatch();
      };
      await live();
      return executionOutcome(await host.dispatch({ ...scope, assertDispatch: live }, fixed.prepared), scope, fixed.prepared);
    },
    async reconcile(context, command) {
      const fixed = fixedCommand(command);
      const scope = retainedScope(context, fixed), current = await authorizedWorkspace(options, context.snapshot);
      if (current.activityId !== scope.activity.activityId || canonicalDigest(current.course ?? null) !== canonicalDigest(scope.activity.course ?? null))
        throw new StorageError('identity-conflict');
      const original = context.snapshot.steps.find(step => step.operation.kind === 'tool.call' && step.operation.operationId === command.commandId)?.result?.value.outcome;
      if (original) return original as unknown as ConversationToolOutcome;
      const retained = await host.reconcileOriginal(scope, fixed.prepared);
      return retained ? executionOutcome(retained, scope, fixed.prepared) : null;
    },
    async stop(context, command) {
      const fixed = fixedCommand(command), scope = retainedScope(context, fixed);
      const retained = await host.stop(scope, fixed.prepared);
      return retained ? outcomeOf(retained) : null;
    },
    async validateResponse() { throw new StorageError('forbidden'); },
  };
}

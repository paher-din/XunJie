import { createHash } from 'node:crypto';
import { compileOutputSchema } from '../model-connections/chat-native.js';
import { z } from 'zod';
import { StorageError } from '@xunjie/storage';
import { actionInputSchema } from '@xunjie/contracts/action-intents';
import { componentInstanceId, componentStateName, matchesComponentState } from '@xunjie/contracts/components';
import { canonicalValue, decideExecutionPlacement, defaultExecutionLimits, executionActionSchema, anyExecutionActionSchema, executionControlSchema, isTerminalExecutionState,
  type AnyExecutionAction, type ExecutionDevice, type ExecutionQuery } from '@xunjie/contracts/execution';
import type { ModelToolIntent } from '@xunjie/contracts/model-connections';
import type { createLearningData } from '../learning-data/index.js';
import type { createCourses } from '../courses/index.js';
import type { AgentExecutionContext, AgentExecutionOrigin } from '../learning-data/agent-executions.js';
import { verifyPlannedExecution } from '../learning-data/plan.js';
import type { TeachingToolHost, TeachingToolScope, TeachingToolCleanupScope, TeachingPreparedTool, TeachingToolOutcome } from './tool-types.js';
import { teachingDefinitions, teachingContributions } from './tools-schema.js';
import { aluVerificationAction } from './alu-tools.js';
import { imageRoute, retainWorkImage, type TeachingImageModels } from './tools-images.js';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonicalValue(value))).digest('hex');
function fail(code: 'forbidden' | 'missing' | 'invalid' | 'identity-conflict' | 'corrupt' | 'unavailable'): never { throw new StorageError(code); }
const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) freeze(child); }
  return value;
};
type HostScope = TeachingToolScope & { assertDispatch?: () => Promise<void>; device?: ExecutionDevice };
type Courses = Pick<ReturnType<typeof createCourses>, 'referenceText' | 'verifyComponentReference' | 'readComponent' | 'readComponentAlgorithm'>;
export function createTeachingTools(options: {
  learning: () => ReturnType<typeof createLearningData>;
  courses: Courses;
  models?: TeachingImageModels;
  /** Alternative to scope.assertDispatch for hosts that reconstruct a permit by original association. */
  executionOrigin?: () => AgentExecutionOrigin | undefined;
  authorizeDispatch?: (scope: TeachingToolScope, command: TeachingPreparedTool) => Promise<void>;
  device?: (scope: TeachingToolScope) => Promise<ExecutionDevice | undefined>;
  environment?: (scope: TeachingToolScope) => Promise<{ device: ExecutionDevice; remoteAvailable: boolean }>;
}): TeachingToolHost {
  const learning = options.learning;
  async function authorize(scope: TeachingToolCleanupScope) {
    actionInputSchema.parse(scope.input);
    const identity = { environmentId: scope.identity.environmentId, spaceId: scope.identity.spaceId,
      principalId: scope.identity.principalId, activityId: scope.activity.activityId };
    if (digest(scope.input.scope) !== digest(identity) || digest(scope.activity.identity) !== digest(scope.identity)) fail('forbidden');
    const current = await learning().open(scope.identity, scope.activity.activityId);
    if (digest(current.course ?? null) !== digest(scope.activity.course ?? null)) fail('identity-conflict');
    if (current.course?.helpPolicy?.questions === 'disabled') fail('forbidden');
    return current;
  }
  function context(scope: TeachingToolCleanupScope, command: TeachingPreparedTool, newDispatch = false): AgentExecutionContext {
    const origin = options.executionOrigin?.();
    // Reconciliation/claim reads use the already accepted original command, not a new Driver permit.
    const { authority: _authority, ...acceptedScope } = scope;
    return { ...(origin ? { origin } : {}), runId: scope.runId, stepId: scope.stepId, commandId: command.commandId, snapshotId: scope.snapshotId,
      assertDispatch: async () => {
        if ((scope as HostScope).assertDispatch) await (scope as HostScope).assertDispatch!();
        else if (options.authorizeDispatch) await options.authorizeDispatch((newDispatch ? scope : acceptedScope) as TeachingToolScope, command);
        else fail('forbidden');
      } };
  }
  function scopeBasis(scope: TeachingToolCleanupScope) {
    return { identity: scope.identity, activityId: scope.activity.activityId, runId: scope.runId,
      stepId: scope.stepId, snapshotId: scope.snapshotId, segmentId: scope.segmentId ?? null, input: scope.input, course: scope.activity.course ?? null };
  }
  function approvedFile(scope: TeachingToolScope, objectId: string, contentId: string) {
    const files = [...scope.input.works, ...scope.input.draft.bases];
    const file = files.find(item => item.objectId === objectId && item.contentId === contentId);
    const ref = scope.input.draft.references.find(item => item.source.kind === 'work'
      && item.source.objectId === objectId && item.source.contentId === contentId);
    if (!file && !ref) fail('forbidden');
    return { file, ref };
  }
  async function originalQuery(scope: TeachingToolScope, command: TeachingPreparedTool, requestId: string, approved = false) {
    const ref = scope.input.draft.references.find(item => item.source.kind === 'component'
      && item.source.origin === 'execution-result' && item.source.requestId === requestId);
    if (approved && ref) {
      await learning().drafts.verifyReferences(scope.identity, scope.activity.activityId, { references: [ref], bases: [] });
      const query = await learning().executions.read(scope.identity, scope.activity.activityId, requestId);
      if (query && (ref.source.kind !== 'component' || query.executionRef !== ref.source.executionRef)) fail('identity-conflict');
      return query;
    }
    return learning().executions.agent.read(scope.identity, scope.activity.activityId, context(scope, command), requestId);
  }
  async function prepare(scope: TeachingToolScope, intent: ModelToolIntent, commandId: string, fixed?: AnyExecutionAction): Promise<TeachingPreparedTool> {
    await authorize(scope); z.uuid().parse(commandId);
    const definition = teachingContributions(scope).find(item => item.definition.name === intent.name
      && (intent.name !== 'course_operation' || item.source.componentKey === intent.arguments.componentKey))?.definition;
    if (!definition || !compileOutputSchema(definition.inputSchema)(intent.arguments)) fail('invalid');
    for (const key of ['objectId', 'contentId', 'referenceId', 'materialId', 'requestId'])
      if (Object.hasOwn(intent.arguments, key) && !z.uuid().safeParse(intent.arguments[key]).success) fail('invalid');
    const args = structuredClone(intent.arguments), name = intent.name;
    let effect: TeachingPreparedTool['effect'] = 'read', location: TeachingPreparedTool['location'] = 'owner';
    let conflictKey = scope.activity.activityId, detail: Record<string, unknown> = {};
    if (name === 'read_work') {
      const { file, ref } = approvedFile(scope, String(args.objectId), String(args.contentId));
      const version = await learning().works.inspectVersion(scope.identity, scope.activity.activityId,
        { objectId: String(args.objectId), contentId: String(args.contentId) });
      const sourceState = !version.retained ? 'missing' : version.isCurrent ? 'fixed-current'
        : version.everPublished ? 'older-version' : 'fixed-unpublished';
      detail = { ...(file ? { file } : {}), ...(ref ? { reference: ref } : {}), objectId: args.objectId, contentId: args.contentId,
        provenance: { ...version, sourceState },
        ...(file?.mediaType === 'image/png' ? { imageRoute: await imageRoute(scope, options.models) } : {}) };
    } else if (name === 'read_reference') {
      const reference = scope.input.draft.references.find(item => item.referenceId === args.referenceId);
      if (!reference) fail('forbidden');
      detail = { reference };
    } else if (name === 'read_material') {
      const course = scope.activity.course, material = course?.materials.find(item => item.materialId === args.materialId);
      if (!course || !material) fail('forbidden');
      if (!/^(text\/(plain|markdown|csv)|application\/json)(;|$)/.test(material.mediaType)) fail('invalid');
      detail = { source: { kind: 'course-material', courseId: course.courseId, taskId: course.taskId,
        releaseId: course.releaseId, contentDigest: course.contentDigest, materialId: material.materialId,
        materialSha256: material.sha256, mediaType: material.mediaType } };
    } else if (name === 'course_operation') {
      const binding = scope.activity.course?.components?.find(item => item.key === args.componentKey);
      if (!binding || !scope.activity.course) fail('forbidden');
      const manifest = binding.definition.manifest;
      await options.courses.verifyComponentReference(scope.identity, { releaseId: scope.activity.course.releaseId,
        key: binding.key, definitionDigest: binding.definition.digest });
      if (manifest.formatVersion === 3) {
        const action = aluVerificationAction(scope, binding, commandId, String(args.operationId), args.parameters);
        for (const file of action.execution.basis.works) {
          const original = await learning().works.content(scope.identity, scope.activity.activityId, file.contentId);
          if (original.objectId !== file.objectId || original.value !== file.value || original.kind !== file.kind
            || original.encoding !== file.encoding || original.mediaType !== file.mediaType) fail('corrupt');
        }
        return freeze(structuredClone({ version: 1, commandId, name, arguments: args, effect: 'execute' as const,
          location: 'browser' as const, conflictKey: conflictKey + ':component:' + binding.key,
          basis: { scope: scopeBasis(scope), binding, action, requestId: commandId } }));
      }
      if (manifest.formatVersion !== 1) fail('invalid');
      const fixedAction = fixed?.protocolVersion === 2 ? fixed : undefined;
      const native = !!manifest.session;
      const operationId = native ? manifest.session!.operation.operationId : String(args.operationId);
      const declared = manifest.operations?.find(item => item.operationId === operationId);
      location = native ? 'native' : 'browser'; effect = native ? 'input' : 'execute';
      conflictKey += ':component:' + binding.key;
      verifyPlannedExecution(scope.activity, { key: binding.key, definitionDigest: binding.definition.digest, operationId, location });
      if (native && args.operationId !== 'start_session') {
        const control = executionControlSchema.parse({ controlId: commandId, operationId, effect: 'input',
          expectedSeq: args.expectedSeq, parameters: args.parameters });
        const original = await learning().executions.agent.original(scope.identity, scope.activity.activityId,
          { runId: scope.runId, stepId: scope.stepId, snapshotId: scope.snapshotId, commandId, assertDispatch: async () => fail('forbidden') }, String(args.requestId));
        if (!original || original.action.execution.instance.key !== binding.key
          || original.action.execution.instance.definitionDigest !== binding.definition.digest) fail('forbidden');
        location = original.action.receiver.location === 'remote' ? 'remote' : 'native';
        detail = { binding, control, requestId: args.requestId, original: { action: original.action, association: original.association } };
      } else {
        const stateFile = [...scope.input.works, ...scope.input.draft.bases].find(item => item.name === componentStateName(binding.key));
        if (stateFile && !matchesComponentState(binding, scope.activity.activityId, stateFile)) fail('invalid');
        // An absent state means the declared initial state. Never substitute a newer workspace version.
        const resources = native ? [] : [{ kind: 'entry', ...manifest.entry }, { kind: 'algorithm', ...manifest.algorithm!.resource }];
        const planId = native ? 'native-session' : 'browser-job';
        const limits = native ? { timeMs: Math.min(defaultExecutionLimits.timeMs, manifest.session!.budgets.operationTimeoutMs), memoryPages: 1,
          inputBytes: manifest.session!.budgets.inputBytes, outputBytes: manifest.session!.budgets.outputBytes,
          concurrentJobs: Math.min(2, manifest.session!.budgets.concurrentSessions), queuedJobs: Math.min(4, manifest.session!.budgets.queuedSessions) }
          : { ...defaultExecutionLimits, timeMs: declared!.budgets.timeMs,
            memoryPages: manifest.algorithm!.memoryPages, outputBytes: declared!.budgets.outputBytes };
        const environment = native && !fixedAction ? await options.environment?.(scope) : undefined;
        const device = fixedAction ? fixedAction.execution.device : native
          ? (scope as HostScope).device ?? environment?.device ?? await options.device?.(scope) : undefined;
        let receiverLocation = fixedAction?.receiver.location ?? 'local';
        if (native && !fixedAction && scope.activity.course.executionPlan) {
          if (!device) fail('unavailable');
          const placement = decideExecutionPlacement({ operationId, kind: 'session', adapter: manifest.session!,
            plan: scope.activity.course.executionPlan, device, remoteAvailable: environment?.remoteAvailable ?? false });
          if (placement.location !== 'native' || placement.owner !== 'device' && placement.owner !== 'school-node') fail('unavailable');
          receiverLocation = placement.owner === 'school-node' ? 'remote' : 'local';
        }
        if (native && receiverLocation === 'remote') location = 'remote';
        const action = executionActionSchema.parse({ protocolVersion: 2, kind: 'execution', requestId: commandId,
          scope: { environmentId: scope.identity.environmentId, spaceId: scope.identity.spaceId,
            principalId: scope.identity.principalId, activityId: scope.activity.activityId },
          receiver: { receiverId: native ? 'native-execution' : 'browser-execution', location: receiverLocation, kind: 'execution' },
          execution: { instance: { instanceId: componentInstanceId(scope.activity.activityId, binding.key), key: binding.key,
            componentId: manifest.componentId, componentVersion: manifest.version, definitionDigest: binding.definition.digest,
            hostApiVersion: manifest.hostApiVersion, stateVersion: manifest.stateVersion },
            operation: { operationId, effect: native ? 'input' : 'execute' }, parameters: args.parameters,
            basis: { works: stateFile ? [stateFile] : [], state: stateFile ? { name: stateFile.name,
              contentId: stateFile.contentId, sha256: digest(JSON.parse(stateFile.value)) } : null,
              expected: { stateContentId: stateFile?.contentId ?? null }, resources }, limits,
            plan: { planId, planVersion: 1, location: native ? 'native' : 'browser', kind: native ? 'session' : 'job',
              planDigest: digest({ planId, planVersion: 1, componentId: manifest.componentId, componentVersion: manifest.version, operationId }) },
            ...(native ? { session: { adapterId: manifest.session!.adapterId, adapterVersion: manifest.session!.adapterVersion,
              limits: Object.fromEntries(['operationTimeoutMs', 'idleMs', 'maxMs', 'memoryMiB', 'concurrentSessions', 'queuedSessions']
                .map(key => [key, (manifest.session!.budgets as Record<string, number>)[key]])) } } : {}),
            ...(device ? { device } : {}), initiator: { kind: 'agent', principalId: scope.identity.principalId } } });
        detail = { binding, action, requestId: commandId };
      }
    } else {
      const reference = name !== 'execution_stop' ? scope.input.draft.references.find(item => item.source.kind === 'component'
        && item.source.origin === 'execution-result' && item.source.requestId === args.requestId) : undefined;
      const original = reference ? null : await learning().executions.agent.original(scope.identity, scope.activity.activityId,
        { runId: scope.runId, stepId: scope.stepId, snapshotId: scope.snapshotId, commandId, assertDispatch: async () => fail('forbidden') }, String(args.requestId));
      if (!reference && !original) fail('forbidden');
      detail = { requestId: args.requestId, ...(reference ? { reference } : { original: original ? { action: original.action, association: original.association } : null }) };
      if (name === 'execution_stop') { effect = 'stop'; conflictKey += ':execution:' + String(args.requestId); }
    }
    return freeze(structuredClone({ version: 1, commandId, name, arguments: args, effect, location, conflictKey,
      basis: { scope: scopeBasis(scope), ...detail } }));
  }
  async function check(scope: TeachingToolScope, command: TeachingPreparedTool) {
    await authorize(scope);
    if (command.version !== 1 || digest(command.basis.scope) !== digest(scopeBasis(scope))) fail('identity-conflict');
    const fresh = await prepare(scope, { callId: command.commandId, name: command.name, arguments: command.arguments }, command.commandId,
      command.basis.action ? anyExecutionActionSchema.parse(command.basis.action) : undefined);
    // Publication metadata was observed at preparation, not a condition that can replace or
    // invalidate the approved bytes when a later edit moves the head.
    const comparable = command.name === 'read_work'
      ? { ...fresh, basis: { ...fresh.basis, provenance: command.basis.provenance } } : fresh;
    if (digest(comparable) !== digest(command)) fail('identity-conflict');
  }
  function outcome(command: TeachingPreparedTool, state: TeachingToolOutcome['state'], result: Record<string, unknown>, label: string,
    query?: ExecutionQuery | null): TeachingToolOutcome {
    const text = JSON.stringify({ state, ...result });
    return { state, feedback: { outcome: state === 'failed' ? 'error' : state === 'not-dispatched' ? 'not-executed' : 'success',
      text: text.length > 8000 ? text.slice(0, 7900) + '\n[展示已裁剪；完整结果保留在原记录中]' : text, images: [] }, result,
      source: { label, ...(command.arguments.componentKey ? { componentKey: String(command.arguments.componentKey) } : {}),
        ...(query ? { requestId: query.requestId } : {}),
        ...(command.arguments.contentId ? { contentId: String(command.arguments.contentId) } : {}) },
      ...(query ? { execution: { requestId: query.requestId, executionRef: query.executionRef, inputDigest: query.inputDigest } } : {}) };
  }
  async function queryOutcome(scope: TeachingToolCleanupScope, command: TeachingPreparedTool, query: ExecutionQuery | null) {
    if (!query) return null;
    let state: TeachingToolOutcome['state'] = query.statusKnowledge === 'unknown' ? 'unknown'
      : query.state === 'failed' || query.state === 'cancelled' ? 'failed' : query.state === 'succeeded' ? 'completed' : 'accepted';
    const control = command.basis.control as { controlId: string } | undefined;
    let receipt;
    if (control) {
      receipt = await learning().executions.controlReceipt(scope.identity, scope.activity.activityId, query.requestId, control.controlId);
      if (receipt?.status === 'applied') state = 'completed';
      else if (receipt?.status === 'unknown') state = 'unknown';
      else if (receipt?.status === 'rejected') state = 'failed';
    } else if (command.name === 'course_operation' && query.session && query.state === 'running'
      && query.statusKnowledge === 'confirmed') state = 'completed';
    if (command.effect === 'read') state = 'completed';
    if (command.name === 'execution_stop' && query.statusKnowledge === 'confirmed' && isTerminalExecutionState(query.state)) state = 'completed';
    const artifact = query.output ? await learning().executions.artifact(scope.identity, scope.activity.activityId, query.requestId) : null;
    return outcome(command, state, { query, ...(receipt ? { controlReceipt: receipt } : {}), ...(artifact ? { artifact } : {}),
      ...(control ? { operationObservation: query.session?.observations.find(item => item.controlId === control.controlId) ?? null } : {}),
      operationCompleted: state === 'completed', sessionOngoing: !!query.session && ['running', 'paused'].includes(query.state) }, '原执行结果', query);
  }
  async function dispatch(scope: TeachingToolScope, command: TeachingPreparedTool): Promise<TeachingToolOutcome> {
    await check(scope, command);
    const a = command.arguments, id = scope.activity.activityId;
    if (command.name === 'read_work') {
      const { file, ref } = approvedFile(scope, String(a.objectId), String(a.contentId));
      let stored;
      try { stored = await learning().works.content(scope.identity, id, String(a.contentId)); }
      catch (error) {
        if (!(error instanceof StorageError) || !['missing', 'resource-gone', 'unavailable', 'corrupt'].includes(error.code)) throw error;
        const sourceState = error.code === 'missing' ? 'missing' : error.code === 'corrupt' ? 'corrupt' : 'unavailable';
        return outcome(command, 'failed', { objectId: a.objectId, contentId: a.contentId, sourceState, code: error.code }, '固定作品来源');
      }
      if (stored.objectId !== a.objectId || stored.contentId !== a.contentId) fail('identity-conflict');
      if (file && (file.value !== stored.value || file.encoding !== stored.encoding || file.kind !== stored.kind
        || file.mediaType !== stored.mediaType)) fail('corrupt');
      const content = { ...stored, name: file?.name ?? ref?.sourceName ?? String(a.objectId) };
      if (content.mediaType === 'image/png') {
        const route = command.basis.imageRoute as { available?: boolean } | undefined;
        if (!options.models || !route?.available) return outcome(command, 'failed',
          { objectId: content.objectId, contentId: content.contentId, sourceState: 'unavailable', code: 'image-capability-unverified' }, content.name);
        const retained = await retainWorkImage(scope, options.models, command.commandId, content);
        const result = outcome(command, 'completed', { file: content, image: retained.image,
          ...(command.basis.provenance as Record<string, unknown>) }, content.name);
        result.feedback = { outcome: 'success', images: [retained.reference], text: JSON.stringify({
          objectId: content.objectId, contentId: content.contentId, name: content.name, mediaType: content.mediaType,
          byteLength: retained.byteLength, image: retained.reference, sha256: retained.image.sha256,
          ...(command.basis.provenance as Record<string, unknown>) }) };
        return result;
      }
      if (content.encoding === 'base64' || !/^(text\/|application\/(json|vnd\.xunjie\.component-state\+json))/.test(content.mediaType))
        return outcome(command, 'failed', { objectId: content.objectId, contentId: content.contentId,
          mediaType: content.mediaType, sourceState: 'unavailable', code: 'unsupported-media-type' }, content.name);
      return outcome(command, 'completed', { file: content, ...(command.basis.provenance as Record<string, unknown>) }, content.name);
    }
    if (command.name === 'read_reference') {
      const reference = scope.input.draft.references.find(item => item.referenceId === a.referenceId)!;
      await learning().drafts.verifyReferences(scope.identity, id, { references: [reference], bases: scope.input.draft.bases
        .filter(file => 'contentId' in reference.source && file.contentId === reference.source.contentId) });
      return outcome(command, 'completed', { reference }, reference.sourceName);
    }
    if (command.name === 'read_material') {
      const source = command.basis.source;
      return outcome(command, 'completed', { source, ...await options.courses.referenceText(scope.identity, source) }, '课程开放材料');
    }
    if (command.name === 'course_operation') {
      const ctx = context(scope, command, true), requestId = String(command.basis.requestId);
      const query = command.basis.control
        ? await learning().executions.agent.control(scope.identity, id, ctx, requestId, command.basis.control)
        : await learning().executions.agent.dispatch(scope.identity, id, ctx, command.basis.action);
      return await queryOutcome(scope, command, query) ?? outcome(command, 'accepted',
        { requestId, delivery: 'waiting-browser', action: command.basis.action }, '等待原浏览器执行');
    }
    if (command.name === 'execution_stop') return await stop(scope, command) ?? outcome(command, 'not-dispatched', { requestId: a.requestId }, '原执行尚未确认');
    const query = await originalQuery(scope, command, String(a.requestId), true);
    return await queryOutcome(scope, command, query) ?? outcome(command, 'not-dispatched', { requestId: a.requestId }, '原执行尚未确认');
  }
  async function reconcile(scope: TeachingToolScope, command: TeachingPreparedTool) {
    await check(scope, command);
    if (command.effect === 'read') return dispatch(scope, command);
    const requestId = String(command.basis.requestId ?? command.arguments.requestId ?? command.commandId);
    const query = await learning().executions.agent.read(scope.identity, scope.activity.activityId, context(scope, command), requestId);
    return await queryOutcome(scope, command, query) ?? cancellationOutcome(scope, command, requestId);
  }
  async function cancellationOutcome(scope: TeachingToolCleanupScope, command: TeachingPreparedTool, requestId: string, cleanup = false) {
    const inspect = cleanup ? learning().executions.agent.cleanupStatus : learning().executions.agent.status;
    const status = await inspect(scope.identity, scope.activity.activityId, context(scope, command), requestId);
    if (!status?.cancelled) return null;
    return outcome(command, status.claimed ? 'unknown' : 'not-dispatched',
      { requestId, cancelled: true, delivery: status.claimed ? 'stopping-original-browser' : 'cancelled-before-dispatch',
        browserId: status.browserId }, status.claimed ? '正在核对原浏览器停止' : '已取消待发命令');
  }
  async function stop(scope: TeachingToolCleanupScope, command: TeachingPreparedTool) {
    // Cleanup checks the durable original capability, not current eligibility for new effects.
    if (command.version !== 1 || digest(command.basis.scope) !== digest(scopeBasis(scope))) fail('identity-conflict');
    if (command.effect === 'read') return null;
    const requestId = String(command.basis.requestId ?? command.arguments.requestId ?? command.commandId);
    const query = await learning().executions.agent.cleanup(scope.identity, scope.activity.activityId, context(scope, command), requestId,
      { stopId: stopId(command.commandId), reason: '' });
    if (!query) return cancellationOutcome(scope, command, requestId, true);
    try {
      // Normal eligibility may expose the original late result/artifact. Revoked callers
      // receive only the restricted cleanup proof below, never source/result contents.
      await authorize(scope);
      const evidence = await queryOutcome(scope, command, query);
      if (evidence) {
        const completed = query.statusKnowledge === 'confirmed' && isTerminalExecutionState(query.state);
        return outcome(command, completed ? evidence.state : query.statusKnowledge === 'unknown' ? 'unknown' : 'accepted',
          { ...evidence.result, cleanup: true, stopId: stopId(command.commandId), cleanupCompleted: completed,
            sessionStopped: !!query.session && completed }, '原执行清理', query);
      }
    } catch (error) {
      if (!(error instanceof StorageError) || !['forbidden', 'identity-conflict', 'missing'].includes(error.code)) throw error;
    }
    const completed = query.statusKnowledge === 'confirmed' && isTerminalExecutionState(query.state);
    const state = completed ? command.name === 'execution_stop' || query.state === 'succeeded' ? 'completed' : 'failed' : 'unknown';
    return outcome(command, state,
      { query, cleanup: true, stopId: stopId(command.commandId), cleanupCompleted: completed, operationCompleted: state === 'completed',
        sessionStopped: !!query.session && completed, sessionOngoing: !!query.session && ['running', 'paused'].includes(query.state) }, '原执行清理', query);
  }
  return { contributions: async scope => { await authorize(scope); return teachingContributions(scope); },
    definitions: async scope => { await authorize(scope); return teachingDefinitions(scope); }, prepare, dispatch, reconcile, stop };
}
function stopId(commandId: string) {
  const hex = createHash('sha256').update('agent-stop:' + commandId).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

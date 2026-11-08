import { StorageError, type OwnedStorage } from '@xunjie/storage';
import { resolvedAgentSchema } from '@xunjie/contracts/teaching-agent';
import { canonicalDigest, operationId } from './identity.js';
import { compactionPolicy, createTeachingCompaction, parseCompactionResult, summaryMessage, type CompactionSource } from './compaction.js';
import { portableContext } from './context.js';

/** Retained derivatives are part of the owner's restore closure. This path is pure reading. */
export async function validateTeachingCompactions(storage: OwnedStorage) {
  const compactions = createTeachingCompaction(storage);
  const { rows } = await storage.read('SELECT * FROM teaching_compactions ORDER BY activity_id,source_end,created_at');
  for (const row of rows) {
    const source = row.body as CompactionSource;
    if (!source || source.compactionId !== row.compaction_id || source.runId !== row.run_id || source.stepId !== row.step_id
      || source.compactionId !== operationId('context-compaction:' + source.stepId)
      || source.sourceStart !== Number(row.source_start) || source.sourceEnd !== Number(row.source_end)
      || !Number.isSafeInteger(source.sourceStart) || !Number.isSafeInteger(source.sourceEnd)
      || source.sourceStart < 1 || source.sourceEnd < source.sourceStart
      || canonicalDigest(source.policy) !== canonicalDigest(compactionPolicy)
      || !Array.isArray(source.messages) || !source.messages.length || canonicalDigest(source.messages) !== source.contentDigest
      || !Array.isArray(source.retained) || canonicalDigest(source.retained) !== source.retainedDigest
      || source.retained.some(item => canonicalDigest(item.content) !== item.contentDigest)
      || new Set(source.retained.map(item => item.id)).size !== source.retained.length) throw new StorageError('corrupt');
    const original = resolvedAgentSchema.parse(source.resolvedAgent), { resolvedId, ...basis } = original;
    if (original.scope.activityId !== row.activity_id || resolvedId !== operationId('resolved-agent:' + canonicalDigest(basis))
      || original.definitionDigest !== canonicalDigest(original.definition)) throw new StorageError('corrupt');
    const events = await compactions.sourceEvents(String(row.activity_id), source.sourceStart, source.sourceEnd);
    if (events.length !== source.sourceEnd - source.sourceStart + 1 || canonicalDigest(events) !== source.sourceDigest
      || canonicalDigest(events) !== canonicalDigest(source.events)
      || !['run-completed','tools-paired','assistant'].includes(events.at(-1)!.kind)
      || !await compactions.closed(String(row.activity_id), source.sourceStart, source.sourceEnd)) throw new StorageError('corrupt');
    const prior = source.previousId ? rows.find(item => item.compaction_id === source.previousId) : null;
    if (source.previousId && (!prior || prior.activity_id !== row.activity_id || prior.state !== 'adopted'
      || Number(prior.source_end) + 1 !== source.sourceStart) || !source.previousId && source.sourceStart !== 1)
      throw new StorageError('corrupt');
    let previousSequence = 0;
    for (const message of source.messages) {
      if (message.eventSeq <= previousSequence || (message.eventId === source.previousId
        ? message.eventSeq !== Number(prior?.source_end)
        : !events.some(event => event.seq === message.eventSeq && event.eventId === message.eventId))) throw new StorageError('corrupt');
      previousSequence = message.eventSeq;
    }
    const { rows: [run] } = await storage.read('SELECT activity_id FROM teaching_runs WHERE run_id=$1', [row.run_id]);
    const { rows: [step] } = await storage.read('SELECT * FROM teaching_steps WHERE step_id=$1', [row.step_id]);
    if (run?.activity_id !== row.activity_id || step && (step.run_id !== row.run_id
      || canonicalDigest((step.plan as { compaction?: unknown }).compaction) !== canonicalDigest(source))) throw new StorageError('corrupt');
    if (step) {
      const plan = step.plan as { resolvedAgent?: { tools: unknown[] }; input: { purpose?: string } };
      if (plan.input.purpose !== 'learning' || !plan.resolvedAgent || plan.resolvedAgent.tools.length) throw new StorageError('corrupt');
    }
    if (row.result) {
      try { parseCompactionResult(JSON.stringify(row.result), source); } catch { throw new StorageError('corrupt'); }
      if (!row.result_ref) throw new StorageError('corrupt');
    }
    if (['generated','adopted'].includes(String(row.state)) && (!step || !row.result || !row.result_ref)) throw new StorageError('corrupt');

    // Generation is committed before budget settlement. The event binds the
    // original attempt even when the step has not committed its result_ref yet.
    const { rows: decisions } = await storage.read(`SELECT activity_id,seq,kind,body FROM teaching_events
      WHERE body->>'compactionId'=$1 AND kind IN ('context-compaction-generated','context-compaction-rejected','context-compacted')`,
    [row.compaction_id]);
    const generations = decisions.filter(event => event.kind === 'context-compaction-generated'
      || event.kind === 'context-compaction-rejected' && (event.body as Record<string, unknown>).attemptId !== undefined);
    if (generations.length > 1 || (row.result || row.result_ref || ['generated','adopted'].includes(String(row.state)))
      && generations.length !== 1) throw new StorageError('corrupt');
    const generation = generations[0];
    if (generation) {
      const body = generation.body as Record<string, unknown>;
      if (!step || generation.activity_id !== row.activity_id || Number(generation.seq) <= source.sourceEnd
        || body.runId !== row.run_id || body.stepId !== row.step_id || body.attemptId !== step.attempt_id
        || body.resultRef !== row.result_ref || !Object.hasOwn(body, 'result')
        || canonicalDigest(body.result) !== canonicalDigest(row.result)
        || row.state === 'selected'
        || generation.kind === 'context-compaction-generated' && (!row.result || !row.result_ref || body.reason !== '')
        || generation.kind === 'context-compaction-rejected' && row.state !== 'rejected') throw new StorageError('corrupt');
      if (step.usage === null) {
        if (step.phase !== 'model' || step.result_ref !== null || row.state === 'adopted') throw new StorageError('corrupt');
      } else if (step.result_ref !== row.result_ref) throw new StorageError('corrupt');
    }
    if (step) {
      const { rows: origins } = await storage.read(`SELECT activity_id,state,to_segment_id,assembly_id
        FROM teaching_segment_transitions WHERE compaction_id=$1 AND reason='compaction-generation'`, [row.compaction_id]);
      if (origins.length !== 1 || origins[0]!.activity_id !== row.activity_id || origins[0]!.state !== 'completed'
        || origins[0]!.to_segment_id !== step.segment_id || origins[0]!.assembly_id !== step.resolved_agent_id)
        throw new StorageError('corrupt');
    }
    const choices = decisions.filter(event => event.kind === 'context-compacted');
    if (row.state === 'adopted') {
      const { rows: [transition] } = await storage.read('SELECT * FROM teaching_segment_transitions WHERE transition_id=$1', [row.adoption_transition_id]);
      const choice = choices[0]?.body as Record<string, unknown> | undefined;
      if (!row.adopted_at || !transition || transition.state !== 'completed' || transition.reason !== 'compaction'
        || transition.activity_id !== row.activity_id || transition.compaction_id !== row.compaction_id || choices.length !== 1
        || !generation || generation.kind !== 'context-compaction-generated'
        || choices[0]!.activity_id !== row.activity_id || Number(choices[0]!.seq) <= Number(generation.seq)
        || !choice || choice.runId !== row.run_id || choice.transitionId !== row.adoption_transition_id || choice.resultRef !== row.result_ref
        || !choice.source || canonicalDigest(choice.source) !== canonicalDigest(source)
        || !choice.result || canonicalDigest(choice.result) !== canonicalDigest(row.result)) throw new StorageError('corrupt');
      const portable = (transition.create_body as { portable: { role: string; text: string }[] }).portable;
      const expected = portableContext([summaryMessage(await compactions.read(String(row.compaction_id)), true)]);
      if (!portable.some((_, index) => expected.every((message, offset) =>
        portable[index + offset]?.role === message.role && portable[index + offset]?.text === message.text)))
        throw new StorageError('corrupt');
    } else if (row.adopted_at || row.adoption_transition_id || choices.length) throw new StorageError('corrupt');
  }
  const { rows: transitions } = await storage.read('SELECT compaction_id,reason,state FROM teaching_segment_transitions WHERE compaction_id IS NOT NULL');
  for (const transition of transitions) {
    const record = rows.find(row => row.compaction_id === transition.compaction_id);
    if (!record || !String(transition.reason).startsWith('compaction')
      || transition.state === 'abandoned' && record.state !== 'rejected') throw new StorageError('corrupt');
  }
}

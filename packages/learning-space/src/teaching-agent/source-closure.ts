import type { OwnedStorage } from '@xunjie/storage';
import { collectSources, validateSources } from '../learning-data/source-closure.js';
import type { SourceSpec, OwnerSourceClosure } from '../learning-data/source-closure.js';

export const teachingSourceOwner = 'xunjie.teaching-agent';

const teachingSpecs: readonly SourceSpec[] = [
  { table: 'teaching_sessions', kind: 'teaching_sessions', id: ['activity_id'], version: ['next_seq'] },
  { table: 'teaching_requests', kind: 'teaching_requests', id: ['request_id'], version: ['request_id', 'input_digest'] },
  { table: 'teaching_runs', kind: 'teaching_runs', id: ['run_id'], version: ['request_id', 'generation'] },
  { table: 'teaching_agent_definitions', kind: 'teaching_agent_definitions', id: ['definition_id', 'version'], version: ['version'] },
  { table: 'teaching_resolved_agents', kind: 'teaching_resolved_agents', id: ['resolved_id'] },
  { table: 'teaching_segments', kind: 'teaching_segments', id: ['segment_id'] },
  { table: 'teaching_segment_transitions', kind: 'teaching_segment_transitions', id: ['transition_id'], version: ['activity_id', 'generation'] },
  { table: 'teaching_snapshots', kind: 'teaching_snapshots', id: ['snapshot_id'] },
  { table: 'teaching_steps', kind: 'teaching_steps', id: ['step_id'], version: ['run_id', 'step_no'] },
  { table: 'teaching_commands', kind: 'teaching_commands', id: ['command_id'], version: ['run_id', 'ordinal'] },
  { table: 'teaching_waits', kind: 'teaching_waits', id: ['wait_id'], version: ['command_id', 'purpose'] },
  { table: 'teaching_budgets', kind: 'teaching_budgets', id: ['run_id'] },
  { table: 'teaching_events', kind: 'teaching_events', id: ['event_id'], version: ['activity_id', 'seq', 'event_version'] },
  { table: 'teaching_compactions', kind: 'teaching_compactions', id: ['compaction_id'], version: ['run_id', 'source_end'] },
  { table: 'teaching_skills', kind: 'teaching_skills', id: ['owner_key', 'skill_id'], version: ['version'] },
  { table: 'teaching_skill_versions', kind: 'teaching_skill_versions', id: ['owner_key', 'skill_id', 'version'], version: ['version'] },
  { table: 'teaching_skill_selections', kind: 'teaching_skill_selections', id: ['owner_key', 'range_key'] },
  { table: 'teaching_skill_loads', kind: 'teaching_skill_loads', id: ['command_id'], version: ['fingerprint'] },
  { table: 'teaching_student_facts', kind: 'teaching_student_facts', id: ['fact_id'], version: ['content_version'] },
  { table: 'teaching_student_questions', kind: 'teaching_student_questions', id: ['question_id'], version: ['state'] },
  { table: 'teaching_student_responses', kind: 'teaching_student_responses', id: ['request_id'] },
  { table: 'teaching_student_presentations', kind: 'teaching_student_presentations', id: ['request_id'] },
  { table: 'teaching_inputs', kind: 'teaching_inputs', id: ['input_id'], version: ['version'] },
  { table: 'teaching_input_revisions', kind: 'teaching_input_revisions', id: ['input_id', 'version'], version: ['version'] },
  { table: 'teaching_controls', kind: 'teaching_controls', id: ['request_id'] },
  { table: 'teaching_model_switches', kind: 'teaching_model_switches', id: ['request_id'], version: ['selection_version', 'generation'] },
  { table: 'teaching_dependency_bindings', kind: 'teaching_dependency_bindings', id: ['name'] },
  { table: 'teaching_run_input_selections', kind: 'teaching_run_input_selections', id: ['run_id', 'input_id'] },
  { table: 'agent_chunk_transfers', kind: 'agent_chunk_transfers', id: ['source_key', 'transfer_id'] },
  { table: 'agent_chunk_parts', kind: 'agent_chunk_parts', id: ['source_key', 'transfer_id', 'direction', 'part_index'] },
];

export function collectTeachingSources(storage: OwnedStorage): Promise<OwnerSourceClosure> {
  return collectSources(storage, teachingSourceOwner, teachingSpecs);
}
export function validateTeachingSources(storage: OwnedStorage, material: unknown): Promise<void> {
  return validateSources(storage, material, teachingSourceOwner, teachingSpecs);
}

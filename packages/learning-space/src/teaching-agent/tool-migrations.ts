import type { Migration } from '@xunjie/storage';

export const teachingToolMigration: Migration = { version: 2, name: 'durable-model-steps-tools-and-waits', sql: `
  CREATE TABLE teaching_budgets(run_id uuid PRIMARY KEY REFERENCES teaching_runs(run_id),
    max_model_steps integer NOT NULL,max_tool_commands integer NOT NULL,max_parallel_tools integer NOT NULL,
    wait_ms bigint NOT NULL);
  CREATE TABLE teaching_steps(step_id uuid PRIMARY KEY,run_id uuid NOT NULL REFERENCES teaching_runs(run_id),
    step_no integer NOT NULL,attempt_id uuid NOT NULL UNIQUE,segment_id uuid NOT NULL,snapshot_id uuid NOT NULL UNIQUE,
    phase text NOT NULL CHECK(phase IN ('planned','model','tools','waiting','completed','final')),
    plan jsonb NOT NULL,result_ref uuid,usage jsonb,output_reserved integer NOT NULL,
    output_settled integer,paired boolean NOT NULL DEFAULT false,dispatch_permitted boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(run_id,step_no));
  CREATE TABLE teaching_commands(command_id uuid PRIMARY KEY,run_id uuid NOT NULL REFERENCES teaching_runs(run_id),
    step_id uuid NOT NULL REFERENCES teaching_steps(step_id),call_id text NOT NULL,ordinal integer NOT NULL,
    command jsonb NOT NULL,state text NOT NULL CHECK(state IN ('prepared','dispatching','waiting','settled')),
    outcome jsonb,initial_outcome jsonb,resource_id uuid,
    generation integer,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(step_id,call_id));
  CREATE INDEX teaching_commands_run ON teaching_commands(run_id,ordinal);
  CREATE TABLE teaching_waits(wait_id uuid PRIMARY KEY,run_id uuid NOT NULL REFERENCES teaching_runs(run_id),
    step_id uuid NOT NULL REFERENCES teaching_steps(step_id),command_id uuid NOT NULL REFERENCES teaching_commands(command_id),
    purpose text NOT NULL CHECK(purpose IN ('result','cleanup')),
    state text NOT NULL CHECK(state IN ('pending','consumed','expired')),reason text NOT NULL,
    identity jsonb NOT NULL,command_digest text NOT NULL,deadline timestamptz NOT NULL,next_check_at timestamptz NOT NULL,
    checks integer NOT NULL DEFAULT 0,consumed_at timestamptz,UNIQUE(command_id,purpose));
  CREATE INDEX teaching_waits_due ON teaching_waits(next_check_at) WHERE state IN ('pending','expired');
` };

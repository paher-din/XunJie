import { createWorkspaceApp, type WorkspaceAppOptions } from '../workspace/application.ts';
import { ApiError } from './errors.ts';
import { attachOriginalJobHost,guardHostTransport } from './original-job-host.ts';

export type I0AppOptions = WorkspaceAppOptions & {staticDirectory?:string;consumerIntervalMs?:number};
export async function createI0App(options:I0AppOptions) {
  const approvedTables=['activity_controls','activity_versions','artifact_snapshots','assignments','attempts','audit_events',
    'blueprint_drafts','check_rule_versions','command_receipts','competency_versions','course_memberships','courses',
    'help_policy_versions','jobs','login_attempt_windows','resource_versions','sessions','users','workspace_command_bindings',
    'workspace_files','workspace_process_records','workspace_reopen_grants','workspace_runs','workspace_submissions'];
  const tables=options.db.withTransaction(tx=>tx.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map(row=>String(row.name)));
  if (JSON.stringify(tables)!==JSON.stringify(approvedTables)) throw new ApiError('INVALID_CONFIGURATION');
  const admission={accepting:true};
  const runner=options.runner?guardHostTransport(options.runner,admission,{dispatch:['submit'],readiness:'readiness'}):undefined;
  const service=await createWorkspaceApp({...options,...(runner?{runner}:{})});

  try {
    const host=attachOriginalJobHost(service,options,{admission});
    return {...service,...host};
  } catch(error) {await service.app.close();throw error;}
}

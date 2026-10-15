import { createWorkspaceApp, type WorkspaceAppOptions } from '../workspace/application.ts';
import { createTutoringApp, type TutoringAppOptions } from '../tutoring/application.ts';
import type { ModelProvider } from '../tutoring/providers.ts';
import { originalTeachingConsumer } from './original-teaching-host.ts';
import { ApiError } from './errors.ts';
import { attachOriginalJobHost,guardHostTransport } from './original-job-host.ts';
import {personalModels,type PersonalModelsOptions} from './personal-models.ts';

export type I0AppOptions = Omit<WorkspaceAppOptions,'checkReadiness'|'checkReady'> & {staticDirectory?:string;consumerIntervalMs?:number;personalModels?:PersonalModelsOptions;tutoring?:{studentHelp:TutoringAppOptions['studentHelp'];provider:ModelProvider}};
export async function createI0App(options:I0AppOptions) {
  const approvedTables=['activity_controls','activity_versions','artifact_snapshots','assignments','attempts','audit_events',
    'blueprint_drafts','check_rule_versions','command_receipts','competency_versions','course_memberships','courses',
    'help_policy_versions','jobs','login_attempt_windows','resource_versions','sessions','users','workspace_command_bindings',
    'workspace_files','workspace_process_records','workspace_reopen_grants','workspace_runs','workspace_submissions'];
  if(options.tutoring) approvedTables.push('teaching_action_receipts','teaching_actions','teaching_deliveries','teaching_messages');
  approvedTables.sort();
  const tables=options.db.withTransaction(tx=>tx.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map(row=>String(row.name)));
  if (JSON.stringify(tables)!==JSON.stringify(approvedTables)) throw new ApiError('INVALID_CONFIGURATION');
  const admission={accepting:true};
  const runner=options.runner?guardHostTransport(options.runner,admission,{dispatch:['submit','editor_diagnostics'],readiness:'readiness'}):undefined;
  let host:ReturnType<typeof attachOriginalJobHost>;
  const {tutoring,...base}=options;
  const guarded={...base,...(runner?{runner}:{}),checkReadiness:async()=>{
    await host.checkReady();
    return true;
  }};
  const personal:ReturnType<typeof personalModels>|undefined=options.personalModels?personalModels(options.personalModels,
    (request):string=>options.db.withTransaction(tx=>service.access.authenticatedUserInTransaction(request,tx)),
    tutoring?.studentHelp??{versions:{modelConfig:'personal-unconfigured',prompt:'student-help-v1',schema:'student-help-v1',policy:'activity-policy'},budgetAvailable:()=>false},options.db):undefined;
  const service=await (tutoring?createTutoringApp({...guarded,studentHelp:personal?.studentHelp??tutoring.studentHelp}):createWorkspaceApp(guarded))
    .catch(async error=>{await personal?.close();throw error;});
  if(personal){personal.register(service.app);service.app.addHook('onClose',async()=>personal.close());}
  const teaching=tutoring?originalTeachingConsumer(service as Awaited<ReturnType<typeof createTutoringApp>>,options,tutoring.provider,admission):undefined;

  try {
    host=attachOriginalJobHost(service,{...options,...(runner?{runner}:{})},{admission,...(teaching?{startAdditional:teaching.start,additionalReady:teaching.isHealthy,stopInTransaction:teaching.stopInTransaction,stopAdditional:teaching.stop}:{})});
    return {...service,...host};
  } catch(error) {await service.app.close();throw error;}
}

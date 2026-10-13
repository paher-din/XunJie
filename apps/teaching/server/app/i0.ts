import { z } from 'zod';
import { createWorkspaceApp, type WorkspaceAppOptions } from '../workspace/application.ts';
import { assignmentCourse, readAssignment, assignmentAvailability } from '../design/activities.ts';
import { assignmentBootstrapSchema } from '../../contracts/design/i0.ts';
import { ApiError } from './errors.ts';
import { parseRequest } from './validation.ts';

import { cancelJob } from '../records/jobs.ts';
import { loadWorkspace, persistWorkspace } from '../workspace/storage.ts';
import { registerI0Static } from './i0-static.ts';

export type I0AppOptions = WorkspaceAppOptions & {staticDirectory?:string;consumerIntervalMs?:number};
export async function createI0App(options: I0AppOptions) {
  const approvedTables=['activity_controls','activity_versions','artifact_snapshots','assignments','attempts','audit_events',
    'blueprint_drafts','check_rule_versions','command_receipts','competency_versions','course_memberships','courses',
    'help_policy_versions','jobs','login_attempt_windows','resource_versions','sessions','users','workspace_command_bindings',
    'workspace_files','workspace_process_records','workspace_reopen_grants','workspace_runs','workspace_submissions'];
  const tables=options.db.withTransaction(tx=>tx.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map(row=>String(row.name)));
  if (JSON.stringify(tables)!==JSON.stringify(approvedTables)) throw new ApiError('INVALID_CONFIGURATION');
  let accepting = true;
  const transport=options.runner;
  const service = await createWorkspaceApp({...options,...(transport ? {runner:async command=>{
    if (!accepting && ['submit','readiness'].includes(command.op)) throw new ApiError('DEPENDENCY_UNAVAILABLE');
    const response=await transport(command);
    if (!accepting && command.op==='readiness') throw new ApiError('DEPENDENCY_UNAVAILABLE');
    return response;
  }} : {})});
  const { app, access, workspace } = service;
  let timer:ReturnType<typeof setTimeout>|undefined, inFlight:Promise<void>|undefined;
  let started = false, closing:Promise<void>|undefined;
  app.addHook('onRequest',async request => {
    if (!accepting && !['GET','HEAD'].includes(request.method)) throw new ApiError('DEPENDENCY_UNAVAILABLE');
  });
  const interval = options.consumerIntervalMs ?? 250;
  if (!Number.isInteger(interval) || interval < 50 || interval > 10000) {
    await app.close(); throw new ApiError('INVALID_CONFIGURATION');
  }
  async function consume() {
    for (const id of workspace.pendingJobs()) {
      try { await workspace.processJob(id); }
      catch { app.log.error({errorCode:'DEPENDENCY_UNAVAILABLE'},'Original job reconciliation failed.'); }
    }
  }
  function tick() {
    if (!accepting) return;
    inFlight = consume().catch(() => { app.log.error({errorCode:'PERSISTENCE_UNAVAILABLE'},'Original job scan failed.'); })
      .finally(() => { inFlight = undefined; if (accepting) timer = setTimeout(tick,interval); });
  }
  function startConsumer() {
    if (started || !accepting) return;
    started = true;
    tick();
  }
  async function stopOriginalJobs() {
    // Stop the original rows atomically before waiting for an external dispatch.
    // The original worker will observe stopRequested and query/cancel those same identities.
    const ids = workspace.pendingJobs();
    options.db.withTransaction(tx => {
      const attempts = new Set<string>();
      for (const id of ids) {
        const row = tx.get('SELECT attempt_id FROM jobs WHERE job_id=?',id);
        if (row?.attempt_id) attempts.add(String(row.attempt_id));
      }
      for (const id of attempts) {
        const before = loadWorkspace(tx,id);
        const after = {...before,records:{...before.records,jobs:before.records.jobs.map(job =>
          ids.includes(job.jobId) ? cancelJob(job) : job)}};
        persistWorkspace(tx,before,after);
      }
    });
    if (inFlight) await inFlight;
    await consume();
  }
  function close() {
    if (!closing) {
      accepting = false;
      if (timer) clearTimeout(timer);
      closing = (async () => {
        try { await app.close(); } finally { await stopOriginalJobs(); }
      })();
    }
    return closing;
  }
  app.get('/api/assignments/:id/bootstrap', (request,reply) => {
    reply.header('cache-control','no-store');
    const id = parseRequest(z.strictObject({id:z.string().min(1).max(128)}), request.params).id;
    const data = access.withAuthorizedCourse(request, tx => assignmentCourse(tx,id), undefined, (tx,actor) => {
      const assignment = readAssignment(tx,actor.courseId,id);
      if (actor.role === 'student' && assignment.student_id !== actor.userId) throw new ApiError('FORBIDDEN');
      const recoveryGeneration = options.currentGeneration();
      if (!recoveryGeneration) throw new ApiError('RECOVERY_REQUIRED');
      const availability = assignmentAvailability(tx,actor.courseId,id,assignment.student_id);
      return assignmentBootstrapSchema.parse({recoveryGeneration,assignment:{
        assignmentId:id,activityVersionId:assignment.activity_id,studentId:assignment.student_id,
        assignmentRevision:assignment.assignment_revision,active:availability.active,status:assignment.status,
        reasons:{individual:assignment.individual_reason,activity:assignment.activity_reason},
        activityControlRevision:availability.activityControlRevision,
      }});
    },false);
    return {requestId:request.id,data};
  });
  if (options.staticDirectory) {
    try { registerI0Static(app,options.staticDirectory); }
    catch(error) { await app.close(); throw error; }
  }
  return {...service,startConsumer,close};
}

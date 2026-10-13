import { z } from 'zod';
import { createWorkspaceApp, type WorkspaceAppOptions } from '../workspace/application.ts';
import { assignmentCourse, readAssignment, assignmentAvailability } from '../design/activities.ts';
import { assignmentBootstrapSchema } from '../../contracts/design/i0.ts';
import { ApiError } from './errors.ts';
import { parseRequest } from './validation.ts';

import { cancelJob } from '../records/jobs.ts';
import { loadWorkspace, persistWorkspace } from '../workspace/storage.ts';
import { registerI0Static } from './i0-static.ts';
import { createTutoringApp, type TutoringAppOptions } from '../tutoring/application.ts';
import type { ModelProvider } from '../tutoring/providers.ts';
import { readTeachingJob, stopTeachingJobsInTransaction } from '../records/teaching.ts';
import { saveJob } from '../db/records-adapter.ts';
import { recoverJob } from '../records/jobs.ts';

export type I0AppOptions = WorkspaceAppOptions & {staticDirectory?:string;consumerIntervalMs?:number;
  tutoring?: {studentHelp:TutoringAppOptions['studentHelp'];provider:ModelProvider}};
export async function createI0App(options: I0AppOptions) {
  const approvedTables=['activity_controls','activity_versions','artifact_snapshots','assignments','attempts','audit_events',
    'blueprint_drafts','check_rule_versions','command_receipts','competency_versions','course_memberships','courses',
    'help_policy_versions','jobs','login_attempt_windows','resource_versions','sessions','users','workspace_command_bindings',
    'workspace_files','workspace_process_records','workspace_reopen_grants','workspace_runs','workspace_submissions'];
  if(options.tutoring) approvedTables.push('teaching_action_receipts','teaching_actions','teaching_deliveries','teaching_messages');
  approvedTables.sort();
  const tables=options.db.withTransaction(tx=>tx.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map(row=>String(row.name)));
  if (JSON.stringify(tables)!==JSON.stringify(approvedTables)) throw new ApiError('INVALID_CONFIGURATION');
  let accepting = true;
  const transport=options.runner;
  const {tutoring:tutoringOptions,...baseOptions}=options;
  const guardedOptions:WorkspaceAppOptions={...baseOptions,...(transport ? {runner:async command=>{
    if (!accepting && ['submit','readiness'].includes(command.op)) throw new ApiError('DEPENDENCY_UNAVAILABLE');
    const response=await transport(command);
    if (!accepting && command.op==='readiness') throw new ApiError('DEPENDENCY_UNAVAILABLE');
    return response;
  }} : {})};
  const service = tutoringOptions
    ? await createTutoringApp({...guardedOptions,studentHelp:tutoringOptions.studentHelp})
    : await createWorkspaceApp(guardedOptions);
  const tutoring=tutoringOptions?(service as Awaited<ReturnType<typeof createTutoringApp>>).tutoring:undefined;
  const { app, access, workspace } = service;
  let timer:ReturnType<typeof setTimeout>|undefined, inFlight:Promise<void>|undefined;
  let teachingTimer:ReturnType<typeof setTimeout>|undefined,teachingScan:Promise<void>|undefined;
  let started = false, closing:Promise<void>|undefined;
  const teachingTasks=new Map<string,{controller:AbortController;task:Promise<unknown>}>();
  const now=options.now??Date.now;
  app.addHook('onRequest',async request => {
    if (!accepting && !['GET','HEAD'].includes(request.method)) throw new ApiError('DEPENDENCY_UNAVAILABLE');
  });
  const interval = options.consumerIntervalMs ?? 250;
  if (!Number.isInteger(interval) || interval < 50 || interval > 10000) {
    await app.close(); throw new ApiError('INVALID_CONFIGURATION');
  }
  async function consumeRuns() {
    for (const id of workspace.pendingJobs()) {
      try { await workspace.processJob(id); }
      catch { app.log.error({errorCode:'DEPENDENCY_UNAVAILABLE'},'Original job reconciliation failed.'); }
    }
  }
  async function consumeTeaching() {
    if(!tutoring||!tutoringOptions) return;
    const jobs=options.db.withTransaction(tx=>tx.all("SELECT course_id,job_id FROM jobs WHERE purpose='student_help'")
      .map(row=>readTeachingJob(tx,String(row.course_id),String(row.job_id))!).filter(Boolean));
    for(const job of jobs) {
      const running=teachingTasks.get(job.jobId);
      if(running) {
        if(job.stopRequested||job.recoveryGeneration!==options.currentGeneration()||Date.parse(job.deadline)<=now()) running.controller.abort();
        continue;
      }
      // A previous process's lease is never a license to repeat a provider call.
      if(job.status==='running') {
        const recovered=recoverJob(job,new Date(now()).toISOString());
        if(recovered.status!==job.status) options.db.withTransaction(tx=>saveJob(tx,recovered));
        continue;
      }
      if(!accepting||job.status!=='queued'||job.stopRequested) continue;
      if(job.recoveryGeneration!==options.currentGeneration()||Date.parse(job.deadline)<=now()) {
        options.db.withTransaction(tx=>saveJob(tx,{...job,status:job.recoveryGeneration!==options.currentGeneration()?'stale':'timed_out',
          stopRequested:true,failure:'not_dispatchable'}));
        continue;
      }
      const controller=new AbortController();
      const task=tutoring.processJob(job.jobId,tutoringOptions.provider,controller.signal).catch(error=> {
        app.log.error({errorCode:'DEPENDENCY_UNAVAILABLE'},'Original tutoring job failed.');
        options.db.withTransaction(tx=> {
          const current=readTeachingJob(tx,job.scope.courseId,job.jobId);
          if(current&&!current.stopRequested&&['queued','running'].includes(current.status)
            &&current.recoveryGeneration===job.recoveryGeneration) {
            const forbidden=error instanceof ApiError&&error.code==='FORBIDDEN';
            saveJob(tx,{...current,status:forbidden?'stale':'failed',failure:forbidden?'authority_unavailable':'dependency_unavailable',
              ...(forbidden?{stopRequested:true}:{})});
          }
        });
      }).finally(()=>teachingTasks.delete(job.jobId));
      teachingTasks.set(job.jobId,{controller,task});
    }
  }
  function tick() {
    if (!accepting) return;
    inFlight = consumeRuns().catch(() => { app.log.error({errorCode:'PERSISTENCE_UNAVAILABLE'},'Original job scan failed.'); })
      .finally(() => { inFlight = undefined; if (accepting) timer = setTimeout(tick,interval); });
  }
  function teachingTick() {
    if(!accepting||!tutoring) return;
    teachingScan=consumeTeaching().catch(()=>{app.log.error({errorCode:'PERSISTENCE_UNAVAILABLE'},'Original teaching scan failed.');})
      .finally(()=>{teachingScan=undefined;if(accepting) teachingTimer=setTimeout(teachingTick,interval);});
  }
  function startConsumer() {
    if (started || !accepting) return;
    started = true;
    tick();
    teachingTick();
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
      if(tutoring) {
        const rows=tx.all("SELECT course_id,student_id,attempt_id,job_id FROM jobs WHERE purpose='student_help' AND status IN ('queued','running','outcome_unknown')");
        const scopes=new Map<string,{scope:{courseId:string;studentId:string;attemptId:string};ids:string[]}>();
        for(const row of rows) {
          const scope={courseId:String(row.course_id),studentId:String(row.student_id),attemptId:String(row.attempt_id)};
          const key=JSON.stringify(scope),group=scopes.get(key)??{scope,ids:[]};
          group.ids.push(String(row.job_id));scopes.set(key,group);
        }
        for(const {scope,ids:jobIds} of scopes.values()) stopTeachingJobsInTransaction(tx,{scope,jobIds,
          actorId:scope.studentId,reason:'host_shutdown',generation:options.currentGeneration(),now:new Date(now()).toISOString()});
      }
    });
    for(const {controller} of teachingTasks.values()) controller.abort();
    if (inFlight) await inFlight;
    if(teachingScan) await teachingScan;
    await consumeRuns();
    await Promise.allSettled([...teachingTasks.values()].map(value=>value.task));
  }
  function close() {
    if (!closing) {
      accepting = false;
      if (timer) clearTimeout(timer);
      if(teachingTimer) clearTimeout(teachingTimer);
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

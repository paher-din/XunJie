import { z } from 'zod';
import type { WorkspaceAppOptions, createWorkspaceApp } from '../workspace/application.ts';
import { assignmentCourse, readAssignment, assignmentAvailability } from '../design/activities.ts';
import { assignmentBootstrapSchema } from '../../contracts/design/i0.ts';
import { ApiError } from './errors.ts';
import { parseRequest } from './validation.ts';
import { cancelJob } from '../records/jobs.ts';
import { loadWorkspace, persistWorkspace } from '../workspace/storage.ts';
import { registerI0Static } from './i0-static.ts';
import type { Transaction } from '../db/transaction.ts';

export type HostAdmission = { accepting:boolean };
export function guardHostTransport<Command extends {op:string}>(
  transport:(command:Command)=>Promise<unknown>,admission:HostAdmission,
  operations:{dispatch:readonly Command['op'][];readiness:Command['op']},
) {
  return async(command:Command)=>{
    if(!admission.accepting&&(operations.dispatch.includes(command.op)||command.op===operations.readiness))
      throw new ApiError('DEPENDENCY_UNAVAILABLE');
    const response=await transport(command);
    if(!admission.accepting&&command.op===operations.readiness)throw new ApiError('DEPENDENCY_UNAVAILABLE');
    return response;
  };
}
type OriginalService = Pick<Awaited<ReturnType<typeof createWorkspaceApp>>, 'app'|'access'|'workspace'>;
type HostOptions = Pick<WorkspaceAppOptions,'db'|'currentGeneration'> & {staticDirectory?:string;consumerIntervalMs?:number};
type ExecutionHooks = {admission:HostAdmission;consumeAdditional?:()=>Promise<void>;
  stopInTransaction?:(tx:Transaction)=>void;reconcile?:()=>Promise<void>};

// I0 and DL-A wrap their original business factories in the same host; only execution reconciliation differs.
export function attachOriginalJobHost(service:OriginalService,options:HostOptions,hooks:ExecutionHooks) {
  const {app,access,workspace}=service,{admission}=hooks;
  let timer:ReturnType<typeof setTimeout>|undefined,inFlight:Promise<void>|undefined;
  let started=false,closing:Promise<void>|undefined;
  const interval=options.consumerIntervalMs??250;
  if(!Number.isInteger(interval)||interval<50||interval>10000) throw new ApiError('INVALID_CONFIGURATION');
  app.addHook('onRequest',async request=>{
    if(!admission.accepting&&!['GET','HEAD'].includes(request.method)) throw new ApiError('DEPENDENCY_UNAVAILABLE');
  });
  function consumeOnce():Promise<void> {
    if(inFlight) return inFlight;
    const work=(async()=>{
      for(const id of workspace.pendingJobs()) {
        try {await workspace.processJob(id);}
        catch {app.log.error({errorCode:'DEPENDENCY_UNAVAILABLE'},'Original job reconciliation failed.');}
      }
      await hooks.consumeAdditional?.();
      await hooks.reconcile?.();
    })();
    inFlight=work;
    return work.finally(()=>{if(inFlight===work)inFlight=undefined;});
  }
  function tick() {
    if(!admission.accepting)return;
    void consumeOnce().catch(()=>{app.log.error({errorCode:'PERSISTENCE_UNAVAILABLE'},'Original job scan failed.');})
      .finally(()=>{if(admission.accepting)timer=setTimeout(tick,tickInterval);});
  }
  function startConsumer(intervalMs=interval) {
    if(!Number.isInteger(intervalMs)||intervalMs<50||intervalMs>10000)throw new ApiError('INVALID_CONFIGURATION');
    if(started||!admission.accepting)return;
    started=true;
    // The public DL-A method previously accepted an interval; preserve it without a second loop.
    tickInterval=intervalMs;
    tick();
  }
  let tickInterval=interval;
  async function stopOriginalJobs() {
    const ids=workspace.pendingJobs();
    options.db.withTransaction(tx=>{
      const attempts=new Set<string>();
      for(const id of ids) {
        const row=tx.get('SELECT attempt_id FROM jobs WHERE job_id=?',id);
        if(row?.attempt_id)attempts.add(String(row.attempt_id));
      }
      for(const id of attempts) {
        const before=loadWorkspace(tx,id);
        const after={...before,records:{...before.records,jobs:before.records.jobs.map(job=>ids.includes(job.jobId)?cancelJob(job):job)}};
        persistWorkspace(tx,before,after);
      }
      hooks.stopInTransaction?.(tx);
    });
    await hooks.reconcile?.();
    if(inFlight)await inFlight;
    await consumeOnce();
  }
  function close() {
    if(!closing) {
      admission.accepting=false;
      if(timer)clearTimeout(timer);
      closing=(async()=>{try {await app.close();} finally {await stopOriginalJobs();}})();
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

  if(options.staticDirectory)registerI0Static(app,options.staticDirectory);
  return {consumeOnce,startConsumer,close,isAccepting:()=>admission.accepting};
}

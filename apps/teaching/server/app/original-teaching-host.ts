import type { Transaction } from '../db/transaction.ts';
import type { createTutoringApp } from '../tutoring/application.ts';
import type { ModelProvider } from '../tutoring/providers.ts';
import { readTeachingJob, stopTeachingJobsInTransaction } from '../records/teaching.ts';
import { saveJob } from '../db/records-adapter.ts';
import { recoverJob } from '../records/jobs.ts';
import { ApiError } from './errors.ts';
import type { HostAdmission } from './original-job-host.ts';

export function originalTeachingConsumer(
  service: Awaited<ReturnType<typeof createTutoringApp>>,
  options: {db:Parameters<typeof createTutoringApp>[0]['db'];currentGeneration:()=>string;now?:()=>number},
  provider: ModelProvider,
  admission: HostAdmission,
) {
  const tasks=new Map<string,{controller:AbortController;task:Promise<unknown>}>();
  const now=options.now??Date.now;
  let timer:ReturnType<typeof setTimeout>|undefined,scan:Promise<void>|undefined,started=false;
  async function consume() {
    const jobs=options.db.withTransaction(tx=>tx.all("SELECT course_id,job_id FROM jobs WHERE purpose='student_help'")
      .map(row=>readTeachingJob(tx,String(row.course_id),String(row.job_id))!).filter(Boolean));
    for(const job of jobs) {
      const running=tasks.get(job.jobId);
      if(running) {
        if(job.stopRequested||job.recoveryGeneration!==options.currentGeneration()||Date.parse(job.deadline)<=now()) running.controller.abort();
        continue;
      }
      // An old worker lease never authorizes repeating a provider call.
      if(job.status==='running') {
        const recovered=recoverJob(job,new Date(now()).toISOString());
        if(recovered.status!==job.status) options.db.withTransaction(tx=>saveJob(tx,recovered));
        continue;
      }
      if(!admission.accepting||job.status!=='queued'||job.stopRequested) continue;
      if(job.recoveryGeneration!==options.currentGeneration()||Date.parse(job.deadline)<=now()) {
        options.db.withTransaction(tx=>saveJob(tx,{...job,status:job.recoveryGeneration!==options.currentGeneration()?'stale':'timed_out',
          stopRequested:true,failure:'not_dispatchable'}));
        continue;
      }
      const controller=new AbortController();
      const task=service.tutoring.processJob(job.jobId,provider,controller.signal).catch(error=> {
        service.app.log.error({errorCode:'DEPENDENCY_UNAVAILABLE'},'Original tutoring job failed.');
        options.db.withTransaction(tx=> {
          const current=readTeachingJob(tx,job.scope.courseId,job.jobId);
          if(current&&!current.stopRequested&&['queued','running'].includes(current.status)
            &&current.recoveryGeneration===job.recoveryGeneration) {
            const forbidden=error instanceof ApiError&&error.code==='FORBIDDEN';
            const stale=forbidden||error instanceof ApiError&&['STATE_CONFLICT','VERSION_CONFLICT'].includes(error.code);
            saveJob(tx,{...current,status:stale?'stale':'failed',failure:forbidden?'authority_unavailable':stale?'basis_unavailable':'dependency_unavailable',
              ...(stale?{stopRequested:true}:{})});
          }
        });
      }).finally(()=>tasks.delete(job.jobId));
      tasks.set(job.jobId,{controller,task});
    }
  }
  function stopInTransaction(tx:Transaction) {
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
  async function stop() {
    if(timer)clearTimeout(timer);
    for(const {controller} of tasks.values()) controller.abort();
    if(scan)await scan;
    await Promise.allSettled([...tasks.values()].map(value=>value.task));
  }
  function start(interval:number) {
    if(started||!admission.accepting)return;
    started=true;
    const tick=()=>{
      if(!admission.accepting)return;
      scan=consume().catch(()=>{service.app.log.error({errorCode:'PERSISTENCE_UNAVAILABLE'},'Original teaching scan failed.');})
        .finally(()=>{scan=undefined;if(admission.accepting)timer=setTimeout(tick,interval);});
    };
    tick();
  }
  return {consume,start,stopInTransaction,stop};
}

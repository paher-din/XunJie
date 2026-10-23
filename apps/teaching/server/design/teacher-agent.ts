import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DesignVerificationOptions } from './app.ts';
import type { createAccessApp } from '../access/app.ts';
import type { Transaction } from '../db/transaction.ts';
import type { Job } from '../../contracts/records/index.ts';
import type { ModelUsage, TrustedModelContext, TutoringOutcome, TeacherGenerationBody } from '../../contracts/tutoring/index.ts';
import { InputLimitError,ProviderCallNotStartedError,type ModelProvider } from '../tutoring/providers.ts';
import { CALL_VERDICT_WINDOW_MS,generateTeacherProposal } from '../tutoring/core.ts';
import { claimJob, recordModelCall, finishJob, cancelJob, recoverJob } from '../records/jobs.ts';
import { canonical } from '../records/commands.ts';
import { finishRecordCommand, enqueueStoredJob, saveJob } from '../db/records-adapter.ts';
import { ApiError, domainError } from '../app/errors.ts';
import {budgetedProvider,ModelQueueError,type ModelBudget} from '../personal-agent/model-budget.ts';
import { parseRequest } from '../app/validation.ts';
import { contentPatchSchema } from '../../contracts/design/draft.ts';
import { agentCreateSchema, adoptProposalSchema, teacherBodySchema, proposalRequestSchema, rubricTrialRequestSchema } from '../../contracts/design/proposals.ts';
import { readDraft, createStoredDraft, resultSchema, draftCourse } from './storage.ts';
import { loadTeacherRequest, saveTeacherRequest, saveUsages, selectReferences, teacherContextCurrent,
  proposalForJob, readProposal, saveProposal, hashResultBytes, simpleContent, modelVersionsSchema,
  type StoredTeacherRequest, type DesignProposal } from './teacher-storage.ts';

export interface TeacherAgentOptions {
  modelBudget?:ModelBudget;
  provider: ModelProvider; versions: TrustedModelContext['versions'];
  budgetAvailable: (context:{courseId:string;actorId:string;usages:readonly ModelUsage[]}) => boolean;
  /**
   * Additive per-teacher resolution. When present it replaces the static `provider`/`versions` above for that
   * teacher, so an approved personal model is bound to the request at accept time and a later model change makes
   * the request stale instead of silently reusing the new configuration. Absent hooks keep the static behaviour.
   */
  providerForTeacher?: (context:{actorId:string;courseId:string;modelConfig:string}) => ModelProvider;
  versionsForTeacher?: (context:{actorId:string;courseId:string}) => TrustedModelContext['versions'];
  /**
   * Round accounting needs the original request rows, so it must run inside the caller's transaction; nesting is
   * not allowed. When present this replaces `budgetAvailable`.
   */
  budgetAvailableInTransaction?: (tx:Transaction,context:{courseId:string;actorId:string;usages:readonly ModelUsage[]}) => boolean;
}
export interface TeacherResultDelivery {
  jobId:string; leaseToken:string; recoveryGeneration:string; outcome:TutoringOutcome<TeacherGenerationBody>; bodyJson?:string;
}
export class TeacherResultCommitError extends ApiError {
  readonly delivery:TeacherResultDelivery;
  constructor(delivery:TeacherResultDelivery) {
    super('PERSISTENCE_UNAVAILABLE');
    this.delivery = structuredClone(delivery);
  }
}

type Access = Awaited<ReturnType<typeof createAccessApp>>['access'];
const id = z.string().min(1).max(128), params = z.strictObject({id}), key = id.regex(/^[\x21-\x7e]+$/);
const generationInput = z.strictObject({recoveryGeneration:id});
const acceptedSchema = z.strictObject({jobId:id,status:z.literal('queued')});
const progressSchema = z.strictObject({jobId:id,status:z.string(),attemptCount:z.number().int().nonnegative().max(3)});
const knownFields = Object.keys(contentPatchSchema.shape);
const timeString = (now:number) => new Date(now).toISOString();

export function registerTeacherAgent(app:FastifyInstance,access:Access,options:DesignVerificationOptions,config:TeacherAgentOptions,registerJobRoutes=true) {
  const now = options.now ?? Date.now, versions = parseRequest(modelVersionsSchema,config.versions);
  const versionsFor = (actorId:string,courseId:string) => config.versionsForTeacher
    ? parseRequest(modelVersionsSchema,config.versionsForTeacher({actorId,courseId})) : versions;
  const inFlight = new Map<string,AbortController>();
  const persisted = <T>(work:(tx:Transaction) => T) => {
    try {
      const startedGeneration = options.currentGeneration();
      return options.db.withTransaction(tx => { const result = work(tx); generation(startedGeneration); return result; });
    } catch (error) { throw domainError(error,'PERSISTENCE_UNAVAILABLE'); }
  };
  function generation(expected:string) {
    if (!expected || options.currentGeneration() !== expected) throw new ApiError('RECOVERY_REQUIRED');
    return expected;
  }
  function original(tx:Transaction,jobId:string) {
    const work = loadTeacherRequest(tx,jobId); generation(work.job.recoveryGeneration); return work;
  }
  function requireActor(work:ReturnType<typeof original>,actor:{userId:string;courseId:string}) {
    if (actor.userId !== work.input.actorId || actor.courseId !== work.input.courseId) throw new ApiError('FORBIDDEN');
  }
  function budget(tx:Transaction,input:StoredTeacherRequest,usages:ModelUsage[]) {
    const context = {courseId:input.courseId,actorId:input.actorId,usages:structuredClone(usages)};
    const value = config.budgetAvailableInTransaction
      ? config.budgetAvailableInTransaction(tx,context) : config.budgetAvailable(context);
    if (typeof value !== 'boolean') throw new ApiError('DEPENDENCY_UNAVAILABLE');
    return value;
  }
  function progress(tx:Transaction,work:ReturnType<typeof original>,next:Job,apply:() => void = () => {}) {
    return finishRecordCommand(tx,{actorId:work.input.actorId,command:'teacher-design.progress',target:next.jobId,
      scope:next.scope,idempotencyKey:randomUUID(),recoveryGeneration:next.recoveryGeneration},
      {status:next.status,attemptCount:next.attemptCount},next.recoveryGeneration,now(),() => {
        saveJob(tx,next); apply(); return {jobId:next.jobId,status:next.status,attemptCount:next.attemptCount};
      },value => progressSchema.parse(value));
  }
  function enqueue(request:FastifyRequest,courseScope:string|((tx:Transaction) => string),raw:unknown,blueprintId?:string,trial=false) {
    const input = blueprintId ? trial ? parseRequest(rubricTrialRequestSchema,raw) : parseRequest(proposalRequestSchema,raw) : parseRequest(agentCreateSchema,raw);
    const idempotencyKey = parseRequest(key,request.headers['idempotency-key']);
    const data = access.withAuthorizedCourse(request,courseScope,'teacher',(tx,actor) => {
      const courseId = actor.courseId,current = generation(input.recoveryGeneration),scope = {courseId,blueprintId:blueprintId ?? null};
      let created:{request:StoredTeacherRequest;job:Job}|undefined;
      const receipt = finishRecordCommand(tx,{actorId:actor.userId,command:trial ? 'teacher-design.rubric-trial' : blueprintId ? 'teacher-design.proposal' : 'teacher-design.create',
        target:blueprintId ?? courseId,scope,idempotencyKey,recoveryGeneration:current},input,current,now(),receiptId => {
        const references = selectReferences(tx,courseId,input.references),draft = blueprintId ? readDraft(tx,courseId,blueprintId) : undefined;
        if ('expectedRevision' in input && draft?.revision !== input.expectedRevision) throw new ApiError('VERSION_CONFLICT');
        const sampleReferenceIds = 'sampleReferenceIds' in input ? input.sampleReferenceIds : [];
        if (new Set(sampleReferenceIds).size !== sampleReferenceIds.length
          || sampleReferenceIds.some(ref => !references.some(item => item.id === ref))) throw new ApiError('INVALID_REFERENCE');
        const requestData:StoredTeacherRequest = {jobId:randomUUID(),courseId,actorId:actor.userId,blueprintId:blueprintId ?? null,baseRevision:draft?.revision ?? 0,
          mode:trial ? 'rubric_trial' : 'generationMode' in input ? input.generationMode : 'mode' in input ? input.mode : 'rubric_trial',
          request:input.request,references,allowedFields:trial ? ['rubricCriteria'] : 'allowedFields' in input ? input.allowedFields : knownFields,
          sampleReferenceIds,baseline:draft?.content ?? null,versions:versionsFor(actor.userId,courseId)};
        if (new Set(requestData.allowedFields).size !== requestData.allowedFields.length) throw new ApiError('INVALID_REQUEST');
        if (!budget(tx,requestData,[])) throw new ApiError('BUDGET_EXHAUSTED');
        const acceptedAtMs = now();
        const job:Job = {jobId:requestData.jobId,kind:requestData.mode,purpose:'teacher_design',scope,
          requestReceiptId:receiptId,status:'queued',stopRequested:false,expectedRevision:requestData.baseRevision,decisionEpoch:0,recoveryGeneration:current,
          acceptedAt:timeString(acceptedAtMs),deadline:timeString(acceptedAtMs+45000),attemptCount:0};
        created = {request:requestData,job}; return {jobId:job.jobId,status:'queued' as const};
      },value => acceptedSchema.parse(value));
      if (created) { enqueueStoredJob(tx,created.job); saveTeacherRequest(tx,created.request); }
      const work = original(tx,receipt.result.jobId); requireActor(work,actor);
      if (work.job.requestReceiptId !== receipt.receiptId) throw new Error('Invalid original request receipt.');
      generation(current); return receipt;
    });
    return {requestId:request.id,data};
  }
  app.post('/api/blueprints/:id/proposals',request => {
    const blueprintId = parseRequest(params,request.params).id;
    return enqueue(request,tx => draftCourse(tx,blueprintId),request.body,blueprintId);
  });
  app.post('/api/blueprints/:id/rubric-trials',request => {
    const blueprintId = parseRequest(params,request.params).id;
    return enqueue(request,tx => draftCourse(tx,blueprintId),request.body,blueprintId,true);
  });
  function assertPatch(tx:Transaction,actor:{userId:string;courseId:string},blueprintId:string,expectedRevision:number,proposalId:string,patch:unknown) {
    const proposal = readProposal(tx,proposalId),work = original(tx,proposal.jobId); requireActor(work,actor);
    if (proposal.blueprintId !== blueprintId || proposal.courseId !== actor.courseId) throw new ApiError('FORBIDDEN');
    if (proposal.baseRevision !== expectedRevision || readDraft(tx,actor.courseId,blueprintId).revision !== expectedRevision) throw new ApiError('VERSION_CONFLICT');
    if (!applicable(tx,work.input,work.job)) throw new ApiError('STATE_CONFLICT');
    const changes = parseRequest(contentPatchSchema,patch);
    if (Object.keys(changes).some(field => !work.input.allowedFields.includes(field))) throw new ApiError('INVALID_REQUEST');
  }

  function readAuthorized<T>(request:FastifyRequest,jobId:string,work:(tx:Transaction,input:ReturnType<typeof original>) => T,write=false) {
    return access.withAuthorizedCourse(request,tx => loadTeacherRequest(tx,jobId).input.courseId,'teacher',(tx,actor) => {
      const item = original(tx,jobId); requireActor(item,actor); return work(tx,item);
    },write);
  }
  function applicable(tx:Transaction,input:StoredTeacherRequest,job:Job) {
    return !job.stopRequested && job.status === 'succeeded' && teacherContextCurrent(tx,input,versionsFor(input.actorId,input.courseId));
  }
  function readJobRequest(request:FastifyRequest) { return {requestId:request.id,data:readAuthorized(request,parseRequest(params,request.params).id,(tx,work) => {
    const proposal = proposalForJob(tx,work.job.jobId);
    return {jobId:work.job.jobId,status:work.job.status,stopRequested:work.job.stopRequested,
      acceptedAt:work.job.acceptedAt,deadline:work.job.deadline,attemptCount:work.job.attemptCount,
      usages:work.usages,...(work.job.failure ? {failure:work.job.failure} : {}),
      ...(proposal ? {proposalId:proposal.proposalId,resultHash:proposal.resultHash} : {})};
  })}; }
  function cancelJobRequest(request:FastifyRequest) {
    const jobId = parseRequest(params,request.params).id,input = parseRequest(generationInput,request.body),
      idempotencyKey = parseRequest(key,request.headers['idempotency-key']);
    const data = readAuthorized(request,jobId,(tx,work) => {
      const current = generation(input.recoveryGeneration);
      return finishRecordCommand(tx,{actorId:work.input.actorId,command:'teacher-design.cancel',target:jobId,scope:work.job.scope,
        idempotencyKey,recoveryGeneration:current},input,current,now(),() => {
        const next = cancelJob(work.job); saveJob(tx,next); return {jobId,status:next.status,attemptCount:next.attemptCount};
      },value => progressSchema.parse(value));
    },true);
    if (data.result.jobId === jobId) inFlight.get(jobId)?.abort();
    return {requestId:request.id,data};
  }
  if (registerJobRoutes) {
    app.get('/api/jobs/:id',readJobRequest);
    app.post('/api/jobs/:id/cancel',cancelJobRequest);
  }
  app.get('/api/design-proposals/:id',request => {
    const proposalId = parseRequest(params,request.params).id;
    const data = access.withAuthorizedCourse(request,tx => readProposal(tx,proposalId).courseId,'teacher',(tx,actor) => {
      const proposal = readProposal(tx,proposalId),work = original(tx,proposal.jobId); requireActor(work,actor);
      return {...proposal,applicable:applicable(tx,work.input,work.job)};
    },false);
    return {requestId:request.id,data};
  });
  app.post('/api/design-proposals/:id/adopt',request => {
    const proposalId = parseRequest(params,request.params).id,input = parseRequest(adoptProposalSchema,request.body),
      idempotencyKey = parseRequest(key,request.headers['idempotency-key']);
    const data = access.withAuthorizedCourse(request,tx => readProposal(tx,proposalId).courseId,'teacher',(tx,actor) => {
      const proposal = readProposal(tx,proposalId),work = original(tx,proposal.jobId); requireActor(work,actor);
      const current = generation(input.recoveryGeneration);
      const receipt = finishRecordCommand(tx,{actorId:actor.userId,command:'teacher-design.adopt',target:proposalId,scope:work.job.scope,
        idempotencyKey,recoveryGeneration:current},input,current,now(),() => {
        if (proposal.blueprintId || !applicable(tx,work.input,work.job)) throw new ApiError('STATE_CONFLICT');
        const body = proposal.body;
        const selected = body.kind === 'candidates' ? body.candidates[input.candidateIndex ?? -1] : body.kind === 'blueprint' ? body : undefined;
        if (!selected || (body.kind !== 'candidates' && input.candidateIndex !== undefined)) throw new ApiError('INVALID_REQUEST');
        const refs = body.kind === 'candidates' ? body.candidates[input.candidateIndex!]!.resourceRefs : body.kind === 'blueprint' ? body.resources : [];
        const resources = work.input.references.filter(ref => refs.includes(ref.id)).map(ref => ref.resourceVersionId);
        return createStoredDraft(tx,actor,{mode:'manual',content:{...simpleContent(selected,resources),...input.content}},now());
      },value => resultSchema.parse(value));
      generation(current); return receipt;
    });
    return {requestId:request.id,data};
  });
  function validateBody(work:ReturnType<typeof original>,raw:unknown) {
    const body = parseRequest(teacherBodySchema,raw),input = work.input;
    if (body.kind !== input.mode) throw new ApiError('INVALID_REQUEST');
    const refs = body.kind === 'candidates' ? body.candidates.flatMap(c => c.resourceRefs)
      : body.kind === 'blueprint' ? body.resources : body.kind === 'patch' ? body.resourceRefs : body.sampleRefs;
    if (refs.some(ref => !input.references.some(item => item.id === ref))
      || (body.kind === 'rubric_trial' && refs.some(ref => !input.sampleReferenceIds.includes(ref)))) throw new ApiError('INVALID_REFERENCE');
    if (body.kind === 'patch') {
      const fields = body.changes.map(change => change.field);
      if (new Set(fields).size !== fields.length || fields.some(field => !input.allowedFields.includes(field))) throw new ApiError('INVALID_REQUEST');
      const patch = parseRequest(contentPatchSchema,Object.fromEntries(body.changes.map(change => [change.field,change.value])));
      if (patch.resources?.some(ref => !input.references.some(item => item.resourceVersionId === ref.resourceVersionId))) throw new ApiError('INVALID_REFERENCE');
    }
    return body;
  }
  function receiveResult(delivery:TeacherResultDelivery) {
    return persisted(tx => {
      generation(delivery.recoveryGeneration);
      const work = original(tx,delivery.jobId),{job,input} = work;
      if (delivery.outcome.outcome === 'success') {
        if (typeof delivery.bodyJson !== 'string') throw new ApiError('INVALID_REFERENCE');
        let rawBody:unknown;
        try { rawBody = JSON.parse(delivery.bodyJson); } catch { throw new ApiError('INVALID_REFERENCE'); }
        const parsed = parseRequest(teacherBodySchema,rawBody);
        if (canonical(parsed) !== canonical(delivery.outcome.body)) throw new ApiError('INVALID_REFERENCE');
      }
      if (delivery.outcome.outcome === 'success') {
        validateBody(work,delivery.outcome.body);
        const existing = proposalForJob(tx,job.jobId);
        if (existing) {
          const member = tx.get("SELECT user_id FROM course_memberships WHERE user_id=? AND course_id=? AND role='teacher' AND active=1",input.actorId,input.courseId);
          const user = tx.get('SELECT disabled_at_ms FROM users WHERE id=?',input.actorId);
          if (!member || !user || user.disabled_at_ms !== null) throw new ApiError('FORBIDDEN');
          if (existing.resultHash !== hashResultBytes(delivery.bodyJson!)) throw new ApiError('IDEMPOTENCY_CONFLICT');
          return {proposalId:existing.proposalId,resultHash:existing.resultHash};
        }
      }
      if (job.status === 'cancelled' && job.stopRequested && delivery.outcome.outcome !== 'success') return undefined;
      if (job.leaseToken !== delivery.leaseToken || job.status !== 'running' || job.stopRequested) throw new ApiError('STATE_CONFLICT');
      if (Date.parse(job.deadline) <= now()) { progress(tx,work,{...job,status:'timed_out',failure:'deadline'}); return undefined; }
      if (!job.leaseUntil || Date.parse(job.leaseUntil) <= now()) throw new ApiError('STATE_CONFLICT');
      if (!teacherContextCurrent(tx,input,versionsFor(input.actorId,input.courseId))) { progress(tx,work,{...job,status:'stale',failure:'stale_context'}); return undefined; }
      const outcome = delivery.outcome;
      if (outcome.outcome !== 'success') {
        const status = outcome.outcome === 'cancelled' ? 'cancelled' : outcome.outcome === 'timed_out' ? 'timed_out' : outcome.outcome === 'stale' ? 'stale' : 'failed';
        progress(tx,work,{...job,status,failure:outcome.code}); return undefined;
      }
      if (canonical(outcome.versions) !== canonical(input.versions)) throw new ApiError('INVALID_REFERENCE');
      const body = validateBody(work,outcome.body),resultHash = hashResultBytes(delivery.bodyJson!),proposalId = randomUUID(),rawResultRef = 'teacher-result:'+job.jobId;
      const before = input.baseline as Record<string,unknown>|null;
      const diff = body.kind === 'patch'
        ? body.changes.map(change => ({path:change.field,before:before?.[change.field] ?? null,after:change.value}))
        : body.kind === 'candidates'
          ? body.candidates.flatMap((item,index) => Object.entries(item).map(([field,value]) => ({
            path:'candidates.'+index+'.'+field,before:null,after:value,
          })))
          : Object.entries(body).filter(([field]) => field !== 'kind').map(([field,value]) => ({
            path:['problem','audience','artifact','routes'].includes(field) ? field : 'suggestions.'+field,
            before:before?.[field] ?? null,after:value,
          }));

      const proposal:DesignProposal = {proposalId,jobId:job.jobId,courseId:input.courseId,blueprintId:input.blueprintId,baseRevision:input.baseRevision,
        body,resultHash,rawResultRef,
        modelResult:{calls:outcome.calls,elapsedMs:outcome.elapsedMs,usage:outcome.usage,versions:outcome.versions},
        diff:diff as DesignProposal['diff'],
        rationale:body.kind === 'patch' ? body.rationale : '',affectedReferences:body.kind === 'patch' ? [...body.resourceRefs,...body.affectedLinks]
          : body.kind === 'rubric_trial' ? body.sampleRefs : body.kind === 'blueprint' ? [...body.resources,...body.goalEvidenceLinks] : body.candidates.flatMap(item => item.resourceRefs),
        createdAt:timeString(now())};
      const next = finishJob(job,{leaseToken:delivery.leaseToken,generation:delivery.recoveryGeneration,now:timeString(now()),resultRef:rawResultRef,resultHash},
        {expectedRevision:input.blueprintId ? readDraft(tx,input.courseId,input.blueprintId).revision : 0,decisionEpoch:0});
      finishRecordCommand(tx,{actorId:input.actorId,command:'teacher-design.result',target:job.jobId,scope:job.scope,
        idempotencyKey:job.jobId,recoveryGeneration:job.recoveryGeneration},{resultHash},job.recoveryGeneration,now(),() => {
        saveJob(tx,next); saveProposal(tx,proposal,delivery.bodyJson!); return {proposalId,resultHash};
      },value => z.strictObject({proposalId:id,resultHash:z.string().length(64)}).parse(value));
      generation(delivery.recoveryGeneration); return {proposalId,resultHash};
    });
  }
  async function processJob(jobId:string) {
    if(inFlight.has(jobId)){
      persisted(tx=>{const work=original(tx,jobId),recovered=recoverJob(work.job,timeString(now()));
        if(recovered.status!==work.job.status)progress(tx,work,recovered);});
      return undefined;
    }
    const controller=new AbortController();inFlight.set(jobId,controller);
    const queuedAt=now();
    const execute=async(signal:AbortSignal)=>{
      const claimed = persisted(tx => {
        const work = original(tx,jobId),{input,job} = work;
        if (job.status === 'running') {
          const recovered = recoverJob(job,timeString(now()));
          if (recovered.status !== job.status) progress(tx,work,recovered); return undefined;
        }
        if (job.status !== 'queued') return undefined;
        if (!teacherContextCurrent(tx,input,versionsFor(input.actorId,input.courseId))) { progress(tx,work,{...job,status:'stale',failure:'stale_context'}); return undefined; }
        // Only the new model-budget wait is excluded from the existing 45-second round.
        const admittedAt=now(),deadline=config.modelBudget?timeString(Date.parse(job.deadline)+Math.max(0,admittedAt-queuedAt)):job.deadline;
        const next = claimJob({...job,deadline},randomUUID(),deadline,job.recoveryGeneration,timeString(admittedAt)); progress(tx,work,next);
        return next.status === 'running' ? {...work,job:next} : undefined;
      });
      if (!claimed) return undefined;
      const {input,job} = claimed;
      const checkCurrent = () => persisted(tx => {
        const work = original(tx,jobId);
        if (work.job.stopRequested || work.job.status === 'cancelled') return 'cancelled' as const;
        return work.job.leaseToken === job.leaseToken && work.job.status === 'running'
          && teacherContextCurrent(tx,work.input,versionsFor(work.input.actorId,work.input.courseId)) ? 'current' as const : 'stale' as const;
      });
      let budgetDenied = false;
      // The approved personal model is bound to the accepted request; a configuration change since then is refused
      // by the resolver instead of silently dispatching the new model.
      const resolveProvider = () => config.providerForTeacher
        ? config.providerForTeacher({actorId:input.actorId,courseId:input.courseId,modelConfig:input.versions.modelConfig})
        : config.provider;
      const provider:ModelProvider = {generate:async request => {
        const callIndex = persisted(tx => {
          const work = original(tx,jobId);
          if (!teacherContextCurrent(tx,work.input,versionsFor(work.input.actorId,work.input.courseId))) throw new ApiError('STATE_CONFLICT');
          if (!budget(tx,work.input,work.usages)) { budgetDenied = true; throw new ApiError('BUDGET_EXHAUSTED'); }
          const next = recordModelCall(work.job,job.leaseToken!,job.recoveryGeneration,timeString(now()));
          progress(tx,work,next,() => saveUsages(tx,jobId,[...work.usages,{status:'unknown'}])); return next.attemptCount-1;
        });
        let response;
        try {
          const selected=resolveProvider();
          response = await (config.modelBudget?budgetedProvider(selected,config.modelBudget):selected).generate(request);
        }
        catch (error) {
          if (error instanceof InputLimitError||error instanceof ProviderCallNotStartedError&&error.reservation==='none') {
            persisted(tx => {
              const work = original(tx,jobId);
              // Only this provider's proven unsent, last reservation may be released.
              // A lost lease/slot intentionally replaces InputLimitError with STATE_CONFLICT.
              if (work.job.leaseToken !== job.leaseToken || work.job.attemptCount !== callIndex+1
                || work.usages[callIndex]?.status !== 'unknown') throw new ApiError('STATE_CONFLICT');
              progress(tx,work,{...work.job,attemptCount:callIndex},() => saveUsages(tx,jobId,work.usages.slice(0,callIndex)));
            });
            if(error instanceof ProviderCallNotStartedError)throw error.withReservation('released');
          }
          throw error;
        }
        if (response.usage) persisted(tx => {
          const work = original(tx,jobId);
          if (work.job.leaseToken !== job.leaseToken || callIndex >= work.usages.length) throw new ApiError('STATE_CONFLICT');
          const usages = [...work.usages]; usages[callIndex] = response.usage!;
          progress(tx,work,work.job,() => saveUsages(tx,jobId,usages));
        });
        return response;
      }};
      let outcome = await generateTeacherProposal({
        context:{jobId,purpose:'teacher_design',scope:{courseId:input.courseId,userId:input.actorId},
          authorizedReferenceIds:input.references.map(ref => ref.id),acceptedAtMs:config.modelBudget?Date.parse(job.deadline)-45000:Date.parse(job.acceptedAt),deadlineAtMs:Date.parse(job.deadline),
          budgetAvailable:persisted(tx => budget(tx,input,claimed.usages)),versions:input.versions},mode:input.mode,
        request:JSON.stringify({teacherRequest:input.request,blueprint:input.baseline,allowedFields:input.allowedFields,sampleReferenceIds:input.sampleReferenceIds}),
        signal,
        references:input.references.map(ref => ({id:ref.id,content:ref.content})),blueprintId:input.blueprintId,baseRevision:input.baseRevision,
      },{provider,checkCurrent,now,callVerdictWindowMs:CALL_VERDICT_WINDOW_MS});
      if (budgetDenied) outcome = {outcome:'budget_exhausted',code:'BUDGET_EXHAUSTED',retryable:false,calls:outcome.calls,usage:outcome.usage};
      if (outcome.outcome === 'success') {
        try { persisted(tx => validateBody(original(tx,jobId),outcome.outcome === 'success' ? outcome.body : null)); }
        catch (error) {
          if (!(error instanceof ApiError) || !['INVALID_REQUEST','INVALID_REFERENCE'].includes(error.code)) throw error;
          outcome = {outcome:'rejected',code:error.code,retryable:false,calls:outcome.calls,usage:outcome.usage};
        }
      }
      const delivery:TeacherResultDelivery = {jobId,leaseToken:job.leaseToken!,recoveryGeneration:job.recoveryGeneration,outcome,...(outcome.outcome === 'success' ? {bodyJson:JSON.stringify(outcome.body)} : {})};
      try { const result = receiveResult(delivery); return {delivery,result}; }
      catch (error) {
        if (error instanceof ApiError && error.code === 'PERSISTENCE_UNAVAILABLE') throw new TeacherResultCommitError(delivery);
        throw error;
      }
    };
    try {
      if(!config.modelBudget)return await execute(controller.signal);
      const initial=persisted(tx=>original(tx,jobId));
      return await config.modelBudget.run({memberId:initial.input.actorId,
        payloadBytes:Buffer.byteLength(JSON.stringify(initial.input)),signal:controller.signal},execute);
    } catch(error) {
      if(!(error instanceof ModelQueueError))throw error;
      persisted(tx=>{
        const work=original(tx,jobId),job=work.job;
        if(job.status!=='queued'||job.stopRequested||job.attemptCount!==0)return;
        progress(tx,work,{...job,status:error.code==='MODEL_QUEUE_CANCELLED'?'cancelled':error.code==='MODEL_QUEUE_TIMEOUT'?'timed_out':'failed',failure:error.code});
      });
      return undefined;
    } finally {inFlight.delete(jobId);}
  }
  return {enqueue,processJob,receiveResult,assertPatch,readJob:readJobRequest,cancelJob:cancelJobRequest};
}

import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { TutoringAppOptions } from '../tutoring/application.ts';
import { createPersonalAgentService } from '../personal-agent/service.ts';
import { createCompatibleTransport, compatibleTutoringProvider, requirePersonalSelection } from '../tutoring/openai-compatible.ts';
import {PERSONAL_MODEL_IDLE_MS} from '../personal-agent/inactivity.ts';
import {readStudentTasks} from '../personal-agent/student-tasks.ts';
import type {SyntheticDatabase, Transaction} from '../db/transaction.ts';
import {readJobs} from '../db/records-adapter.ts';
import type {ModelSelection, PersonalAgentService, CompatibleTransport} from '../personal-agent/types.ts';
import type {TrustedModelContext} from '../../contracts/tutoring/index.ts';
import type {TeacherAgentOptions} from '../design/teacher-agent.ts';
import {budgetedTransport,createModelBudget,type ModelBudget} from '../personal-agent/model-budget.ts';

export type PersonalModelsOptions={directory:string;callsEnabled?:boolean;transport?:CompatibleTransport;modelBudget?:ModelBudget};
export function personalModels(options:PersonalModelsOptions,authorize:(request:FastifyRequest)=>string,
  original:TutoringAppOptions['studentHelp'],db:SyntheticDatabase) {
  const modelBudget=options.modelBudget??createModelBudget();
  const transport=budgetedTransport(options.transport??createCompatibleTransport(),modelBudget);
  const service=createPersonalAgentService({directory:options.directory,authorize,transport,modelBudget,callsEnabled:()=>options.callsEnabled!==false,
    readStudentTasks:userId=>readStudentTasks(db,userId)});
  const studentHelp:TutoringAppOptions['studentHelp']={...original,
    modelBudget,
    requestLimits:{inactivityTimeoutMs:PERSONAL_MODEL_IDLE_MS,maximumCalls:1},
    modelConfigRevisionForStudent:studentId=>service.configurationRevision(studentId),
    budgetAvailable:scope=>Boolean(service.selection(scope.studentId,false)),
    versionsForStudent:studentId=>({...original.versions,modelConfig:service.selection(studentId,false)?.version??'personal-unconfigured'}),
    providerForStudent:(studentId,version)=>compatibleTutoringProvider(requirePersonalSelection(service.selection(studentId),version),transport),
  };
  return {...service,studentHelp,transport,modelBudget};
}

const persistedUsageList = z.array(z.discriminatedUnion('status', [
  z.strictObject({status: z.literal('unknown')}),
  z.strictObject({status: z.literal('actual'), inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative()}),
])).max(3);

export type TeacherDesignApprovalValues = {
  allowedTeacherIds: readonly string[]; allowedCourseIds: readonly string[];
  maximumCallsPerRequest: number; maximumCallsPerRound: number;
  maximumOutputTokens: number; roundStartsAtMs: number;
};

/**
 * Calls this teacher already reserved or consumed inside the approved round, read from the original
 * `teacher_design_requests` rows (no new table, no in-memory counter). An `unknown` reservation counts as
 * consumed: a call that was sent but not confirmed must not return quota.
 */
export function teacherDesignRoundCalls(tx:Transaction,actorId:string,courseId:string,roundStartsAtMs:number) {
  const acceptedAt = new Map(readJobs(tx,courseId).map(job => [job.jobId,Date.parse(job.acceptedAt)]));
  let calls = 0;
  for (const row of tx.all('SELECT job_id,usage_json FROM teacher_design_requests WHERE actor_id=? AND course_id=?',actorId,courseId)) {
    const at = acceptedAt.get(String(row.job_id));
    if (at === undefined || !Number.isFinite(at) || at < roundStartsAtMs) continue;
    const usages = persistedUsageList.safeParse(JSON.parse(String(row.usage_json)));
    if (!usages.success) throw new Error('Invalid persisted teacher design usage.');
    calls += usages.data.length;
  }
  return calls;
}

/**
 * Teacher-design model calls reuse the teacher's own personal model, gated by an independent, default-off
 * approval. A dispatch happens only when all of these hold: personal calls are enabled, the teacher and course
 * are approved, the per-request and per-round call limits still have room, a personal selection exists, and its
 * configured output ceiling stays within the approved one.
 */
export function teacherDesignAgentOptions(options:{service:PersonalAgentService;transport:CompatibleTransport;
  approval:TeacherDesignApprovalValues;personalCallsEnabled:()=>boolean}):
  Pick<TeacherAgentOptions,'providerForTeacher'|'versionsForTeacher'|'budgetAvailableInTransaction'|'modelBudget'> {
  const {service,transport,approval,personalCallsEnabled} = options;
  return {
    ...(service.modelBudget?{modelBudget:service.modelBudget}:{}),
    providerForTeacher:({actorId,modelConfig}) =>
      compatibleTutoringProvider(requirePersonalSelection(service.selection(actorId),modelConfig),transport),
    versionsForTeacher:({actorId}) => ({
      modelConfig:service.selection(actorId,false)?.version ?? 'personal-unconfigured',
      prompt:'teacher-design-v1',schema:'teacher-design-v1',policy:'teacher-design-v1',
    } satisfies TrustedModelContext['versions']),
    budgetAvailableInTransaction:(tx,{actorId,courseId,usages}) => {
      if (!personalCallsEnabled()) return false;
      if (!approval.allowedTeacherIds.includes(actorId) || !approval.allowedCourseIds.includes(courseId)) return false;
      if (usages.length >= approval.maximumCallsPerRequest) return false;
      const selection:ModelSelection|undefined = service.selection(actorId,false);
      if (!selection) return false;
      if ((selection.maxOutputTokens ?? 4096) > approval.maximumOutputTokens) return false;
      return teacherDesignRoundCalls(tx,actorId,courseId,approval.roundStartsAtMs) < approval.maximumCallsPerRound;
    },
  };
}

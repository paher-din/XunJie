import type { FastifyRequest } from 'fastify';
import type { TutoringAppOptions } from '../tutoring/application.ts';
import { createPersonalAgentService } from '../personal-agent/service.ts';
import { createCompatibleTransport, compatibleTutoringProvider, requirePersonalSelection } from '../tutoring/openai-compatible.ts';
import {PERSONAL_MODEL_IDLE_MS} from '../personal-agent/inactivity.ts';
import {readStudentTasks} from '../personal-agent/student-tasks.ts';
import type {SyntheticDatabase} from '../db/transaction.ts';

export type PersonalModelsOptions={directory:string;callsEnabled?:boolean};
export function personalModels(options:PersonalModelsOptions,authorize:(request:FastifyRequest)=>string,
  original:TutoringAppOptions['studentHelp'],db:SyntheticDatabase) {
  const transport=createCompatibleTransport();
  const service=createPersonalAgentService({directory:options.directory,authorize,transport,callsEnabled:()=>options.callsEnabled!==false,
    readStudentTasks:userId=>readStudentTasks(db,userId)});
  const studentHelp:TutoringAppOptions['studentHelp']={...original,
    requestLimits:{inactivityTimeoutMs:PERSONAL_MODEL_IDLE_MS,maximumCalls:1},
    modelConfigRevisionForStudent:studentId=>service.configurationRevision(studentId),
    budgetAvailable:scope=>Boolean(service.selection(scope.studentId)),
    versionsForStudent:studentId=>({...original.versions,modelConfig:service.selection(studentId)?.version??'personal-unconfigured'}),
    providerForStudent:(studentId,version)=>compatibleTutoringProvider(requirePersonalSelection(service.selection(studentId),version),transport),
  };
  return {...service,studentHelp};
}

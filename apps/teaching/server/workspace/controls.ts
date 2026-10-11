import {RunnerError} from '../../runner/snapshot.ts';
import type {Attempt,ObjectRef} from '../../contracts/workspace/index.ts';
import type {Purpose} from '../../contracts/records/index.ts';
import {onlyFields} from '../records/commands.ts';

export type Control = {kind:'start'|'pause'|'resume'}|{kind:'capture'|'reminders';value:boolean}
  |{kind:'position';route?:string;question?:string;returnPosition?:ObjectRef};
export function controlAttempt(attempt:Attempt,expectedRevision:number,control:Control,assignmentActive:boolean) {
  if(expectedRevision!==attempt.attemptRevision)throw new RunnerError('VERSION_CONFLICT','Attempt version conflict');
  onlyFields(control,control.kind==='position'?['kind','route','question','returnPosition']:
    ['capture','reminders'].includes(control.kind)?['kind','value']:['kind']);
  const next=structuredClone(attempt);let cancelPurposes:Purpose[]=[];let changed=false;
  if(control.kind==='start'||control.kind==='resume'||control.kind==='pause') {
    if(!assignmentActive&&control.kind!=='pause')throw new RunnerError('STATE_CONFLICT','Assignment pause cannot be overridden');
    const before=control.kind==='start'?'ready':control.kind==='resume'?'paused':'active';
    if(attempt.status!==before)throw new RunnerError('STATE_CONFLICT','Invalid attempt transition');
    next.status=control.kind==='pause'?'paused':'active';changed=true;
    if(control.kind==='pause'){
      next.decisionEpoch++;cancelPurposes=['student_help','reminder','explicit_analysis','passive_analysis','student_run'];
    }
  } else if(control.kind==='capture'||control.kind==='reminders') {
    if(typeof control.value!=='boolean')throw new RunnerError('INVALID_REQUEST','Boolean control required');
    const key=control.kind==='capture'?'collecting':'reminders';changed=next[key]!==control.value;
    if(changed){next[key]=control.value;
      if(control.kind==='capture'){next.captureRevision++;if(!control.value)cancelPurposes=['passive_analysis'];}
      else if(!control.value)cancelPurposes=['reminder'];
    }
  } else if(control.kind==='position') {
    if(!['ready','active','paused'].includes(attempt.status))throw new RunnerError('STATE_CONFLICT','Attempt position is read-only');
    for(const key of ['route','question'] as const)if(control[key]!==undefined&&typeof control[key]!=='string')throw new RunnerError('INVALID_REQUEST','Text position required');
    if(control.returnPosition&&control.returnPosition.attemptId!==attempt.attemptId)throw new RunnerError('INVALID_REFERENCE','Return position scope mismatch');
    for(const key of ['route','question','returnPosition'] as const)if(control[key]!==undefined&&JSON.stringify(control[key])!==JSON.stringify(next[key])){
      Object.assign(next,{[key]:structuredClone(control[key])});changed=true;
    }
    if(changed&&assignmentActive&&attempt.status==='ready')next.status='active';
  } else throw new RunnerError('INVALID_REQUEST','Unsupported control');
  if(changed)next.attemptRevision++;
  return {attempt:next,cancelPurposes,captureChanged:control.kind==='capture'&&changed};
}

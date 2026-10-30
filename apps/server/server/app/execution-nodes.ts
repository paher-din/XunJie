import type {FastifyRequest} from 'fastify';
import type {ExecutionBinding,Job} from '../../contracts/records/index.ts';
import type {RunnerTransport} from '../records/runner.ts';
import type {HdlTransport} from '../workspace/hdl.ts';
import type {Transaction} from '../db/transaction.ts';
import {readJobs} from '../db/records-adapter.ts';
import {ApiError} from './errors.ts';

export type ExecutionNode={nodeId:string;label:string;recoveryGeneration:string;runner:RunnerTransport;hdlTransport:HdlTransport};
// Endpoint/key configuration stays server-side. A browser selects only a registered ID.
export function executionNodes(nodes:ExecutionNode[],legacyNodeId?:string){
 const entries=new Map<string,ExecutionNode>();
 for(const node of nodes){
  if(!/^[A-Za-z0-9_-]{1,64}$/.test(node.nodeId)||!node.label||!node.recoveryGeneration||entries.has(node.nodeId))throw new ApiError('INVALID_CONFIGURATION');
  entries.set(node.nodeId,{...node,runner:async packet=>{
   if(packet.op!=='readiness'&&(packet.op==='editor_diagnostics'?packet.packet.recoveryGeneration:(packet.op==='submit'?packet.submission.identity:packet.identity).recoveryGeneration)!==node.recoveryGeneration)throw new ApiError('RECOVERY_REQUIRED');
   const response=await node.runner(packet);
   if(packet.op!=='readiness'&&packet.op!=='editor_diagnostics'&&response&&typeof response==='object'&&'data' in response){
    const data=response.data;
    if(data&&typeof data==='object'&&'identity' in data){
     const identity=data.identity;
     if(!identity||typeof identity!=='object'||!('recoveryGeneration' in identity)||identity.recoveryGeneration!==node.recoveryGeneration)throw new ApiError('RECOVERY_REQUIRED');
    }
   }
   return response;
  }});
 }
 // An empty list is an explicit deployment without execution nodes: construction and readiness succeed,
 // and every real dispatch still fails closed (RUNTIME_NOT_READY / RECOVERY_REQUIRED / DEPENDENCY_UNAVAILABLE).
 if(legacyNodeId&&!entries.has(legacyNodeId))throw new ApiError('INVALID_CONFIGURATION');
 function node(binding:ExecutionBinding){const value=entries.get(binding.nodeId);if(!value||value.recoveryGeneration!==binding.nodeGeneration)throw new ApiError('RECOVERY_REQUIRED');return value;}
 function selected(request:FastifyRequest):ExecutionBinding{
  const id=request.headers['x-xunjie-execution-node'];
  if(typeof id!=='string'||!entries.has(id))throw new ApiError('RUNTIME_NOT_READY');
  return {nodeId:id,nodeGeneration:entries.get(id)!.recoveryGeneration};
 }
 function forJob(job:Job):ExecutionBinding{
  if(job.execution){node(job.execution);return job.execution;}
  // An old job can only return to an explicitly registered original node with the original generation.
  const legacy=legacyNodeId?entries.get(legacyNodeId):undefined;
  if(!legacy||legacy.recoveryGeneration!==job.recoveryGeneration)throw new ApiError('DEPENDENCY_UNAVAILABLE');
  return {nodeId:legacy.nodeId,nodeGeneration:legacy.recoveryGeneration};
 }
 function forHdl(tx:Transaction,id:string):ExecutionBinding{
  const row=tx.get(`SELECT j.course_id,j.job_id FROM jobs j WHERE j.job_id IN (
   SELECT job_id FROM hdl_builds WHERE build_id=? UNION SELECT job_id FROM hdl_operations WHERE operation_id=?
   UNION SELECT job_id FROM hdl_operations WHERE session_id=? AND sequence=0) LIMIT 1`,id,id,id);
  if(!row)throw new ApiError('INVALID_REFERENCE');
  return forJob(readJobs(tx,String(row.course_id)).find(job=>job.jobId===row.job_id)!);
 }
 return {nodes:[...entries.values()],node,selected,forJob,forHdl};
}
export type ExecutionRouting=ReturnType<typeof executionNodes>;

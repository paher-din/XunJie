import {createHash} from 'node:crypto';
import {hdlConfigurationSchema,hdlActivityRuntimeSchema,type HdlConfiguration} from '../../contracts/design/hdl.ts';
import {runtimeReadinessSchema} from '../../contracts/design/inputs.ts';
import type {Transaction} from '../db/transaction.ts';
import type {ActorContext} from '../../contracts/access/index.ts';
import type {HdlTransport} from '../workspace/hdl.ts';
import {canonical} from '../records/commands.ts';
import {ApiError} from '../app/errors.ts';
import {z} from 'zod';
export const configurationHash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value),'utf8').digest('hex');
export const hdlRule={versionId:'hdl-board-structure-v1' as const,validatorVersion:'hdl-board-structure-v1' as const,limitedHelp:false as const,description:'Fixed configuration structure only; ALU behavior unverified.'};
export function storeHdlConfiguration(tx:Transaction,actor:ActorContext,input:unknown,approved:HdlConfiguration['runtime'][],now:number){
 if(actor.role!=='teacher'||!tx.get("SELECT user_id FROM course_memberships WHERE course_id=? AND user_id=? AND role='teacher' AND active=1",actor.courseId,actor.userId))throw new ApiError('FORBIDDEN');
 const config=hdlConfigurationSchema.parse(input);
 if(!approved.some(runtime=>canonical(runtime)===canonical(config.runtime)))throw new ApiError('INVALID_CONFIGURATION');
 const body=JSON.stringify(config),hash=configurationHash(config),old=tx.get('SELECT * FROM digital_logic_config_versions WHERE id=?',config.versionId);
 if(old){if(old.course_id!==actor.courseId)throw new ApiError('FORBIDDEN');if(old.config_json!==body||old.content_hash!==hash)throw new ApiError('IDEMPOTENCY_CONFLICT');}
 else tx.run('INSERT INTO digital_logic_config_versions(id,course_id,created_by,created_at_ms,config_json,content_hash) VALUES (?,?,?,?,?,?)',config.versionId,actor.courseId,actor.userId,now,body,hash);
 return {configuration:config,contentHash:hash};
}
export function readHdlConfiguration(tx:Transaction,courseId:string,id:string){
 const row=tx.get('SELECT * FROM digital_logic_config_versions WHERE id=? AND course_id=?',id,courseId);if(!row)throw new ApiError('INVALID_REFERENCE');
 const configuration=hdlConfigurationSchema.parse(JSON.parse(String(row.config_json)));
 if(configuration.versionId!==row.id||configurationHash(configuration)!==row.content_hash)throw new ApiError('INVALID_REFERENCE');
 return {configuration,contentHash:String(row.content_hash)};
}
export function fixedHdlRuntime(tx:Transaction,courseId:string,id:string){const fixed=readHdlConfiguration(tx,courseId,id);return hdlActivityRuntimeSchema.parse({kind:'hdl_board',runtimeProfileVersion:fixed.configuration.runtime.runtimeProfileVersion,...fixed});}
const evidence=z.object({data:z.object({ready:z.literal(true),profile:hdlConfigurationSchema.shape.runtime,recoveryGeneration:z.string().min(1),fingerprint:z.record(z.string(),z.unknown()),fingerprintHash:z.string(),validation:z.object({passed:z.literal(true),fingerprintHash:z.string(),validatedAt:z.iso.datetime()})})});
export async function availableHdlRuntime(transport:HdlTransport,approved:HdlConfiguration['runtime'][]){
 const parsed=evidence.safeParse(await transport({op:'hdl_readiness'}));if(!parsed.success)throw new ApiError('RUNTIME_NOT_READY');
 const data=parsed.data.data,hash=configurationHash(data.fingerprint),checkedAt=new Date().toISOString();
 if(hash!==data.fingerprintHash||hash!==data.validation.fingerprintHash||data.profile.sourceHash!==data.fingerprint.sourceHash
  ||canonical(data.profile)!==canonical(data.fingerprint.profile)||!approved.some(runtime=>canonical(runtime)===canonical(data.profile))
  ||Date.parse(data.validation.validatedAt)>Date.parse(checkedAt))throw new ApiError('INVALID_REFERENCE');
 return {profile:data.profile,recoveryGeneration:data.recoveryGeneration,readiness:runtimeReadinessSchema.parse({fingerprintHash:hash,sourceHash:data.profile.sourceHash,validatedAt:data.validation.validatedAt,checkedAt})};
}

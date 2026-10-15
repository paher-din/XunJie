import {z} from 'zod';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {createDigitalLogicApplicationDatabase} from '../db/transaction.ts';
import {createPasswordRecord} from '../access/password.ts';
import {storePolicy,storeRule} from '../design/activities.ts';
import {availableHdlRuntime} from '../design/hdl-configurations.ts';
import {availableRuntime} from '../design/readiness.ts';
import {hdlRuntimeSchema} from '../../contracts/design/hdl.ts';
import {readControlledJson,sshConfigurationSchema} from './config.ts';
import {executionTransports} from './execution-transport.ts';
import type {HdlTransport} from '../workspace/hdl.ts';
import type {RunnerTransport} from '../records/runner.ts';
import {displayTextSchema} from '../../contracts/access/index.ts';
const syntheticId=z.string().regex(/^synthetic-[A-Za-z0-9_-]{1,100}$/);
export const syntheticManifestSchema=z.strictObject({synthetic:z.literal(true),recoveryGeneration:z.string().min(1).max(128),
 accounts:z.array(z.strictObject({id:syntheticId,loginName:syntheticId,password:z.string().min(16).max(1024),displayName:displayTextSchema.optional()})).min(2).max(20),
 courses:z.array(z.union([syntheticId,z.strictObject({id:syntheticId,name:displayTextSchema.optional()})])).min(2).max(10),
 memberships:z.array(z.strictObject({courseId:syntheticId,userId:syntheticId,role:z.enum(['teacher','student'])})).min(4).max(100)}).superRefine((input,ctx)=>{
 const courses=input.courses.map(course=>typeof course==='string'?course:course.id);
 if(new Set(input.accounts.map(account=>account.id)).size!==input.accounts.length||new Set(input.accounts.map(account=>account.loginName)).size!==input.accounts.length||new Set(courses).size!==courses.length)ctx.addIssue({code:'custom',message:'Duplicate synthetic identity.'});
 const memberships=new Set<string>();for(const member of input.memberships){const key=JSON.stringify([member.courseId,member.userId]);if(memberships.has(key)||!courses.includes(member.courseId)||!input.accounts.some(account=>account.id===member.userId))ctx.addIssue({code:'custom',message:'Invalid synthetic membership.'});memberships.add(key);}
 for(const course of courses)for(const role of ['teacher','student'])if(!input.memberships.some(member=>member.courseId===course&&member.role===role))ctx.addIssue({code:'custom',message:'Each synthetic course requires both roles.'});
});
export async function initializeSyntheticApplication(input:unknown,transport:{runner:RunnerTransport;hdlTransport:HdlTransport},approved:z.infer<typeof hdlRuntimeSchema>[]){
 const manifest=syntheticManifestSchema.parse(input),runtimes=approved.map(value=>hdlRuntimeSchema.parse(value));
 const hdl=await availableHdlRuntime(transport.hdlTransport,runtimes),c=await availableRuntime(transport.runner);
 if(!c||hdl.recoveryGeneration!==manifest.recoveryGeneration||c.recoveryGeneration!==manifest.recoveryGeneration)throw new Error('Approved current execution generation required.');
 const accounts:Array<{id:string;loginName:string;displayName?:string;record:Awaited<ReturnType<typeof createPasswordRecord>>}>=[];
 for(const account of manifest.accounts)accounts.push({id:account.id,loginName:account.loginName,...(account.displayName?{displayName:account.displayName}:{}),record:await createPasswordRecord(account.password)});
 const courses=manifest.courses.map(course=>typeof course==='string'?{id:course}:course);
 const db=createDigitalLogicApplicationDatabase();
 try{db.withTransaction(tx=>{
  for(const account of accounts)tx.run('INSERT INTO users(id,login_name,password_hash,salt,algorithm,n,r,p,key_length,display_name) VALUES (?,?,?,?,?,?,?,?,?,?)',account.id,account.loginName,account.record.hash,account.record.salt,'scrypt',131072,8,1,64,account.displayName??null);
  for(const course of courses)tx.run('INSERT INTO courses(id,name) VALUES (?,?)',course.id,'name' in course?course.name??null:null);
  for(const member of manifest.memberships)tx.run('INSERT INTO course_memberships(course_id,user_id,role,active) VALUES (?,?,?,1)',member.courseId,member.userId,member.role);
  for(const course of courses){const userId=manifest.memberships.find(member=>member.courseId===course.id&&member.role==='teacher')!.userId,actor={userId,courseId:course.id,role:'teacher' as const};
   storePolicy(tx,actor,{versionId:course.id+'-help',helpAllowed:true,wholeSolutionAllowed:false,limitedCheckHelpAllowed:false,description:'Synthetic learning help policy'},Date.now());
   storeRule(tx,actor,{versionId:'textscope-core-v1',validatorVersion:'textscope-validator-v2',limitedHelp:true,description:'Original TextScope core checks'},Date.now());
  }
  tx.run('INSERT INTO application_control(singleton,recovery_generation,control_revision,initialized_at_ms) VALUES (1,?,1,?)',manifest.recoveryGeneration,Date.now());
 });return db;}catch(error){db.close();throw error;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{const config=z.strictObject({ssh:sshConfigurationSchema,approvedHdlRuntimes:z.array(hdlRuntimeSchema).min(1),manifest:syntheticManifestSchema}).parse(readControlledJson(process.argv[2]??''));
 const db=await initializeSyntheticApplication(config.manifest,executionTransports(config.ssh),config.approvedHdlRuntimes);process.stdout.write(JSON.stringify({databaseFile:db.file})+'\n');db.close();
 }catch{process.stderr.write('Synthetic initialization failed. Check explicit synthetic input and current authorized execution readiness.\n');process.exitCode=1;}
}

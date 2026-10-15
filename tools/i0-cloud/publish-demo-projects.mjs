import {createHash,randomUUID} from 'node:crypto';
import {existsSync,lstatSync,readFileSync,realpathSync,renameSync,writeFileSync} from 'node:fs';
import {request as httpsRequest} from 'node:https';
import {dirname,isAbsolute,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {verifyCompletionReceipt} from '../i0-hdl/seed-local-courses.mjs';

const marker='xunjie-cloud-demo-publication-v1';
const hash=value=>createHash('sha256').update(value).digest('hex');
function requireValue(value,code){if(!value)throw Object.assign(new Error(code),{code});}
const id=value=>typeof value==='string'&&value.length>0&&value.length<=128;
function privateJson(file){
 requireValue(isAbsolute(file),'ABSOLUTE_PRIVATE_FILE_REQUIRED');
 const stat=lstatSync(file);
 requireValue(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=4*1024*1024&&(process.platform==='win32'||(stat.mode&0o077)===0),'PRIVATE_FILE_REQUIRED');
 return JSON.parse(readFileSync(file,'utf8'));
}
export function validatePublicationPlan(value){
 requireValue(value?.marker==='xunjie-demo-development-v1'&&value.version===1&&id(value.identities?.teacherId)&&id(value.identities?.studentId)
  &&id(value.source?.recoveryGeneration)&&Array.isArray(value.publicationPlan)&&value.publicationPlan.length>0,'PREPARED_PUBLICATION_PLAN_REQUIRED');
 requireValue(value.identities.teacherId!==value.identities.studentId,'DISTINCT_DEMO_ROLES_REQUIRED');
 const courses=new Set();
 for(const item of value.publicationPlan){
  requireValue(['textscope','hdl_board'].includes(item.kind)&&[item.courseId,item.sourceCourseId,item.sourceActivityVersionId,item.policyVersionId,item.checkRuleVersionId].every(id)
   &&typeof item.projectTitle==='string'&&item.projectTitle.trim()&&item.courseId!==item.sourceCourseId&&!courses.has(item.courseId),'INVALID_PUBLICATION_PROJECT');
  requireValue(Array.isArray(item.studentIds)&&item.studentIds.length===4&&item.studentIds.every(id)&&new Set(item.studentIds).size===4
   &&item.studentIds.includes(value.identities.studentId)&&!item.studentIds.includes(value.identities.teacherId),'MAIN_AND_THREE_VIRTUAL_STUDENTS_REQUIRED');
  courses.add(item.courseId);
 }
 return value;
}
export function dryPlan(plan){
 return {marker,mode:'plan',credentialsRead:false,networkRequests:0,writesPerformed:false,projects:plan?.publicationPlan.length??null,
  kinds:plan?.publicationPlan.map(item=>item.kind)??['textscope','hdl_board'],
  prerequisites:['Prepared private plan with course memberships and course-local help policy/check rule versions',
   'Private teacher/student credentials, explicit node ID, original CA and business generation',
   'Teacher API access to the fixed source activities and public materials; verified execution readiness'],
  chain:['teacher login','copy public learning materials','register copied fixed HDL configuration when applicable','manual blueprint','checks','confirmed release','assign main student and three virtual students','main student read-only bootstrap'],
  excluded:['No SQL writes or migration','No model calls','No attempt, source file, run, score or learning record creation']};
}
/** Copy only a fixed public teaching projection; no mutable draft or private answer is imported. */
export function copiedBlueprint(source,item,resourceIds,hdlConfigurationVersionId){
 requireValue(source?.courseId===item.sourceCourseId&&source.activityVersionId===item.sourceActivityVersionId&&source.content?.audience==='student'
  &&Boolean(source.execution)===(item.kind==='hdl_board'),'SOURCE_ACTIVITY_SCOPE_MISMATCH');
 return {...structuredClone(source.content.content),projectTitle:item.projectTitle,resources:resourceIds.map(resourceVersionId=>({resourceVersionId})),
  helpPolicyVersionId:item.policyVersionId,checkRuleVersionId:item.checkRuleVersionId,runtimeProfileVersionId:source.runtimeProfileVersionId,
  ...(hdlConfigurationVersionId?{digitalLogicConfigVersionId:hdlConfigurationVersionId}:{})};
}
function parseArgs(args){
 const options={apply:false};
 for(let index=0;index<args.length;index++){
  if(args[index]==='--apply')options.apply=true;
  else if(args[index]==='--plan')options.apply=false;
  else if(args[index]==='--help')options.help=true;
  else if(args[index]==='--spec'&&args[index+1])options.spec=args[++index];
  else throw Object.assign(new Error('INVALID_ARGUMENT'),{code:'INVALID_ARGUMENT'});
 }
 requireValue(!options.apply||options.spec,'APPLY_SPEC_REQUIRED');return options;
}
function loadSpec(file){
 const spec=privateJson(resolve(file));
 requireValue(['publicationPlanFile','credentialFile','caFile','checkpointFile','teachingRoot'].every(key=>typeof spec[key]==='string'&&isAbsolute(spec[key])),'ABSOLUTE_SPEC_PATHS_REQUIRED');
 const origin=new URL(spec.origin);
 requireValue(origin.protocol==='https:'&&origin.origin===spec.origin&&!origin.username&&!origin.password&&id(spec.executionNodeId),'STRICT_ORIGIN_AND_NODE_REQUIRED');
 requireValue(spec.connectPort===undefined||Number.isInteger(spec.connectPort)&&spec.connectPort>=1&&spec.connectPort<=65535,'INVALID_CONNECT_PORT');
 return {spec,plan:validatePublicationPlan(privateJson(spec.publicationPlanFile))};
}
function checkpointFile(file,context){
 const directory=lstatSync(dirname(file));
 requireValue(directory.isDirectory()&&!directory.isSymbolicLink()&&(process.platform==='win32'||(directory.mode&0o077)===0),'PRIVATE_CHECKPOINT_DIRECTORY_REQUIRED');
 const checkpoint=existsSync(file)?privateJson(file):{marker,context,commands:{},projects:[],status:'prepared'};
 requireValue(checkpoint.marker===marker&&JSON.stringify(checkpoint.context)===JSON.stringify(context)&&checkpoint.commands&&Array.isArray(checkpoint.projects),'CHECKPOINT_SCOPE_MISMATCH');
 const save=()=>{
  if(existsSync(file))requireValue(lstatSync(file).isFile()&&!lstatSync(file).isSymbolicLink(),'CHECKPOINT_FILE_CHANGED');
  const temporary=file+'.'+randomUUID()+'.tmp';
  writeFileSync(temporary,JSON.stringify(checkpoint,null,2)+'\n',{mode:0o600,flag:'wx'});renameSync(temporary,file);
 };
 save();return {checkpoint,save};
}
export async function applyPublication(spec,plan){
 requireValue(process.version==='v24.21.0','NODE_24_21_REQUIRED');
 requireValue(spec.connectPort===undefined||Number.isInteger(spec.connectPort)&&spec.connectPort>=1&&spec.connectPort<=65535,'INVALID_CONNECT_PORT');
 const load=relative=>import(pathToFileURL(resolve(spec.teachingRoot,relative)).href);
 const [contracts,hdlContracts,records,adapter]=await Promise.all([
  load('contracts/design/index.ts'),load('contracts/design/hdl.ts'),load('server/records/commands.ts'),load('server/db/records-adapter.ts'),
 ]);
 const canonical=records.canonical,generation=plan.source.recoveryGeneration;
 const {checkpoint,save}=checkpointFile(spec.checkpointFile,{planHash:hash(canonical(plan)),origin:spec.origin,
  connectPort:spec.connectPort??Number(new URL(spec.origin).port||443),nodeId:spec.executionNodeId,generation});
 const credentialDocument=privateJson(spec.credentialFile),accounts=credentialDocument.accounts??[credentialDocument.teacher,credentialDocument.student].filter(Boolean);
 requireValue(Array.isArray(accounts),'CREDENTIAL_ACCOUNTS_REQUIRED');
 const accountFor=userId=>{
  const matches=accounts.filter(account=>(account.id??account.userId)===userId);
  requireValue(matches.length===1&&id(matches[0].loginName)&&typeof matches[0].password==='string'&&matches[0].password.length>0,'ROLE_CREDENTIAL_REQUIRED');return matches[0];
 };
 const caStat=lstatSync(spec.caFile);
 requireValue(caStat.isFile()&&!caStat.isSymbolicLink()&&caStat.size<1024*1024,'CA_FILE_REQUIRED');
 const ca=readFileSync(spec.caFile,'utf8');requireValue(ca.includes('-----BEGIN CERTIFICATE-----')&&!ca.includes('PRIVATE KEY'),'PUBLIC_CA_CERTIFICATE_REQUIRED');
 const sessions=[];
 async function http(method,path,payload,session,key){
  requireValue(path.startsWith('/api/')||path==='/health/ready','CONTROLLED_API_PATH_REQUIRED');
  const wire=payload===undefined?undefined:JSON.stringify(payload);
  return new Promise((resolveResponse,reject)=>{
   const request=httpsRequest(new URL(path,spec.origin),{method,ca,rejectUnauthorized:true,...(spec.connectPort===undefined?{}:{port:spec.connectPort}),
    headers:{host:new URL(spec.origin).host,origin:spec.origin,'x-xunjie-execution-node':spec.executionNodeId,
    ...(session?{cookie:session.cookie,'x-csrf-token':session.csrf}:{}),...(key?{'idempotency-key':key}:{}),
    ...(wire===undefined?{}:{'content-type':'application/json','content-length':Buffer.byteLength(wire)})}},response=>{
    let text='';const strictTls=response.socket.authorized===true;response.setEncoding('utf8');
    response.on('data',chunk=>{text+=chunk;if(Buffer.byteLength(text)>4*1024*1024)request.destroy(new Error('RESPONSE_LIMIT'));});
    response.on('end',()=>{try{
     requireValue(strictTls,'STRICT_TLS_REQUIRED');const body=JSON.parse(text);
     requireValue(response.statusCode===200,/^[A-Z0-9_]{1,64}$/.test(body.error?.code??'')?body.error.code:'HTTP_REJECTED');
     resolveResponse({data:body.data,headers:response.headers});
    }catch(error){reject(error);}});
    response.on('error',()=>reject(Object.assign(new Error('RESPONSE_FAILED'),{code:'RESPONSE_FAILED'})));
   });
   request.setTimeout(30000,()=>request.destroy(Object.assign(new Error('HTTPS_TIMEOUT'),{code:'HTTPS_TIMEOUT'})));
   request.on('error',()=>reject(Object.assign(new Error('HTTPS_REQUEST_FAILED'),{code:'HTTPS_REQUEST_FAILED'})));request.end(wire);
  });
 }
 async function login(userId){
  const account=accountFor(userId),response=await http('POST','/api/sessions',{loginName:account.loginName,password:account.password});
  const cookie=response.headers['set-cookie']?.map(item=>item.split(';',1)[0]).join('; '),csrf=response.data?.csrfToken;
  requireValue(cookie&&typeof csrf==='string'&&csrf,'SESSION_REQUIRED');
  const session={cookie,csrf,userId};sessions.push(session);
  requireValue((await http('GET','/api/session',undefined,session)).data?.userId===userId,'SESSION_ROLE_MISMATCH');return session;
 }
 async function post(label,path,fields,session,operation,validate){
  const payload={recoveryGeneration:generation,...fields},payloadHash=hash(canonical(payload));let command=checkpoint.commands[label];
  if(command)requireValue(command.path===path&&command.payloadHash===payloadHash&&canonical(command.payload)===canonical(payload),'ORIGINAL_PAYLOAD_CHANGED');
  else{command={path,payload,payloadHash,idempotencyKey:randomUUID(),status:'prepared'};checkpoint.commands[label]=command;save();}
  // This private durable copy is saved before dispatch, including after a timeout or lost ACK.
  const response=await http('POST',command.path,command.payload,session,command.idempotencyKey);
  const expected={actorId:session.userId,command:operation.command,target:operation.target,scope:{courseId:operation.courseId},idempotencyKey:command.idempotencyKey,recoveryGeneration:generation};
  const receipt=verifyCompletionReceipt(response.data,expected,payload,{canonical,requestHash:records.requestHash,readCommandIdentity:adapter.readCommandIdentity},validate);
  if(command.receipt)requireValue(canonical(command.receipt)===canonical(receipt),'ORIGINAL_RECEIPT_CHANGED');
  command.receipt=receipt;command.status='acknowledged';save();return receipt.result;
 }
 try{
  requireValue((await http('GET','/health/ready')).data?.status==='ready','APPLICATION_NOT_READY');
  const teacher=await login(plan.identities.teacherId),student=await login(plan.identities.studentId);
  const teacherCourses=(await http('GET','/api/courses',undefined,teacher)).data,studentCourses=(await http('GET','/api/courses',undefined,student)).data;
  for(const item of plan.publicationPlan){
   requireValue([item.courseId,item.sourceCourseId].every(courseId=>teacherCourses.some(course=>course.courseId===courseId&&course.role==='teacher'))
    &&studentCourses.some(course=>course.courseId===item.courseId&&course.role==='student'),'COURSE_MEMBERSHIP_REQUIRED');
  }
  const nodes=(await http('GET','/api/execution-nodes',undefined,teacher)).data?.nodes,node=nodes?.find(item=>item.nodeId===spec.executionNodeId);
  requireValue(node&&plan.publicationPlan.every(item=>item.kind==='hdl_board'?node.hdlReady:node.cReady),'SELECTED_NODE_NOT_READY');
  checkpoint.status='publishing';save();
  for(const item of plan.publicationPlan){
   const course=item.courseId,source=contracts.activityViewSchema.parse((await http('GET',`/api/activities/${encodeURIComponent(item.sourceActivityVersionId)}?audience=student`,undefined,teacher)).data);
   requireValue(source.status==='active'&&source.courseId===item.sourceCourseId,'ACTIVE_SOURCE_ACTIVITY_REQUIRED');
   requireValue(!source.content.materials.some(material=>material.status==='unavailable'),'SOURCE_MATERIAL_UNAVAILABLE');
   const publicIds=source.content.materials.filter(material=>material.status==='available').map(material=>material.resourceVersionId),resources=[];
   for(const resourceId of publicIds){
    const resource=contracts.resourceSchema.parse((await http('GET',`/api/resources/${encodeURIComponent(resourceId)}`,undefined,teacher)).data),material=resource.material;
    requireValue(resource.courseId===item.sourceCourseId&&material.kind==='learning_material'&&material.visibility.student,'SOURCE_RESOURCE_SCOPE_MISMATCH');
    const created=await post(`${course}:material:${resourceId}`,`/api/courses/${encodeURIComponent(course)}/resources`,{teacherDesignAllowed:resource.teacherDesignAllowed,
     material:{format:material.format,title:material.title,content:material.text,kind:'learning_material',visibility:material.visibility}},teacher,{command:'material.create',target:course,courseId:course},value=>contracts.resultSchema.parse(value));
    requireValue(created.kind==='material'&&created.resourceVersion.courseId===course&&created.resourceVersion.material.kind==='learning_material'
     &&created.resourceVersion.material.text===material.text&&canonical(created.resourceVersion.material.visibility)===canonical(material.visibility),'COPIED_MATERIAL_MISMATCH');
    resources.push(created.resourceVersion.resourceVersionId);
   }
   let hdlVersion;
   if(item.kind==='hdl_board'){
    requireValue(source.execution?.kind==='hdl_board','HDL_TEMPLATE_REQUIRED');
    hdlVersion='demo-hdl-'+hash(course).slice(0,24);
    const configuration=hdlContracts.hdlConfigurationSchema.parse({...source.execution.configuration,versionId:hdlVersion});
    await post(`${course}:configuration`,`/api/courses/${encodeURIComponent(course)}/hdl-configurations`,{configuration},teacher,{command:'hdl.configuration',target:course,courseId:course},value=>{
     requireValue(canonical(value?.configuration)===canonical(configuration)&&value.contentHash===hash(JSON.stringify(configuration)),'HDL_CONFIGURATION_MISMATCH');return value;
    });
   }
   const content=contracts.contentPatchSchema.parse(copiedBlueprint(source,item,resources,hdlVersion));
   const draft=await post(`${course}:draft`,`/api/courses/${encodeURIComponent(course)}/blueprints`,{mode:'manual',content},teacher,{command:'draft.create',target:course,courseId:course},value=>contracts.resultSchema.parse(value));
   requireValue(draft.kind==='draft'&&draft.draft.courseId===course,'DRAFT_SCOPE_MISMATCH');const blueprintId=draft.draft.blueprintId,revision=draft.draft.revision;
   const checks=await post(`${course}:checks`,`/api/blueprints/${encodeURIComponent(blueprintId)}/checks`,{expectedRevision:revision,concerns:[]},teacher,{command:'draft.checks',target:blueprintId,courseId:course},value=>contracts.resultSchema.parse(value));
   requireValue(checks.kind==='checks'&&checks.report.blocking.length===0&&!checks.report.designConcerns.some(concern=>concern.status==='requires_teacher'),'PROJECT_CHECKS_BLOCKED');
   if(item.kind==='hdl_board')requireValue(checks.report.execution?.kind==='hdl_board'&&checks.report.execution.structural==='validated'&&checks.report.execution.behavior==='unverified','HDL_STRUCTURE_ONLY_REQUIRED');
   const release=await post(`${course}:release`,`/api/blueprints/${encodeURIComponent(blueprintId)}/releases`,{expectedRevision:revision,confirmed:true,concerns:[]},teacher,{command:'activity.release',target:blueprintId,courseId:course},value=>contracts.activityCommandResults['activity.release'].parse(value));
   const assigned=await post(`${course}:assign`,`/api/activities/${encodeURIComponent(release.activityVersionId)}/assignments`,{studentIds:item.studentIds,expectedActivityControlRevision:release.activityControlRevision},teacher,{command:'assignment.create',target:release.activityVersionId,courseId:course},value=>contracts.activityCommandResults['assignment.create'].parse(value));
   requireValue(assigned.assignments.length===item.studentIds.length&&new Set(assigned.assignments.map(assignment=>assignment.studentId)).size===item.studentIds.length
    &&assigned.assignments.every(assignment=>item.studentIds.includes(assignment.studentId)&&assignment.activityVersionId===release.activityVersionId&&assignment.status==='active'),'ASSIGNMENT_SCOPE_MISMATCH');
   const mainAssignment=assigned.assignments.find(assignment=>assignment.studentId===plan.identities.studentId);
   const bootstrap=(await http('GET',`/api/assignments/${encodeURIComponent(mainAssignment.assignmentId)}/bootstrap`,undefined,student)).data;
   requireValue(bootstrap?.recoveryGeneration===generation&&bootstrap.assignment.assignmentId===mainAssignment.assignmentId&&bootstrap.assignment.studentId===plan.identities.studentId&&bootstrap.assignment.active,'MAIN_STUDENT_BOOTSTRAP_MISMATCH');
   checkpoint.projects=checkpoint.projects.filter(project=>project.courseId!==course).concat({courseId:course,sourceActivityVersionId:item.sourceActivityVersionId,blueprintId,activityVersionId:release.activityVersionId,assignments:assigned.assignments,studentBootstrap:'passed',attemptsCreated:0,runsCreated:0});save();
  }
  checkpoint.status='published';checkpoint.completedAt=new Date().toISOString();save();
  return {status:'published',projects:checkpoint.projects.length,assignments:checkpoint.projects.reduce((total,project)=>total+project.assignments.length,0),attemptsCreated:0,runsCreated:0,modelCalls:0};
 }catch(error){checkpoint.status='stopped';checkpoint.failure={code:/^[A-Z0-9_]{1,64}$/.test(error.code??'')?error.code:'PUBLICATION_FAILED',at:new Date().toISOString()};save();throw error;}
 finally{for(const session of sessions){try{await http('POST','/api/logout',{},session);}catch{}session.cookie='';session.csrf='';}for(const account of accounts)account.password='';}
}
if(process.argv[1]&&realpathSync(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const options=parseArgs(process.argv.slice(2));
  if(options.help)process.stdout.write('node publish-demo-projects.mjs [--spec /private/spec.json] [--plan | --apply]\nDefault plan reads no credentials, sends no requests and writes no files. Apply requires Node24.21.0 and private prepared plan, credentials, CA, checkpoint, teachingRoot, origin and explicit executionNodeId.\n');
  else{const input=options.spec?loadSpec(options.spec):undefined;process.stdout.write(JSON.stringify(options.apply?await applyPublication(input.spec,input.plan):dryPlan(input?.plan))+'\n');}
 }catch(error){process.stderr.write(JSON.stringify({status:'stopped',code:/^[A-Z0-9_]{1,64}$/.test(error.code??'')?error.code:'PUBLICATION_FAILED'})+'\n');process.exitCode=1;}
}

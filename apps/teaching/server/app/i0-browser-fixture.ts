/** Explicit isolated service verification; never imported by the normal startup. */
import { createInterface } from 'node:readline';
import { execFileSync } from 'node:child_process';
import { mkdtempSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { z } from 'zod';
import { fixture,assigned,command } from '../workspace/test-support.ts';
import { createPasswordRecord } from '../access/password.ts';
import { createI0App } from './i0.ts';
import type { ModelProvider } from '../tutoring/providers.ts';

const protocol=createInterface({input:process.stdin}),lines=protocol[Symbol.asyncIterator]();
const configuration=z.strictObject({synthetic:z.literal(true),port:z.number().int().min(1).max(65535),password:z.string().min(16).max(128)});
let close:(()=>Promise<void>)|undefined,certDirectory:string|undefined;
try {
  if(process.versions.node!=='24.21.0') throw new Error('Approved teaching runtime required');
  const first=await lines.next();
  if(first.done||first.value.length>1024) throw new Error('Synthetic IPC input required');
  const input=configuration.parse(JSON.parse(first.value));
  const f=await fixture(undefined,{teaching:true});
  close=()=>f.close();
  const teacher=await f.login('teacher'),allocation=await assigned(f,teacher);
  const other=await command(f,teacher,`/api/activities/${allocation.activityId}/assignments`,{
    expectedActivityControlRevision:1,studentIds:['other']});
  if(other.statusCode!==200)throw new Error('Synthetic second allocation unavailable');
  const otherAssignmentId=String(other.json().data.result.assignments[0].assignmentId);
  const password=await createPasswordRecord(input.password);
  f.db.withTransaction(tx=>tx.run("UPDATE users SET password_hash=?,salt=? WHERE id IN ('student','other')",password.hash,password.salt));
  certDirectory=mkdtempSync(join(tmpdir(),'xunjie-i0-browser-tls-'));
  const keyFile=join(certDirectory,'key.pem'),certFile=join(certDirectory,'cert.pem');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',keyFile,'-out',certFile,
    '-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1,DNS:localhost','-days','1'],{stdio:'ignore'});
  const base=`https://127.0.0.1:${input.port}`;
  const provider:ModelProvider={generate:async request=> {
    const refs=request.untrustedInput as {references:Array<{id:string}>};
    return {body:{kind:'student_help',actionType:'hint',content:'隔离合成服务验证：先写出一个边界输入，再自行检查。',
      rationale:'保留学生选择与验证。',expectedStudentAction:'请自行试验边界条件。',
      evidenceIds:[refs.references[0]!.id],resourceRefs:[],assistanceContext:'这是离线合成服务验证，未调用实际模型。',unresolved:[],
      policyChecks:{containsWholeSolution:false,writesStudentWork:false,runsCode:false,makesFormalEvaluation:false}}};
  }};
  const service=await createI0App({db:f.db,origin:base,signingSecret:f.signingSecret,currentGeneration:f.generation,
    https:{key:readFileSync(keyFile),cert:readFileSync(certFile)},staticDirectory:resolve('../student/dist'),consumerIntervalMs:50,
    tutoring:{studentHelp:{versions:{modelConfig:'deepseek-flash-v1',prompt:'student-help-v1',schema:'student-help-v1',policy:'help-v1'},
      budgetAvailable:()=>true},provider}});
  close=async()=>{await service.close();await f.close();};
  await service.app.listen({host:'127.0.0.1',port:input.port});service.startConsumer();
  // Public references only. Synthetic passwords are private IPC input, never output.
  process.stdout.write(JSON.stringify({synthetic:true,base,assignmentId:allocation.assignmentId,otherAssignmentId})+'\n');
  for await(const line of lines) if(line==='stop') break;
} catch {
  process.stderr.write('Isolated I0 browser service failed.\n');process.exitCode=1;
} finally {
  await close?.();protocol.close();
  if(certDirectory&&resolve(certDirectory).startsWith(join(resolve(tmpdir()),'xunjie-i0-browser-tls-')))
    rmSync(certDirectory,{recursive:true});
  // The original factory database is retained independently for audit; never deleted.
}

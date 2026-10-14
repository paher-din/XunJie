import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { initializeI0 } from '../../../../apps/teaching/server/app/i0-initialize.ts';
import { createI0App } from '../../../../apps/teaching/server/app/i0.ts';
import { storePolicy } from '../../../../apps/teaching/server/design/activities.ts';

const origin = 'https://synthetic.example';
const generation = 'synthetic-review-generation';
// Offline fixture values only. These are never issued to PAHER or used by a network listener.
const fixturePassword = 'OFFLINE_SYNTHETIC_TEST_ONLY_20261014';
const fixtureSigning = 'OFFLINE_SYNTHETIC_SIGNING_ONLY_20261014';
const ids = ['teacher-a','student-a','student-peer','teacher-b','student-b'].map(x=>'synthetic-i0-'+x);
const helpPolicy = versionId => ({versionId,helpAllowed:true,wholeSolutionAllowed:false,
  limitedCheckHelpAllowed:false,description:'Synthetic I0 scoped help; no whole solution and no help during limited checks.'});
const checkRule = {versionId:'textscope-core-v1',validatorVersion:'textscope-validator-v2',limitedHelp:true,
  description:'Synthetic TextScope Core trusted checks with limited help.'};
const configuration = {synthetic:true,users:ids.map(id=>({id,loginName:id,password:fixturePassword})),
  courses:[{id:'synthetic-i0-course-a',teacherId:ids[0],studentIds:[ids[1],ids[2]],helpPolicy:helpPolicy('help-v1'),checkRule},
    {id:'synthetic-i0-course-b',teacherId:ids[3],studentIds:[ids[4]],helpPolicy:helpPolicy('help-v1-course-b'),checkRule}]};
const cases=[];
let service, db;
async function run(name,fn) {
  try { await fn(); cases.push({name,status:'passed'}); }
  catch { cases.push({name,status:'failed'}); }
}
function expect(response,status,code) {
  assert.equal(response.statusCode,status);
  if(code) assert.equal(response.json().error.code,code);
}
const logged=new Map();
let publicResource,privateResource;
try {
  ({db}=await initializeI0(configuration));
  service=await createI0App({db,origin,signingSecret:fixtureSigning,currentGeneration:()=>generation});
  await run('fresh original 24-table database and five members in two courses',()=>{
    db.withTransaction(tx=>{
      assert.equal(tx.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").length,24);
      assert.equal(Number(tx.get('SELECT count(*) AS n FROM users').n),5);
      assert.equal(Number(tx.get('SELECT count(*) AS n FROM courses').n),2);
      assert.equal(Number(tx.get('SELECT count(*) AS n FROM course_memberships WHERE active=1').n),5);
    });
  });
  await run('distinct help policies and per-course identical rule version',()=>{
    db.withTransaction(tx=>{
      assert.deepEqual(tx.all('SELECT id,course_id FROM help_policy_versions ORDER BY course_id'),
        [{id:'help-v1',course_id:'synthetic-i0-course-a'},{id:'help-v1-course-b',course_id:'synthetic-i0-course-b'}]);
      const rows=tx.all('SELECT id,course_id FROM check_rule_versions ORDER BY course_id');
      assert.deepEqual(rows.map(r=>JSON.parse(r.id)),
        [['synthetic-i0-course-a','textscope-core-v1'],['synthetic-i0-course-b','textscope-core-v1']]);
    });
  });
  await run('foreign-course policy reuse rejected and transaction rolled back',()=>{
    let code;
    try {db.withTransaction(tx=>storePolicy(tx,{userId:ids[3],courseId:'synthetic-i0-course-b',role:'teacher'},helpPolicy('help-v1'),Date.now()));}
    catch(error){code=error.code;}
    assert.equal(code,'FORBIDDEN');
    assert.equal(Number(db.withTransaction(tx=>tx.get('SELECT count(*) AS n FROM help_policy_versions').n)),2);
  });
  for(const id of ids) await run('session derives membership: '+id,async()=>{
    const response=await service.app.inject({method:'POST',url:'/api/sessions',headers:{origin},payload:{loginName:id,password:fixturePassword}});
    expect(response,200);
    const cookie=response.cookies.filter(c=>c.value).map(c=>c.name+'='+encodeURIComponent(c.value)).join('; ');
    const headers={origin,cookie,'x-csrf-token':response.json().data.csrfToken};
    logged.set(id,headers);
    const session=await service.app.inject({url:'/api/session',headers:{cookie}});
    expect(session,200);
    const suffix=id.endsWith('-b')?'b':'a';
    const role=id.includes('teacher')?'teacher':'student';
    assert.equal(session.json().data.userId,id);
    assert.deepEqual(session.json().data.courses,[{courseId:'synthetic-i0-course-'+suffix,role}]);
  });
  await run('anonymous session read rejected',async()=>expect(await service.app.inject({url:'/api/session'}),401,'UNAUTHENTICATED'));
  await run('login role injection rejected by strict input',async()=>expect(await service.app.inject({method:'POST',url:'/api/sessions',
    headers:{origin},payload:{loginName:ids[1],password:fixturePassword,role:'teacher'}}),400,'INVALID_REQUEST'));
  await run('foreign Origin login rejected',async()=>expect(await service.app.inject({method:'POST',url:'/api/sessions',
    headers:{origin:'https://foreign.example'},payload:{loginName:ids[1],password:fixturePassword}}),403,'FORBIDDEN'));
  const payload=kind=>({recoveryGeneration:generation,teacherDesignAllowed:false,material:{
    format:'txt',title:'Synthetic review material',content:'Synthetic material for authorization verification only.',
    kind,visibility:{student:kind==='learning_material',tutor:kind==='learning_material'}}});
  const post=(id,kind,key,extra={})=>service.app.inject({method:'POST',url:'/api/courses/synthetic-i0-course-a/resources',
    headers:{...logged.get(id),'idempotency-key':key,...extra},payload:payload(kind)});
  await run('missing CSRF write rejected',async()=>{
    const {cookie}=logged.get(ids[0]);
    const response=await service.app.inject({method:'POST',url:'/api/courses/synthetic-i0-course-a/resources',
      headers:{origin,cookie,'idempotency-key':'missing-csrf'},payload:payload('learning_material')});
    expect(response,403,'FORBIDDEN');
  });
  await run('foreign-course teacher write rejected',async()=>expect(await post(ids[3],'learning_material','foreign-course'),403,'FORBIDDEN'));
  await run('student teacher-only write rejected',async()=>expect(await post(ids[1],'learning_material','student-write'),403,'FORBIDDEN'));
  await run('teacher public material creation through original HTTP transaction',async()=>{
    const response=await post(ids[0],'learning_material','public-material');expect(response,200);
    publicResource=response.json().data.result.resourceVersion.resourceVersionId;
    assert.equal(typeof publicResource,'string');
  });
  await run('teacher private material creation through original HTTP transaction',async()=>{
    const response=await post(ids[0],'private_answer','private-material');expect(response,200);
    privateResource=response.json().data.result.resourceVersion.resourceVersionId;
    assert.equal(typeof privateResource,'string');
  });
  await run('owner teacher can read private material',async()=>expect(await service.app.inject({url:'/api/resources/'+privateResource,headers:logged.get(ids[0])}),200));
  await run('student private material read rejected',async()=>expect(await service.app.inject({url:'/api/resources/'+privateResource,headers:logged.get(ids[1])}),403,'FORBIDDEN'));
  await run('foreign-course material read rejected',async()=>expect(await service.app.inject({url:'/api/resources/'+publicResource,headers:logged.get(ids[3])}),403,'FORBIDDEN'));
  await run('anonymous material read rejected',async()=>expect(await service.app.inject({url:'/api/resources/'+publicResource}),401,'UNAUTHENTICATED'));
  await run('revoked membership invalidates existing teacher session access',async()=>{
    db.withTransaction(tx=>tx.run('UPDATE course_memberships SET active=0 WHERE course_id=? AND user_id=?','synthetic-i0-course-a',ids[0]));
    expect(await service.app.inject({url:'/api/resources/'+privateResource,headers:logged.get(ids[0])}),403,'FORBIDDEN');
  });
} catch { cases.push({name:'original initializer and host construction',status:'failed'}); }
finally {
  if(service) await service.close();
  if(db) db.close();
}
const report={formatVersion:1,sourceCommit:'9fa76adbfb37a60cc087f8bf2fbdd1e05cd18e77',
  reviewedCCommit:'ea5a6523245ef25e2ab15712fa5aae5fc182deb8',performedAt:new Date().toISOString(),nodeVersion:process.version,
  scope:'Offline original initializer, Fastify public HTTP injection, real SQLite transactions; no TLS/network/runner/browser',
  database:db?{retained:true,directory:basename(new URL('file:///'+db.file.replaceAll('\\','/')).pathname.split('/').slice(0,-1).join('/')),tableCount:24,diagnostics:db.diagnostics}:null,
  counts:{total:cases.length,passed:cases.filter(x=>x.status==='passed').length,failed:cases.filter(x=>x.status==='failed').length,skipped:0},
  cases,notExecuted:['PAHER credential creation','normal HTTPS listener','original job consumption with real C1','browser trust and browser business acceptance']};
writeFileSync(new URL('./verification.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
process.exitCode=report.counts.failed?1:0;

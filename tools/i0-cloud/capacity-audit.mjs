// Server-side independent readback. Neither database is opened through a service initializer.
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {statSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
export function audit(input){
  if(!input.teachingRoot.startsWith('/opt/xunjie/candidates/133-')||input.databaseFile!=='/var/lib/xunjie/retained-tmp/xunjie-a12-completion-candidate129/synthetic.sqlite'
    ||input.actors.length!==4)throw new Error('CAPACITY_AUDIT_SCOPE_REQUIRED');
  const Driver=createRequire(join(input.teachingRoot,'package.json'))('better-sqlite3'),db=new Driver(input.databaseFile,{readonly:true,fileMustExist:true});db.pragma('query_only=ON');
  try{
    const actors=input.actors.map(actor=>{
      const files=db.prepare('SELECT file_json FROM workspace_files WHERE attempt_id=? AND lifecycle=?').all(actor.attemptId,'active').map(row=>JSON.parse(row.file_json));
      const file=files.find(row=>row.path==='capacity.c'),hash=file&&createHash('sha256').update(file.text).digest('hex');
      const submissions=db.prepare('SELECT COUNT(*) AS n FROM workspace_submissions WHERE attempt_id=?').get(actor.attemptId).n;
      const feedback=db.prepare('SELECT COUNT(*) AS n FROM teacher_feedback WHERE attempt_id=?').get(actor.attemptId).n;
      const saves=db.prepare('SELECT COUNT(*) AS n FROM command_receipts WHERE command=? AND target=?').get('shared.workspace.sync',`/api/attempts/${actor.attemptId}/sync`).n;
      return {actor:actor.actor,saves,submissions,feedback,documentVersion:file?.documentVersion,hash,
        baseSaves:actor.baseSaves??0,baseSubmissions:actor.baseSubmissions??0,baseFeedback:actor.baseFeedback??0,
        passed:file?.documentVersion===(actor.baseDocumentVersion??0)+actor.iterations&&hash===actor.finalHash
          &&saves===(actor.baseSaves??0)+actor.iterations&&submissions===(actor.baseSubmissions??0)+actor.submissions&&feedback===(actor.baseFeedback??0)+actor.feedback};
    });
    const integrity=db.pragma('integrity_check',{simple:true}),foreignKeyFailures=db.pragma('foreign_key_check').length;
    const model=new Driver('/var/lib/xunjie/capacity-133/personal-agent/personal-agent.sqlite',{readonly:true,fileMustExist:true});model.pragma('query_only=ON');
    let turns;
    try{turns=model.prepare('SELECT request_key,turn_json FROM agent_turns WHERE request_key LIKE ?').all(input.runId+'-%')
      .map(value=>({...JSON.parse(value.turn_json),group:value.request_key.includes('-deepseek-e2e-')||input.model==='deepseek-flash'?'deepseekProductE2E':'originalMimo'})).map(row=>({group:row.group,status:row.status,calls:row.callCount,usage:row.usage?.status==='actual'
        ?{status:'actual',inputTokens:row.usage.inputTokens,outputTokens:row.usage.outputTokens}:{status:'unknown'}}));}
    finally{model.close();}
    const databaseBytes=db.pragma('page_count',{simple:true})*db.pragma('page_size',{simple:true});
    let walBytes=0;try{walBytes=statSync(input.databaseFile+'-wal').size;}catch{}
    return {schema:'xunjie/capacity-db-audit-v1',sourceReadOnly:true,integrity,foreignKeyFailures,databaseBytes,walBytes,actors,realModelTurns:turns,
      businessPassed:actors.every(a=>a.passed)&&integrity==='ok'&&foreignKeyFailures===0,
      deepseekProductE2EPassed:turns.filter(t=>t.group==='deepseekProductE2E').length===2&&turns.filter(t=>t.group==='deepseekProductE2E').every(t=>t.calls===1&&t.status==='settled')};
  }finally{db.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{let text='';for await(const chunk of process.stdin){text+=chunk;if(text.length>16384)throw new Error('CAPACITY_INPUT_LIMIT');}
    process.stdout.write(JSON.stringify(audit(JSON.parse(text)))+'\n');}
  catch{process.stderr.write('CAPACITY_AUDIT_FAILED; no database row or credential output.\n');process.exitCode=1;}
}

// Two explicit product requests after a server-only reseal. Never persist account/session/model reply data.
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as pause} from 'node:timers/promises';
import {client,httpsTransport,check,CapacityFailure} from './capacity-workflow.mjs';
export async function productModelE2E(config){
  const root=config.evidenceDirectory,requestsFile=join(root,'deepseek-e2e-requests.jsonl'),receiptFile=join(root,'deepseek-e2e.json');
  writeFileSync(requestsFile,'',{flag:'wx',mode:0o600});const results=[],transports=[],startedAt=new Date().toISOString();
  const record=row=>appendFileSync(requestsFile,JSON.stringify(row)+'\n');
  const receipt=phase=>writeFileSync(receiptFile,JSON.stringify({phase,pid:process.pid,source:config.expectedSource,startedAt,
    updatedAt:new Date().toISOString(),model:'deepseek-flash',revision:2,contextWindow:8192,maxOutput:512,results},null,2)+'\n',{mode:0o600});
  receipt('running');
  try{
    const actors=JSON.parse(readFileSync(config.actorsFile,'utf8')).actors.filter(a=>a.label==='T'||a.label==='S1');check(actors.length===2,'CAPACITY_MODEL_SCOPE');
    await Promise.all(actors.map(async actor=>{
      const connection=JSON.parse(readFileSync(actor.connectionFile,'utf8')),transport=httpsTransport({port:config.ports[actor.label],caFile:connection.caFile,origin:connection.browserOrigin});transports.push(transport);
      const c=client({actor:actor.label,origin:connection.browserOrigin,transport,record});await c.login(JSON.parse(readFileSync(actor.accountFile,'utf8')));
      check((await c.get('/api/model-settings')).revision===2,'CAPACITY_MODEL_REVISION_MISMATCH');
      const at=new Date().toISOString(),begin=performance.now(),accepted=await c.post('/api/agent/turns',{},
        {conversationId:null,mode:'send',text:'Reply exactly OK, no explanation.',requestKey:config.runId+'-deepseek-e2e-'+actor.label,expectedModelConfigRevision:2});
      let turn;for(let n=0;n<300;n++){turn=await c.get('/api/agent/turns/:id',{id:accepted.turnId});if(['settled','failed','stopped'].includes(turn.message.phase))break;await pause(200);}
      results.push({actor:actor.label,turnId:accepted.turnId,startedAt:at,elapsedMs:performance.now()-begin,phase:turn.message.phase,
        success:turn.message.phase==='settled',exactOK:turn.message.text.trim()==='OK',...(turn.message.failure?{failureCode:turn.message.failure.code}:{})});receipt('running');
    }));
    receipt(results.every(row=>row.success)?'completed':'failed');return {success:results.every(row=>row.success),results};
  }finally{for(const transport of transports)transport.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{process.stdout.write(JSON.stringify(await productModelE2E(JSON.parse(readFileSync(resolve(process.argv[2]),'utf8'))))+'\n');}
  catch(error){process.stderr.write(JSON.stringify({code:error instanceof CapacityFailure?error.code:'CAPACITY_PRODUCT_E2E_FAILED'})+'\n');process.exitCode=1;}
}

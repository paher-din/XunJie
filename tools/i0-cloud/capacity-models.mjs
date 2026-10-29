// Run on the server only. Never initialize the source store or export plaintext credentials.
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

export async function prepareModels(input){
  if(process.platform!=='linux'||process.version!=='v24.21.0'||!input.teachingRoot.startsWith('/opt/xunjie/candidates/')
    ||input.targetRoot!=='/var/lib/xunjie/capacity-133'||input.userIds.length!==2||new Set(input.userIds).size!==2)
    throw new Error('CAPACITY_MODEL_SCOPE_INVALID');
  const receiptFile=join(input.targetRoot,'model-preparation.json');
  if(existsSync(receiptFile))return JSON.parse(readFileSync(receiptFile,'utf8'));
  const load=file=>import(pathToFileURL(join(input.teachingRoot,file)).href);
  const {credentialKey,openCredential,sealCredential}=await load('server/personal-agent/credentials.ts');
  const {openPersonalAgentStore}=await load('server/personal-agent/store.ts');
  const Driver=createRequire(join(input.teachingRoot,'package.json'))('better-sqlite3');
  const source=new Driver('/var/lib/xunjie/personal-agent/personal-agent.sqlite',{readonly:true,fileMustExist:true});
  source.pragma('query_only=ON');
  const sourceKey=credentialKey('/var/lib/xunjie/personal-agent/credentials.key',false);
  mkdirSync(input.targetRoot,{recursive:true,mode:0o700});
  const directory=join(input.targetRoot,'personal-agent'),target=openPersonalAgentStore(directory);
  try{
    const rows=source.prepare('SELECT user_id,revision,config_json FROM user_model_configs ORDER BY user_id').all();
    const sourceDigest=createHash('sha256').update(JSON.stringify(rows)).digest('hex');
    let selected;
    for(const row of rows){
      const c=JSON.parse(row.config_json);if(!c.enabled)continue;
      for(const provider of c.providers){for(const model of provider.models){
        if(model.id==='mimo-v2.6-flash'&&c.defaultModelId===`custom:${provider.id}:${model.id}`&&provider.credential)
          selected??={row,provider,model};
      }}
    }
    if(!selected)throw new Error('CAPACITY_APPROVED_MODEL_MISSING');
    for(const [index,userId]of input.userIds.entries()){
      const providerId=`capacity-133-${index+1}`,defaultModelId=`custom:${providerId}:${selected.model.id}`;
      let plaintext=openCredential(sourceKey,selected.row.user_id,selected.provider.id,selected.provider.credential);
      const credential=sealCredential(target.key,userId,providerId,plaintext);plaintext='';
      const value={enabled:true,defaultModelId,providers:[{id:providerId,name:'Isolated capacity provider',baseUrl:selected.provider.baseUrl,
        models:[{...selected.model,contextWindow:'8192',maxOutput:'512'}],credential}],
        efforts:selected.model.reasoningLevels.includes('low')?{[defaultModelId]:'low'}:{}};
      target.run('INSERT INTO user_model_configs(user_id,revision,config_json,updated_at) VALUES(?,1,?,?)',userId,JSON.stringify(value),new Date().toISOString());
    }
    const after=source.prepare('SELECT user_id,revision,config_json FROM user_model_configs ORDER BY user_id').all();
    if(createHash('sha256').update(JSON.stringify(after)).digest('hex')!==sourceDigest)throw new Error('CAPACITY_SOURCE_CHANGED');
    const config=JSON.parse(readFileSync('/var/lib/xunjie/candidate-129/application.json','utf8'));
    config.personalModels={directory,callsEnabled:true};
    const runtimeRoot=resolve(input.teachingRoot,'../..');
    if(!existsSync(join(runtimeRoot,'apps/web/dist/index.html')))throw new Error('CAPACITY_STATIC_ARTIFACT_MISSING');
    config.staticDirectory=join(runtimeRoot,'apps/web/dist');
    const configFile=join(input.targetRoot,'application.json');writeFileSync(configFile,JSON.stringify(config,null,2)+'\n',{flag:'wx',mode:0o600});
    const receipt={schema:'xunjie/capacity-model-preparation-v1',at:new Date().toISOString(),sourceReadOnly:true,
      sourceConfigurationDigest:sourceDigest,sourceServiceInitialized:false,sourceSettingsUnchanged:true,
      source:input.teachingRoot,targetDirectory:directory,keyFile:join(directory,'credentials.key'),configFile,
      targetAccounts:2,targetContextWindow:8192,targetMaxOutput:512,requestsSent:0};
    writeFileSync(receiptFile,JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});return receipt;
  }finally{target.close();source.close();sourceKey.fill(0);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{let text='';for await(const bytes of process.stdin){text+=bytes;if(text.length>16_384)throw new Error('CAPACITY_INPUT_LIMIT');}
    process.stdout.write(JSON.stringify(await prepareModels(JSON.parse(text)))+'\n');
  }catch{process.stderr.write('CAPACITY_MODEL_PREPARATION_FAILED; no credential diagnostics emitted.\n');process.exitCode=1;}
}

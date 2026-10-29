import type { createApp } from './app.ts';
import { readPort } from './app/config.ts';
import {dirname,join} from 'node:path';

let app:ReturnType<typeof createApp>|undefined;
let closeService:(()=>Promise<unknown>)|undefined;
let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  try { if (closeService) await closeService(); else await app?.close(); }
  catch { process.stderr.write('Teaching server shutdown failed.\n'); process.exitCode=1; }
};
try {
  const port=readPort(process.env.PORT);
  if(process.env.XUNJIE_I0_CONFIG!==undefined && process.env.XUNJIE_APP_CONFIG!==undefined)
    throw new Error('Exactly one controlled application mode is allowed.');
  if (process.env.XUNJIE_I0_CONFIG !== undefined) {
    // Keep the original health-only startup independent of SQLite/business initialization.
    const { readI0Config,readI0Generation,readI0SigningSecret }=await import('./app/config.ts');
    const { openSyntheticDatabase }=await import('./db/transaction.ts');
    const { readFileSync }=await import('node:fs');
    const { sshRunner }=await import('./records/runner.ts');
    const { createI0App }=await import('./app/i0.ts');
    const { ApiError }=await import('./app/errors.ts');
    const config=readI0Config(process.env.XUNJIE_I0_CONFIG);
    const originUrl=new URL(config.origin);
    if (Number(originUrl.port || 443)!==port)
      throw new Error('Exact local HTTPS origin required.');
    const db=openSyntheticDatabase(config.databaseFile);
    try {
      const generation=readI0Generation(config.generationFile);
      const transport=sshRunner(config.ssh);
      const runner:typeof transport=async command=>{
        const response=await transport(command);
        if (command.op==='readiness' && response && typeof response==='object' && 'data' in response) {
          const data=response.data;
          if (data && typeof data==='object' && 'recoveryGeneration' in data && data.recoveryGeneration!==generation)
            throw new ApiError('RECOVERY_REQUIRED');
        }
        return response;
      };
      const service=await createI0App({db,origin:config.origin,signingSecret:readI0SigningSecret(config.signingSecretFile),
        ...(config.allowedLoginUserIds?{allowedLoginUserIds:config.allowedLoginUserIds}:{}),
        https:{key:readFileSync(config.tls.keyFile),cert:readFileSync(config.tls.certFile)},
        currentGeneration:()=>generation,runner,staticDirectory:config.staticDirectory,
        consumerIntervalMs:config.consumerIntervalMs,logDestination:process.stdout,
        personalModels:config.personalModels??{directory:join(dirname(config.databaseFile),'personal-agent')},
        ...(config.tutoring?{tutoring:{
          studentHelp:{versions:config.tutoring.versions,budgetAvailable:()=>config.tutoring!.callsAuthorized},
          provider:config.tutoring.apiKeyFile?(await import('./tutoring/deepseek-sdk.ts')).createAiSdkDeepSeekProvider({
            apiKey:readI0SigningSecret(config.tutoring.apiKeyFile),
          }):{generate:async()=>{throw new Error('Tutoring provider unavailable');}},
        }}:{})});
      app=service.app;
      closeService=async()=>{try { await service.close(); } finally { db.close(); }};
      await app.listen({host:'127.0.0.1',port});
      service.startConsumer();
    } catch(error) { if (!closeService) db.close(); throw error; }
  } else if(process.env.XUNJIE_APP_CONFIG!==undefined) {
    const {readApplicationConfig,readI0SigningSecret}=await import('./app/config.ts');
    const {openSyntheticDatabase}=await import('./db/transaction.ts');
    const {readFileSync}=await import('node:fs');
    const {createDigitalLogicApplication}=await import('./app/digital-logic.ts');
    const {executionTransports}=await import('./app/execution-transport.ts');
    const config=readApplicationConfig(process.env.XUNJIE_APP_CONFIG);
    const originUrl=new URL(config.origin);
    if(Number(originUrl.port || 443)!==port) throw new Error('Exact local HTTPS origin required.');
    const db=openSyntheticDatabase(config.databaseFile);
    try {
      const generation=db.withTransaction(tx=>tx.get('SELECT recovery_generation FROM application_control WHERE singleton=1'))?.recovery_generation;
      if(generation!==config.recoveryGeneration) throw new Error('Recovery control mismatch.');
      const versions=config.tutoring?.versions??{modelConfig:'unconfigured',prompt:'unconfigured',schema:'unconfigured',policy:'unconfigured'};
      const service=await createDigitalLogicApplication({db,origin:config.origin,signingSecret:readI0SigningSecret(config.signingSecretFile),
        ...(config.allowedLoginUserIds?{allowedLoginUserIds:config.allowedLoginUserIds}:{}),
        https:{key:readFileSync(config.tls.keyFile),cert:readFileSync(config.tls.certFile)},logDestination:process.stdout,
        ...(config.ssh?executionTransports(config.ssh):{executionNodes:config.executionNodes!.map(({ssh,...node})=>({...node,...executionTransports(ssh)})),...(config.legacyExecutionNodeId?{legacyExecutionNodeId:config.legacyExecutionNodeId}:{})}),approvedHdlRuntimes:config.approvedHdlRuntimes,
        ...(config.staticDirectory?{staticDirectory:config.staticDirectory}:{}),
        consumerIntervalMs:config.consumerIntervalMs,studentHelp:{versions,budgetAvailable:()=>config.tutoring?.callsAuthorized??false},
        personalModels:config.personalModels??{directory:join(dirname(config.databaseFile),'personal-agent')},
        ...(config.teacherDesign?{teacherDesign:config.teacherDesign}:{}),
        ...(config.review?{review:{versions:{modelConfigVersion:versions.modelConfig,promptVersion:versions.prompt,schemaVersion:versions.schema,analysisVersion:'learner-analysis-v1'}}}:{}),
        ...(config.tutoring?.apiKeyFile?{tutoringProvider:(await import('./tutoring/deepseek-sdk.ts')).createAiSdkDeepSeekProvider({
          apiKey:readI0SigningSecret(config.tutoring.apiKeyFile),
        })}:{}),
        teacherAgent:{versions,budgetAvailable:()=>false,provider:{generate:async()=>{throw new Error('Model unavailable.');}}}});
      app=service.app;
      closeService=async()=>{try {await service.shutdown();} finally {db.close();}};
      await app.listen({host:'127.0.0.1',port});
      service.startConsumer(config.consumerIntervalMs);
    } catch(error) {if(!closeService) db.close();throw error;}
  } else {
    const { createApp }=await import('./app.ts');
    app=createApp({logDestination:process.stdout});
    await app.listen({host:'127.0.0.1',port});
  }
  process.once('SIGINT',shutdown);
  process.once('SIGTERM',shutdown);
} catch {
  process.stderr.write('Teaching server startup failed. Check controlled configuration and local port availability.\n');
  await shutdown();
  process.exitCode=1;
}

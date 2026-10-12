import {readFileSync} from 'node:fs';
import {createApp} from './app.ts';
import {readPort} from './app/config.ts';
import type {SyntheticDatabase} from './db/transaction.ts';
import type {createDigitalLogicApplication} from './app/digital-logic.ts';
let app:ReturnType<typeof createApp>|undefined,host:Awaited<ReturnType<typeof createDigitalLogicApplication>>|undefined,db:SyntheticDatabase|undefined,closing=false;
async function shutdown(){if(closing)return;closing=true;try{if(host)await host.shutdown();else await app?.close();}catch{process.stderr.write('Teaching server shutdown failed.\n');process.exitCode=1;}finally{db?.close();}}
try{
 const port=readPort(process.env.PORT);
 const file=process.env.XUNJIE_APP_CONFIG;
 if(file){
 const {readApplicationConfig}=await import('./app/config.ts');
 const config=readApplicationConfig(file);
 const {openSyntheticDatabase}=await import('./db/transaction.ts');
 const {createDigitalLogicApplication}=await import('./app/digital-logic.ts');
 const {executionTransports}=await import('./app/execution-transport.ts');
 db=openSyntheticDatabase(config.databaseFile);
 const generation=db.withTransaction(tx=>tx.get('SELECT recovery_generation FROM application_control WHERE singleton=1'))?.recovery_generation;if(generation!==config.recoveryGeneration)throw new Error('Recovery control mismatch.');
 const signingSecret=readFileSync(config.signingSecretFile,'utf8').trim();
 const versions={modelConfig:'unconfigured',prompt:'unconfigured',schema:'unconfigured',policy:'unconfigured'};
 host=await createDigitalLogicApplication({db,origin:config.origin,signingSecret,https:{key:readFileSync(config.tls.keyFile),cert:readFileSync(config.tls.certFile)},logDestination:process.stdout,
 ...executionTransports(config.ssh),approvedHdlRuntimes:config.approvedHdlRuntimes,studentHelp:{versions,budgetAvailable:()=>false},teacherAgent:{versions,budgetAvailable:()=>false,provider:{generate:async()=>{throw new Error('Model unavailable.');}}}});
 app=host.app;await app.listen({host:'127.0.0.1',port});host.startConsumer(config.consumerIntervalMs);
 }else{app=createApp({logDestination:process.stdout});await app.listen({host:'127.0.0.1',port});}
 process.once('SIGINT',()=>{void shutdown();});process.once('SIGTERM',()=>{void shutdown();});
}catch{process.stderr.write('Teaching server startup failed. Check controlled configuration, current execution readiness and local port availability.\n');await shutdown();process.exitCode=1;}

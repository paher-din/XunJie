import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const source=process.argv[2],configFile='/opt/xunjie-runner/tests/i0-entry-20261013-01/i0-host-recovered-20261014.json';
assert.equal(process.version,'v24.21.0');assert.equal(process.getuid(),0);
process.env.TMPDIR='/opt/xunjie-runner/tests/i0-entry-20261013-01/retained-tmp-20261014';
const load=path=>import(pathToFileURL(source+'/apps/teaching/'+path));
const {readI0Config,readI0Generation,readI0SigningSecret}=await load('server/app/config.ts');
const {openSyntheticDatabase}=await load('server/db/transaction.ts');
const {createI0App}=await load('server/app/i0.ts');
const {executionTransports}=await load('server/app/execution-transport.ts');
const {availableRuntime}=await load('server/design/readiness.ts');
const config=readI0Config(configFile);assert.equal(config.origin,'https://127.0.0.1:3443');assert.equal(config.tutoring,undefined);
const generation=readI0Generation(config.generationFile),{runner}=executionTransports(config.ssh);
const runtime=await availableRuntime(runner);assert.ok(runtime);assert.equal(runtime.recoveryGeneration,generation);
const db=openSyntheticDatabase(config.databaseFile);
assert.equal(db.withTransaction(tx=>tx.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").length),24);
const host=await createI0App({db,origin:config.origin,signingSecret:readI0SigningSecret(config.signingSecretFile),
  https:{key:readFileSync(config.tls.keyFile),cert:readFileSync(config.tls.certFile)},currentGeneration:()=>generation,runner,
  staticDirectory:source+'/apps/student/dist',consumerIntervalMs:config.consumerIntervalMs});
let closing=false;async function close(){if(closing)return;closing=true;try{await host.close();}finally{db.close();}}
process.once('SIGTERM',()=>void close());process.once('SIGINT',()=>void close());
await host.app.listen({host:'127.0.0.1',port:3443});host.startConsumer();
console.log(JSON.stringify({origin:config.origin,databaseFile:config.databaseFile,staticDirectory:source+'/apps/student/dist',
  recoveryGeneration:generation,configurationFileUnchanged:true,modelCallsAuthorized:false}));

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const source=process.argv[2],reference=JSON.parse(readFileSync(process.argv[3],'utf8'));
assert.equal(process.version,'v24.21.0');assert.equal(process.getuid(),0);assert.equal(reference.passed,true);
const root='/opt/xunjie-runner/tests/i0-entry-20261013-01';
process.env.TMPDIR=root+'/retained-tmp-20261014';
const config=JSON.parse(readFileSync(root+'/i0-host-recovered-20261014.json','utf8'));
const load=path=>import(pathToFileURL(source+'/apps/teaching/'+path));
const {openSyntheticDatabase}=await load('server/db/transaction.ts');
const {executionTransports}=await load('server/app/execution-transport.ts');
const {createDigitalLogicApplication}=await load('server/app/digital-logic.ts');
const db=openSyntheticDatabase(reference.databaseFile),origin='https://127.0.0.1:3444';
const service=await createDigitalLogicApplication({db,origin,...executionTransports(config.ssh),approvedHdlRuntimes:[reference.hdlRuntime],
  signingSecret:readFileSync(config.signingSecretFile,'utf8').trim(),https:{key:readFileSync(config.tls.keyFile),cert:readFileSync(config.tls.certFile)},
  staticDirectory:source+'/apps/student/dist',consumerIntervalMs:250,
  // This retained UI host does not inherit the already consumed single-round model authorization.
  studentHelp:{versions:{modelConfig:'deepseek-flash-v1',prompt:'student-help-v1',schema:'student-help-v1',policy:'activity-policy'},budgetAvailable:()=>false}});
let closing=false;
async function close(){if(closing)return;closing=true;try{await service.shutdown();}finally{db.close();}}
process.once('SIGTERM',()=>void close());process.once('SIGINT',()=>void close());
await service.app.listen({host:'127.0.0.1',port:3444});service.startConsumer();
console.log(JSON.stringify({origin,databaseFile:db.file,modelCallsAuthorized:false,staticUi:'current inherited main UI build; HDL controls still require UI wiring'}));

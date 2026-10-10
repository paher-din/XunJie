import {connect} from 'node:net';

const original=process.env.SSH_ORIGINAL_COMMAND??'';
const peer=process.argv[2]==='maintenance'?'maintenance':'application';
if(peer==='application' && original!=='' && original!=='xunjie-c1') {
  process.stdout.write(JSON.stringify({error:{code:'FORBIDDEN',message:'Only the fixed runner control entry is allowed'}})+'\n');
  process.exit(1);
}
let body='';
for await(const bytes of process.stdin) {
  body+=bytes.toString('utf8');
  if(Buffer.byteLength(body)>8*1024*1024){process.stdout.write(JSON.stringify({error:{code:'CONTENT_LIMIT',message:'Node request too large'}})+'\n');process.exit(1);}
}
let request;
try {request=JSON.parse(body);} catch {
  process.stdout.write(JSON.stringify({error:{code:'INVALID_REQUEST',message:'A JSON command is required'}})+'\n');process.exit(1);
}
if(!request || typeof request!=='object' || Array.isArray(request) || ['actor','role','peer'].some(key=>key in request)
  || (peer==='application'&&!['submit','query','cancel','readResult','readiness'].includes(request.op))) {
  process.stdout.write(JSON.stringify({error:{code:'FORBIDDEN',message:'Runner command or identity field denied'}})+'\n');process.exit(1);
}
const socket=connect('/run/xunjie-c1/control.sock');
socket.setTimeout(150000,()=>socket.destroy(new Error('Control response timed out')));
socket.on('connect',()=>socket.write(JSON.stringify({peer,request})+'\n'));
socket.on('data',bytes=>process.stdout.write(bytes));
socket.on('error',()=>{process.stdout.write(JSON.stringify({error:{code:'DEPENDENCY_UNAVAILABLE',message:'Runner control unavailable'}})+'\n');process.exitCode=1;});

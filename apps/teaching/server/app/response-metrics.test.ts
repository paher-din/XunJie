import assert from 'node:assert/strict';
import test from 'node:test';
import {createApp} from '../app.ts';
import {createVerificationApp} from '../access/app.ts';
import {createSyntheticDatabase} from '../db/transaction.ts';
import {createPasswordRecord} from '../access/password.ts';
import {randomBytes} from 'node:crypto';

const canary=(label:string)=>`synthetic-metrics-${label}-${randomBytes(12).toString('hex')}`;
const keys=['durationMs','method','requestId','route','status'];
const responses=(lines:string[])=>lines.map(line=>JSON.parse(line)).filter(row=>'durationMs' in row);
test('response metrics include server preHandler time and only the registered route, with no request secrets',async t=>{
  const lines:string[]=[],app=createApp({logDestination:{write(line){lines.push(line);}}});t.after(()=>app.close());
  app.post('/api/attempts/:id/sync',{preHandler:async()=>{await new Promise(resolve=>setTimeout(resolve,25));}},async()=>({data:{ok:true}}));
  const secrets=Object.fromEntries(['path','query','cookie','auth','header','body'].map(label=>[label,canary(label)]));
  const result=await app.inject({method:'POST',url:`/api/attempts/${secrets.path}/sync?token=${secrets.query}`,
    headers:{cookie:`session=${secrets.cookie}`,authorization:['Bearer',secrets.auth].join(' '),'x-request-id':secrets.header},payload:{password:secrets.body}});
  assert.equal(result.statusCode,200);const metrics=responses(lines);assert.equal(metrics.length,1);
  const row=metrics[0];assert.deepEqual(Object.keys(row).sort(),keys);
  assert.equal(row.route,'/api/attempts/:id/sync');assert.equal(row.method,'POST');assert.equal(row.status,200);
  assert.equal(row.requestId,result.headers['x-request-id']);assert.match(row.requestId,/^[0-9a-f-]{36}$/);
  assert(row.durationMs>=20);assert(Number.isFinite(row.durationMs));for(const value of Object.values(secrets))assert(!lines.join('').includes(value));
});

test('not-found, malformed JSON and internal failures preserve sanitized metrics without raw URL or exception data',async t=>{
  const lines:string[]=[],app=createApp({logDestination:{write(line){lines.push(line);}}});t.after(()=>app.close());
  const secrets=Object.fromEntries(['missing','query','path','body','exception'].map(label=>[label,canary(label)]));
  app.post('/api/input/:id',async()=>({ok:true}));
  app.get('/api/failure/:id',async()=>{throw new Error(secrets.exception);});
  const inputs=[{url:`/api/${secrets.missing}?token=${secrets.query}`},
    {method:'POST' as const,url:`/api/input/${secrets.path}`,headers:{'content-type':'application/json'},payload:JSON.stringify({password:secrets.body}).slice(0,-1)},
    {url:`/api/failure/${secrets.path}`}];
  for(const input of inputs)await app.inject(input);
  const metrics=responses(lines);assert.equal(metrics.length,3);
  assert.deepEqual(metrics.map(row=>row.route),['<other>','/api/input/:id','/api/failure/:id']);
  assert.deepEqual(metrics.map(row=>row.status),[400,400,503]);
  for(const row of metrics)assert.deepEqual(Object.keys(row).sort(),keys);
  for(const value of Object.values(secrets))assert(!lines.join('').includes(value));
});

test('normal product login emits a server-side duration without passwords, cookies or session payload',async()=>{
  const db=createSyntheticDatabase(),lines:string[]=[],password=randomBytes(24).toString('hex'),record=await createPasswordRecord(password);
  db.withTransaction(tx=>tx.run('INSERT INTO users(id,login_name,password_hash,salt,algorithm,n,r,p,key_length) VALUES (?,?,?,?,?,?,?,?,?)',
    'capacity-test','capacity-test',record.hash,record.salt,'scrypt',131072,8,1,64));
  const service=await createVerificationApp({db,origin:'https://synthetic.example',signingSecret:randomBytes(48).toString('hex'),logDestination:{write(line){lines.push(line);}}});
  try{
    const result=await service.app.inject({method:'POST',url:'/api/sessions',headers:{origin:'https://synthetic.example'},payload:{loginName:'capacity-test',password}});
    assert.equal(result.statusCode,200);const row=responses(lines).find(item=>item.route==='/api/sessions');assert.ok(row);
    assert.deepEqual(Object.keys(row).sort(),keys);assert.equal(row.requestId,result.json().requestId);assert(row.durationMs>0);
    assert(!lines.join('').includes(password));assert(!lines.join('').includes(result.json().data.csrfToken));
    assert(!lines.join('').includes(String(result.headers['set-cookie'])));
  }finally{await service.app.close();db.close();}
});

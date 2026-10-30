import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmod, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import pg from 'pg';
import { createMaintenanceCoordinator } from '@xunjie/product-runtime/maintenance';
import { provisionStorage, openStorage, createFileBackend, createS3Backend } from '@xunjie/storage';
import { nativeFixture } from './native-fixture.mjs';
import { delayedPut } from './s3-delayed-put.mjs';

const migrations = [{version:1,name:'resource-records',sql:'CREATE TABLE records(id text PRIMARY KEY,resource_id uuid NOT NULL)'}];
const bytes = Uint8Array.from([0,255,13,10,0,123,34,97,34,58,32,49,125,10]);
const deferred = () => { let resolve; const promise=new Promise(done=>{resolve=done;});return {promise,resolve}; };
const upload = () => ({ uploadId:randomUUID(),scope:'records/example',bytes,mediaType:'application/octet-stream',contentVersion:1 });
const collect = storage => storage.collect({olderThan:new Date(Date.now()+60_000)});

test('real file and pinned S3 bytes survive publication rollback, reopening, retained snapshots and collection', {timeout:120_000}, async t=>{
  const configPath=process.env.XUNJIE_STORAGE_S3_CONFIG;
  if(!configPath) throw new Error('Set XUNJIE_STORAGE_S3_CONFIG to the private pinned S3 fixture configuration.');
  const s3=JSON.parse(await readFile(configPath,'utf8'));
  const fixture=await nativeFixture();
  try {
    for(const kind of ['file','s3']) await t.test(kind,async()=>{
      const binding=await provisionStorage({admin:fixture.admin,owner:{environmentId:randomUUID(),serviceId:randomUUID()},password:randomUUID(),migrations});
      const backend=kind==='file'?createFileBackend({id:'files',root:join(fixture.root,'objects')}):createS3Backend(s3);
      let storage=await openStorage({binding,migrations,backend});
      let manifest;
      const staged=[];
      try {
        const input=upload();const reference=await storage.stageResource(input);staged.push(reference);
        await assert.rejects(storage.request({requestId:'failed-publication',fingerprint:'initial'},async tx=>{
          await tx.reference('record:one',reference.resourceId);
          await tx.query("INSERT INTO records VALUES('one',$1)",[reference.resourceId]);
          await tx.enqueue('must-not-send',{});
          await tx.query("INSERT INTO records VALUES('one',$1)",[reference.resourceId]);return {};
        }),{code:'conflict'});
        assert.equal(await storage.receipt('failed-publication'),null);
        assert.deepEqual(await storage.pendingIntents(),[]);
        assert.equal((await storage.read('SELECT * FROM records')).rowCount,0);
        assert.deepEqual(await storage.readResource(reference.resourceId),bytes);
        const retried=await storage.stageResource(input);assert.deepEqual(retried,reference);
        await assert.rejects(storage.stageResource({...input,bytes:new Uint8Array([1,2,3])}),{code:'identity-conflict'});
        await storage.request({requestId:'publish',fingerprint:'initial'},async tx=>{
          await tx.reference('record:one',reference.resourceId);
          await tx.query("INSERT INTO records VALUES('one',$1)",[reference.resourceId]);
          await tx.enqueue('send-one',{resourceId:reference.resourceId});return {resource:reference};
        });
        await storage.close();storage=await openStorage({binding,migrations,backend});
        assert.deepEqual(await storage.readResource(reference.resourceId),bytes);
        assert.deepEqual((await storage.receipt('publish')).result,{resource:reference});
        assert.deepEqual(await collect(storage),[]);

        const recorded=[];
        const maintenance=createMaintenanceCoordinator({requiredServiceIds:[binding.owner.serviceId],record:async state=>{
          recorded.push(state.phase);
          // A real owner-controlled persistent maintenance journal.
          await writeFile(join(fixture.root,`maintenance-${kind}.json`),JSON.stringify(state));
        }});
        maintenance.register(storage.participant());
        assert.equal((await maintenance.enter('resource-snapshot')).safeToStop,true);
        await assert.rejects(storage.stageResource(upload()),error=>['maintenance','stale-generation'].includes(error.code));
        await assert.rejects(storage.pendingIntents(),{code:'maintenance'});
        await storage.snapshot('backup-one',async snapshot=>{
          manifest=snapshot.manifest;assert.deepEqual(manifest.resources,[reference]);
          const reader=new pg.Client(binding.connection);await reader.connect();
          try {
            await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
            // Server-generated snapshot ID, not caller SQL.
            await reader.query(`SET TRANSACTION SNAPSHOT '${snapshot.databaseSnapshot}'`);
            assert.deepEqual((await reader.query(`SELECT id FROM ${binding.schema}.records`)).rows,[{id:'one'}]);
            await reader.query('COMMIT');
          } finally {await reader.end();}
        });
        await storage.validateManifest(manifest);
        const copied=createFileBackend({id:backend.id,root:join(fixture.root,`copied-${kind}`)});
        await copied.put(reference.locator.key,await storage.readResourceObject(reference.resourceId));
        const relocated=await openStorage({binding,migrations,backend:copied});
        try {assert.deepEqual(await relocated.readResource(reference.resourceId),bytes);} finally {await relocated.close();}
        await assert.rejects(storage.validateManifest({...manifest,resources:[]}),{code:'corrupt'});
        await maintenance.resume();
        assert.ok(recorded.includes('validated'));
        await storage.request({requestId:'remove-reference',fingerprint:'remove'},async tx=>{
          await tx.query('DELETE FROM records');await tx.unreference('record:one');return {};
        });
        await storage.close();storage=await openStorage({binding,migrations,backend});
        assert.deepEqual(await collect(storage),[], 'durable backup pin survives a process reopening');
        const nextParticipant=storage.participant();
        await nextParticipant.closeWrites();await nextParticipant.closeDispatch();await nextParticipant.drain();
        await storage.snapshot('backup-two',async snapshot=>{
          assert.deepEqual(snapshot.manifest.resources,[reference], 'a database snapshot retaining an older backup also needs its bytes');
          await assert.rejects(storage.validateManifest({...snapshot.manifest,resources:[]}),{code:'corrupt'});
        });
        await nextParticipant.resume();
        await storage.releaseBackup('backup-one');
        assert.deepEqual(await collect(storage),[], 'the newer backup independently retains the older manifest bytes');
        await storage.releaseBackup('backup-two');
        assert.deepEqual(await collect(storage),[reference.resourceId]);
        await assert.rejects(storage.readResource(reference.resourceId),{code:'resource-gone'});
      } finally {
        await storage.close();for(const reference of staged) await backend.remove(reference.locator.key);
      }
    });
  } finally {await fixture.close();}
});

test('real reference creation and deletion claims cannot delete a newly retained object', {timeout:60_000},async()=>{
  const fixture=await nativeFixture();let a,b;
  try {
    const binding=await provisionStorage({admin:fixture.admin,owner:{environmentId:randomUUID(),serviceId:randomUUID()},password:randomUUID(),migrations});
    const files=createFileBackend({id:'files',root:join(fixture.root,'objects')});
    const deleting=deferred(),allowDelete=deferred();let blockDelete=false;
    const backend={...files,async remove(key){if(blockDelete){deleting.resolve();await allowDelete.promise;}await files.remove(key);}};
    a=await openStorage({binding,migrations,backend});b=await openStorage({binding,migrations,backend});
    const reference=await a.stageResource(upload());
    const held=deferred(),commit=deferred();
    const publication=a.request({requestId:'new-ref',fingerprint:'ref'},async tx=>{
      await tx.reference('new-reference',reference.resourceId);held.resolve();await commit.promise;return {};
    });
    await held.promise;
    assert.deepEqual(await collect(b),[]);
    commit.resolve();await publication;
    assert.deepEqual(await collect(b),[]);
    assert.deepEqual(await a.readResource(reference.resourceId),bytes);
    await a.request({requestId:'release',fingerprint:'release'},async tx=>{await tx.unreference('new-reference');return {};});
    blockDelete=true;const cleanup=collect(b);await deleting.promise;
    await assert.rejects(a.request({requestId:'too-late',fingerprint:'late'},async tx=>{await tx.reference('late',reference.resourceId);return {};}),{code:'resource-busy'});
    assert.equal(await a.receipt('too-late'),null);
    allowDelete.resolve();assert.deepEqual(await cleanup,[reference.resourceId]);
    await assert.rejects(a.resource(reference.resourceId),{code:'resource-gone'});
  } finally {await a?.close();await b?.close();await fixture.close();}
});

test('upload does not hold a database transaction and maintenance drains its durable in-flight identity', {timeout:60_000},async()=>{
  const fixture=await nativeFixture();let storage,peer;
  const writing=deferred(),finish=deferred();
  try {
    const binding=await provisionStorage({admin:fixture.admin,owner:{environmentId:randomUUID(),serviceId:randomUUID()},password:randomUUID(),migrations});
    const files=createFileBackend({id:'files',root:join(fixture.root,'objects')});
    storage=await openStorage({binding,migrations,backend:{...files,async put(key,content){writing.resolve();await finish.promise;await files.put(key,content);}}});
    peer=await openStorage({binding,migrations,backend:files});
    const input=upload();const staging=storage.stageResource(input);await writing.promise;
    await assert.rejects(storage.reconcileUpload(input.uploadId),{code:'missing'});
    assert.deepEqual(await collect(peer),[], 'a recovery GET cannot prove that a pending upload has finished');
    await peer.request({requestId:'unrelated',fingerprint:'small'},async()=>({saved:true}));
    const participant=peer.participant();
    // If upload held the admission row/transaction, closeWrites would time out.
    await participant.closeWrites();await participant.closeDispatch();
    let drained=false;const draining=participant.drain().then(()=>{drained=true;});
    await delay(50);assert.equal(drained,false);
    finish.resolve();const reference=await staging;await draining;
    await participant.validate();await participant.resume();
    await assert.rejects(storage.request({requestId:'stale',fingerprint:'old'},async()=>({})),{code:'stale-generation'});
    assert.deepEqual(await peer.readResource(reference.resourceId),bytes);
  } finally {finish.resolve();await storage?.close();await peer?.close();await fixture.close();}
});

test('actual missing, corrupt, partial and denied bytes never become a published reference', {timeout:60_000},async()=>{
  const fixture=await nativeFixture();let storage;
  try {
    const binding=await provisionStorage({admin:fixture.admin,owner:{environmentId:randomUUID(),serviceId:randomUUID()},password:randomUUID(),migrations});
    const root=join(fixture.root,'objects');
    const backend=createFileBackend({id:'files',root});
    storage=await openStorage({binding,migrations,backend});
    const input=upload(),reference=await storage.stageResource(input);
    const path=join(root,reference.locator.key);
    const originalStored=await readFile(path);
    await writeFile(path,new Uint8Array([0,1,2]));
    await assert.rejects(storage.readResource(reference.resourceId),{code:'corrupt'});
    await rm(path);await assert.rejects(storage.readResource(reference.resourceId),{code:'missing'});
    await backend.put(reference.locator.key,originalStored);await chmod(path,0);
    await assert.rejects(storage.readResource(reference.resourceId),{code:'forbidden'});
    await chmod(path,0o600);
    const incomplete=upload();
    const key=`${binding.owner.environmentId}/${binding.owner.serviceId}/${incomplete.uploadId}`;
    await backend.put(key,new Uint8Array([1,2]));
    await assert.rejects(storage.stageResource(incomplete),{code:'identity-conflict'});
    await assert.rejects(storage.reconcileUpload(incomplete.uploadId),{code:'corrupt'});
    await assert.rejects(storage.request({requestId:'partial-publication',fingerprint:'partial'},async tx=>{await tx.reference('partial',incomplete.uploadId);return {};}),{code:'resource-busy'});
    assert.equal(await storage.receipt('partial-publication'),null);
  } finally {await storage?.close();await fixture.close();}
});

test('a killed uploader leaves a durable unresolved identity; maintenance fails closed until the same bytes are reconciled', {timeout:60_000},async()=>{
  const fixture=await nativeFixture();let storage,child;
  try {
    const binding=await provisionStorage({admin:fixture.admin,owner:{environmentId:randomUUID(),serviceId:randomUUID()},password:randomUUID(),migrations});
    const backend={id:'files',root:join(fixture.root,'objects')};
    const input=upload();const config=join(fixture.root,'upload-child.json');
    await writeFile(config,JSON.stringify({binding,migrations,backend,upload:{...input,bytes:[...bytes]}}),{mode:0o600});
    child=fork(new URL('./transaction-child.mjs',import.meta.url),[config],{stdio:['ignore','ignore','pipe','ipc']});
    const [message]=await once(child,'message');assert.equal(message.phase,'bytes-durable');
    const exiting=once(child,'exit');child.kill('SIGKILL');await exiting;child=undefined;
    storage=await openStorage({binding,migrations,backend:createFileBackend(backend),drainTimeoutMs:100});
    assert.deepEqual(await collect(storage),[], 'unresolved uploads cannot be garbage collected');
    const missing=randomUUID();
    const coordinator=createMaintenanceCoordinator({requiredServiceIds:[binding.owner.serviceId,missing],record:async state=>{
      await writeFile(join(fixture.root,'maintenance.json'),JSON.stringify(state));
    }});
    coordinator.register(storage.participant());
    await assert.rejects(coordinator.enter('missing-participant'));
    assert.equal(coordinator.status().phase,'failed');
    assert.deepEqual(coordinator.status().missingServiceIds,[missing]);
    assert.equal(coordinator.status().safeToStop,false);
    await storage.close();
    storage=await openStorage({binding,migrations,backend:createFileBackend(backend),drainTimeoutMs:100});
    await assert.rejects(storage.request({requestId:'closed-after-restart',fingerprint:'write'},async()=>({})),{code:'maintenance'});
    await assert.rejects(storage.participant().drain(),{code:'resource-busy'});
    const reference=await storage.reconcileUpload(input.uploadId);
    assert.deepEqual(await storage.readResource(reference.resourceId),bytes);
    await storage.participant().drain();await storage.participant().resume();
    await storage.request({requestId:'associate-original-upload',fingerprint:'original'},async tx=>{
      await tx.reference('record:recovered',input.uploadId);
      await tx.query("INSERT INTO records VALUES('recovered',$1)",[input.uploadId]);return {resourceId:input.uploadId};
    });
    assert.deepEqual((await storage.receipt('associate-original-upload')).result,{resourceId:input.uploadId});
    assert.deepEqual(await collect(storage),[]);
  } finally {child?.kill('SIGKILL');await storage?.close();await fixture.close();}
});

test('duplicate upload identities wait for the original PUT, so a delayed writer cannot recreate a collected object', {timeout:60_000},async()=>{
  const fixture=await nativeFixture();let a,b,first,duplicate;
  const entered=deferred(),finish=deferred();
  try {
    const binding=await provisionStorage({admin:fixture.admin,owner:{environmentId:randomUUID(),serviceId:randomUUID()},password:randomUUID(),migrations});
    const files=createFileBackend({id:'files',root:join(fixture.root,'objects')});
    a=await openStorage({binding,migrations,backend:{...files,async put(key,content){entered.resolve();await finish.promise;await files.put(key,content);}}});
    b=await openStorage({binding,migrations,backend:files});
    const input=upload();first=a.stageResource(input);await entered.promise;
    let secondFinished=false;
    duplicate=b.stageResource(input).then(value=>{secondFinished=true;return value;});
    await delay(80);
    assert.equal(secondFinished,false,'the second session cannot manufacture readiness before the original writer has written');
    assert.deepEqual(await collect(b),[]);
    finish.resolve();const [one,two]=await Promise.all([first,duplicate]);assert.deepEqual(one,two);
    assert.deepEqual(await collect(b),[one.resourceId]);
    await assert.rejects(files.get(one.locator.key),{code:'missing'});
    await assert.rejects(a.stageResource(input),{code:'resource-gone'});
  } finally {finish.resolve();await Promise.allSettled([first,duplicate]);await a?.close();await b?.close();await fixture.close();}
});

test('real S3 timeout with stale conflicting or matching payload bytes stays unresolved until the original PUT completes', {timeout:60_000},async()=>{
  const configPath=process.env.XUNJIE_STORAGE_S3_CONFIG;
  if(!configPath) throw new Error('Pinned S3 configuration is required');
  const config=JSON.parse(await readFile(configPath,'utf8'));
  const fixture=await nativeFixture();const direct=createS3Backend(config);
  try {
    for(const prior of [new Uint8Array([7,7,7]),bytes]) {
    const relay=await delayedPut(config.endpoint);let storage,key;
    try {
    const owner={environmentId:randomUUID(),serviceId:randomUUID()};const input=upload();
    key=`${owner.environmentId}/${owner.serviceId}/${input.uploadId}`;
    await direct.put(key,prior);
    const binding=await provisionStorage({admin:fixture.admin,owner,password:randomUUID(),migrations});
    storage=await openStorage({binding,migrations,backend:createS3Backend({...config,endpoint:relay.endpoint}),drainTimeoutMs:100});
    await assert.rejects(storage.stageResource(input),{code:'upload-unknown'});
    await assert.rejects(storage.reconcileUpload(input.uploadId),{code:'corrupt'});
    assert.deepEqual(await collect(storage),[], 'stale payload bytes cannot settle the still-pending original PUT');
    const participant=storage.participant();await participant.closeWrites();await participant.closeDispatch();
    await assert.rejects(participant.drain(),{code:'resource-busy'});
    // Fault recovery removes the known corrupt external object. The original
    // request, still queued in the transport, then completes without a new PUT.
    await direct.remove(key);assert.ok((await relay.release())<300);
    const reference=await storage.reconcileUpload(input.uploadId);
    assert.deepEqual(await storage.readResource(reference.resourceId),bytes);
    await participant.drain();await participant.resume();
    assert.deepEqual(await collect(storage),[reference.resourceId]);
    await assert.rejects(direct.get(key),{code:'missing'});
    } finally {await storage?.close();await relay.close();if(key) await direct.remove(key);}
    }
  } finally {await fixture.close();}
});

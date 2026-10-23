import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createAccessService } from './server.mjs';
import { adminRequest } from './admin.mjs';
import { authenticatedRequest, joinEnrollment, refreshEnrollment } from '../xj-dev/src/enrollment-client.mjs';
import { ensureCertificateAuthority, ensureEnvironmentCertificate } from '../xj-dev/src/certificates.mjs';
import { environmentPaths } from '../xj-dev/src/paths.mjs';
import { writePrivateJson } from '../xj-dev/src/enrollment-protocol.mjs';

test('real HTTPS/proof grants file-only identities without SSH/application access; a pending signature cannot outlive live revocation', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'xjf-'))); let service, release;
  try {
    const ca = ensureCertificateAuthority(root), cert = ensureEnvironmentCertificate(environmentPaths(root, 'cert'), ca);
    const hostKey = join(root, 'host'); execFileSync('ssh-keygen',['-q','-t','ed25519','-N','','-f',hostKey],{stdio:'ignore'});
    const key = join(root,'credential.key'), pins = join(root,'pins');
    writeFileSync(key,randomBytes(32),{mode:0o600});writeFileSync(pins,'approved.test '+readFileSync(hostKey+'.pub','utf8'));
    const config = { serviceId:'file-capability-test', endpoint:'https://localhost:8443',port:0,listenHost:'127.0.0.1',databaseFile:join(root,'access.sqlite'),credentialKeyFile:key,
      adminSocket:join(root,'a'),backupDirectory:root,tls:{keyFile:cert.keyFile,certFile:cert.certFile,caFile:ca.certFile},knownHostsFile:pins,cloudCaFile:ca.certFile,
      courseIds:['course'],target:{schema:'xj-dev/connection-v1',host:'approved.test',port:22,browserOrigin:'https://localhost:13445',applicationPort:13444},
      packages:{bucket:'fixture-bucket',prefix:'team/'} };
    let reached;const signing = new Promise(done=>{reached=done;}), gate = new Promise(done=>{release=done;});
    const operations=[];
    service=createAccessService(config, { system:async input=>{operations.push('ssh-'+input.operation);return {username:'xjd_'+input.deviceId.replaceAll('-','').slice(0,28)};},
      application:async operation=>{operations.push('app-'+operation);return {};},storage:{
        initiate:async()=> 'fixture-upload',list:async()=>[],
        part:async()=>{reached();await gate;return {method:'PUT',url:'https://fixture-bucket.oss-cn-beijing.aliyuncs.com/fixture',headers:{},expiresAt:Date.now()+299000,allowedHost:'fixture-bucket.oss-cn-beijing.aliyuncs.com'};},
      } });
    await service.listen();config.endpoint='https://127.0.0.1:'+service.publicServer.address().port;
    const enroll=async(label,capabilities)=>{
      const i=await adminRequest(config.adminSocket,'invite',{label,teamRole:'developer',appRole:'teacher',courseId:'course',ttlSeconds:60,capabilities});
      const invitationFile=join(root,label+'.json');writePrivateJson(invitationFile,i);
      return joinEnrollment({home:join(root,label+'-home'),invitationFile});
    };
    const publisher=await enroll('publisher',['file:read','file:publish']);
    assert.equal(publisher.connectionFile,undefined);assert.equal(publisher.accountFile,undefined);assert.deepEqual(operations,[]);
    assert.equal((await refreshEnrollment({deviceFile:publisher.deviceFile})).identity.deviceId,publisher.identity.deviceId);
    const reader=await enroll('reader',['file:read']);
    const input={idempotencyKey:randomUUID(),bytes:7,digest:'sha256:'+'b'.repeat(64),crc64:'0',formatVersion:'xj-repro/1',toolVersion:'0.2.0'};
    await assert.rejects(authenticatedRequest(reader.deviceFile,'/v1/packages/upload',input),{code:'CAPABILITY_DENIED'});
    const upload=await authenticatedRequest(publisher.deviceFile,'/v1/packages/upload',input);
    const pending=authenticatedRequest(publisher.deviceFile,'/v1/packages/upload-parts',{transferId:upload.transferId,parts:[{partNumber:1,bytes:7,contentMD5:randomBytes(16).toString('base64')}]});
    // Attach rejection before awaiting admin, so an early rejection is handled.
    const denied=assert.rejects(pending,{code:'DEVICE_REVOKED'});
    await signing;
    const received=new Promise(done=>service.adminServer.once('request',req=>{assert.equal(req.url,'/package-quota');done();}));
    const quota=adminRequest(config.adminSocket,'package-quota',{});quota.catch(()=>{});
    await received;await new Promise(done=>setImmediate(done));
    const revoked=await Promise.race([adminRequest(config.adminSocket,'revoke-device',{deviceId:publisher.identity.deviceId}),delay(1000).then(()=>({blocked:true}))]);
    assert.equal(revoked.blocked,undefined,'queued package admin must not occupy the revocation queue');
    assert.equal(revoked.remainingUrlValidityMs,0);release();await denied;await quota;
    assert.equal((await authenticatedRequest(reader.deviceFile,'/v1/identity')).deviceId,reader.identity.deviceId);
    await assert.rejects(authenticatedRequest(publisher.deviceFile,'/v1/packages/upload',input),{code:'DEVICE_REVOKED'});
    const page=await enroll('page-only',['page']);
    await assert.rejects(authenticatedRequest(page.deviceFile,'/v1/packages/upload',input),{code:'CAPABILITY_DENIED'});
    assert.deepEqual(operations.filter(x=>x.endsWith('ensure')),['ssh-ensure','app-ensure']);
  } finally { release?.();await service?.close();rmSync(root,{recursive:true,force:true}); }
});

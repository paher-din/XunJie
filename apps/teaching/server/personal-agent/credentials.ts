import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { closeSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, writeFileSync } from 'node:fs';

export type SealedCredential = { ciphertext:string; iv:string; tag:string; hint:string };

export function credentialKey(file:string, allowCreate:boolean):Buffer {
  function readExisting(){
    const stat=lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size!==32
      ||(process.platform!=='win32'&&(stat.mode&0o077)!==0)) throw new Error('Invalid personal credential key file.');
    return readFileSync(file);
  }
  if(!allowCreate)return readExisting();
  let descriptor:number;
  try { descriptor=openSync(file,'wx',0o600); }
  catch(error) {
    if((error as NodeJS.ErrnoException).code!=='EEXIST') throw error;
    return readExisting();
  }
  try {
    const key=randomBytes(32);
    writeFileSync(descriptor,key);
    fsyncSync(descriptor);
    if(fstatSync(descriptor).size!==32) throw new Error('Personal credential key write failed.');
    return key;
  } finally { closeSync(descriptor); }
}

export function sealCredential(key:Buffer,userId:string,providerId:string,secret:string):SealedCredential {
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
  cipher.setAAD(Buffer.from(JSON.stringify([userId,providerId])));
  const ciphertext=Buffer.concat([cipher.update(secret,'utf8'),cipher.final()]);
  // Short keys are accepted by compatible services, but are never exposed as a full hint.
  return {ciphertext:ciphertext.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),
    hint:secret.length>8?`••••${secret.slice(-4)}`:'••••'};
}

export function openCredential(key:Buffer,userId:string,providerId:string,sealed:SealedCredential):string {
  const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(sealed.iv,'base64'));
  decipher.setAAD(Buffer.from(JSON.stringify([userId,providerId])));
  decipher.setAuthTag(Buffer.from(sealed.tag,'base64'));
  return Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext,'base64')),decipher.final()]).toString('utf8');
}

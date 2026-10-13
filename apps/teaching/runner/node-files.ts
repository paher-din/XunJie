import {constants,openSync,closeSync,fsyncSync,writeSync,readFileSync,fstatSync,linkSync,unlinkSync,existsSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {dirname} from 'node:path';
import {RunnerError,sha256} from './snapshot.ts';

export function writeImmutable(path:string,value:unknown) {
  const bytes=Buffer.from(JSON.stringify(value));
  const pending=path+'.pending-'+randomUUID();
  try {
    const fd=openSync(pending,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
    try {let offset=0;while(offset<bytes.length)offset+=writeSync(fd,bytes,offset,bytes.length-offset);fsyncSync(fd);} finally {closeSync(fd);}
    // Publish the fully synced inode atomically; readers cannot see the empty or partial JSON file.
    linkSync(pending,path);
  } finally {
    // Dropping the staging name cannot lose the fact: it is the same inode, now published under `path`.
    if(existsSync(pending))unlinkSync(pending);
  }
  const directory=openSync(dirname(path),constants.O_RDONLY|constants.O_DIRECTORY);
  try {fsyncSync(directory);} finally {closeSync(directory);}
}
export function readJson(path:string) {
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    if(!fstatSync(fd).isFile())throw new RunnerError('INVALID_REFERENCE','Not a regular node record');
    return JSON.parse(readFileSync(fd,'utf8'));
  } finally {closeSync(fd);}
}
export function envelope(value:unknown) {const body=JSON.stringify(value);return {body,hash:sha256(body)};}
export function readEnvelope(path:string) {
  const value=readJson(path);
  if(typeof value.body!=='string'||value.hash!==sha256(value.body))throw new RunnerError('INVALID_REFERENCE','Node record checksum mismatch');
  return JSON.parse(value.body);
}

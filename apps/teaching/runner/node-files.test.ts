import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout} from 'node:timers/promises';
import {writeImmutable,readEnvelope,envelope} from './node-files.ts';

test('immutable node files become visible only after a complete fsynced write',{skip:process.platform!=='linux'},async()=>{
  const directory=mkdtempSync(join(tmpdir(),'xunjie-node-publication-')),path=join(directory,'result.json');
  const child=spawn(process.execPath,['--input-type=module','-e',
    'const m=await import(process.argv[1]);m.writeImmutable(process.argv[2],m.envelope({text:"x".repeat(4*1024*1024)}));',new URL('./node-files.ts',import.meta.url).href,path],{stdio:'ignore'});
  const ended=new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error('Writer failed')));});
  let finished=false;void ended.then(()=>{finished=true;});
  while(!finished){if(existsSync(path))assert.equal(readEnvelope(path).text.length,4*1024*1024);await setTimeout(1);}
  await ended;assert.equal(readEnvelope(path).text.length,4*1024*1024);
  assert.throws(()=>writeImmutable(path,envelope({text:'replacement'})));assert.equal(readEnvelope(path).text.length,4*1024*1024);
});

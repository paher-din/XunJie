import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,existsSync,readdirSync} from 'node:fs';
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

test('publication leaves no staging name behind, on success and on a refused overwrite',{skip:process.platform!=='linux'},()=>{
  const directory=mkdtempSync(join(tmpdir(),'xunjie-node-staging-')),path=join(directory,'result.json');
  const staging=()=>readdirSync(directory).filter(name=>name.includes('.pending-'));
  for(let index=0;index<3;index+=1){
    writeImmutable(join(directory,`state-${index}.json`),envelope({index}));
    assert.deepEqual(staging(),[]);
  }
  writeImmutable(path,envelope({text:'original'}));
  assert.deepEqual(readdirSync(directory).sort(),['result.json','state-0.json','state-1.json','state-2.json']);
  assert.throws(()=>writeImmutable(path,envelope({text:'replacement'})));
  assert.deepEqual(staging(),[],'a refused overwrite must not accumulate a staging name either');
  assert.equal(readEnvelope(path).text,'original');
});

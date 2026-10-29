import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join} from 'node:path';
import {existsSync,readFileSync} from 'node:fs';
import {writeImmutable,readJson} from './node-files.ts';
import {nodeFingerprint} from './fingerprint.ts';
import {hdlExecutor} from './hdl-executor.ts';
import {initializeHdl} from './hdl-ledger.ts';

// Maintenance-only: creates a fresh non-secret config beside the original C config, never overwrites it.
const original=readJson(process.argv[2]!),destination=process.argv[3]!,source=process.argv[4]!;
const exec=promisify(execFile),engine=[original.dockerBinary,`--host=unix://${original.dockerSocket}`];
const image=async(tag:string)=>{const result=await exec(engine[0]!,[engine[1]!,'image','inspect','--format','{{.Id}}',tag]);return result.stdout.trim();};
const config={...original,source,hdl:{runtimeProfileVersion:'hdl-iverilog12-nexys4ddr-v1',engineVersion:'iverilog-12.0-ubuntu-12.0-2build2',
  buildImage:await image('xunjie-dlc/build:approved'),runtimeImage:await image('xunjie-dlc/runtime:approved'),sourceHash:''}};
initializeHdl(config);
const ledger=join(config.state,'ledger.jsonl');
if(existsSync(ledger))config.generation=readFileSync(ledger,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line).payload.generation).filter(Boolean).at(-1)??config.generation;
config.hdl.sourceHash=(await nodeFingerprint({source,profile:config.hdl},hdlExecutor(config))).fingerprint.sourceHash;
writeImmutable(destination,config);
console.log(JSON.stringify({profile:config.hdl,config:destination,validation:join(config.state,'hdl','validation.json')}));

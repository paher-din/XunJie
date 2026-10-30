import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HdlNode} from './hdl-node.ts';
import {hdlDirectory,saveSession,initializeHdl} from './hdl-ledger.ts';
import {writeImmutable,envelope} from './node-files.ts';
import {sha256} from './snapshot.ts';
import {aluPublicResult} from './alu-check.ts';
import type {HdlBuild,HdlSession} from '../contracts/runner/hdl.ts';
import {board} from '../tests/fixtures/hdl-board.ts';
import {elaboration,request} from '../tests/fixtures/alu-check.ts';

// The legacy Linux node initializes /run/xunjie-dlc; use a prepared runtime host.
test('H3 node probe requires true immutable metadata; check refuses occupied Attempt and never exposes private rows',{skip:process.platform!=='linux'},async t=>{
  const state=mkdtempSync(join(tmpdir(),'xunjie-alu-node-')),runtime={runtimeProfileVersion:'runtime',engineVersion:'iverilog-12',buildImage:request.buildImage,runtimeImage:request.runtimeImage,sourceHash:request.sourceHash};
  const config={node:process.execPath,source:state,state,generation:'generation',dockerBinary:'/nonexistent',dockerSocket:'/nonexistent',cliConfig:state,hdl:runtime};
  t.after(()=>rmSync(state,{recursive:true,force:true}));
  initializeHdl(config);const node=new HdlNode(config,state+'/config.json',()=>config.generation),artifact='immutable synthetic artifact';
  const buildPath=hdlDirectory(config,'builds','build');mkdirSync(join(buildPath,'artifact'),{recursive:true});
  writeFileSync(join(buildPath,'artifact','design.vvp'),artifact);
  const built:HdlBuild={buildId:'build',identity:{...request.identity,id:'build'},snapshotId:'snapshot',snapshotHash:request.snapshotHash,board,
    runtimeProfileVersion:runtime.runtimeProfileVersion,engineVersion:runtime.engineVersion,imageDigest:runtime.buildImage,configurationHash:sha256(JSON.stringify(board)),
    status:'succeeded',terminationConfirmed:true,artifactHash:sha256(artifact),diagnostics:[],stdout:'STUDENT_SAYS_PASSED',stderr:''};
  writeImmutable(join(buildPath,'request.json'),envelope({identity:built.identity,board,snapshot:{snapshotId:built.snapshotId,hash:built.snapshotHash}}));
  writeImmutable(join(buildPath,'outcome.json'),envelope(built));
  writeImmutable(join(buildPath,'elaboration.json'),envelope({artifactHash:built.artifactHash,elaboration}));
  const check={...request,artifactHash:built.artifactHash!,configurationHash:built.configurationHash};
  const {bindingHash:_hash,ruleVersionId:_rule,validatorVersion:_validator,vectorSetHash:_vectors,samplingProfileVersion:_sampling,
    runtimeProfileVersion:_runtime,engineVersion:_engine,buildImage:_buildImage,runtimeImage:_runtimeImage,sourceHash:_source,...probe}=check;
  const metadata=await node.dispatch({op:'hdl_alu_probe',request:probe},true);assert.equal(metadata.validated,true);assert(!JSON.stringify(metadata).includes('bits'));
  await assert.rejects(node.dispatch({op:'hdl_alu_probe',request:{...probe,artifactHash:'1'.repeat(64)}},true));
  const oldPath=hdlDirectory(config,'sessions','old');mkdirSync(oldPath);
  const old:HdlSession={sessionId:'old',identity:{...request.identity,id:'old'},buildId:'build',snapshotId:'snapshot',snapshotHash:request.snapshotHash,
    boardProfileVersion:board.boardProfileVersion,mappingVersion:board.mappingVersion,engineVersion:runtime.engineVersion,runtimeProfileVersion:'runtime',
    sessionRevision:1,confirmedSequence:0,simTimePs:'0',status:'active',terminationConfirmed:false,stopRequested:false,
    createdAt:new Date().toISOString(),lastOperationAt:new Date().toISOString(),deadline:new Date(Date.now()+120000).toISOString()};
  saveSession(oldPath,old);await assert.rejects(node.dispatch({op:'hdl_alu_check',request:check},true),{code:'RATE_LIMITED'});
  const checkPath=hdlDirectory(config,'sessions',check.identity.id);mkdirSync(checkPath);
  writeImmutable(join(checkPath,'request.json'),envelope({check}));saveSession(checkPath,{...old,sessionId:check.identity.id,identity:check.identity,status:'stopped',terminationConfirmed:true});
  const final=aluPublicResult(check,'passed',{expected:2800,sampled:2800,compared:2800,excluded:1296,complete:true},true);
  writeImmutable(join(checkPath,'check-result.json'),envelope(final));writeImmutable(join(checkPath,'private-samples.json'),envelope('PRIVATE_RAW_SAMPLES'));
  assert.deepEqual(await node.dispatch({op:'hdl_alu_result',identity:check.identity},true),final);
  assert(!JSON.stringify(await node.dispatch({op:'hdl_query',identity:check.identity},true)).includes('PRIVATE_RAW_SAMPLES'));
  await assert.rejects(node.dispatch({op:'hdl_result',identity:check.identity,operationId:check.identity.id},true),{code:'FORBIDDEN'});
  await assert.rejects(node.dispatch({op:'hdl_alu_result',identity:{...check.identity,recoveryGeneration:'old'}},true),{code:'RECOVERY_REQUIRED'});
});


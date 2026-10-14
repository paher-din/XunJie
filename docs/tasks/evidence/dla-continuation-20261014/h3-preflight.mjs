import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const counts={logic:0,addition:0,subtraction:0,excluded:0},defined=[];
for(let m=0;m<2;m++)for(let s=0;s<4;s++)for(let a=0;a<16;a++)for(let b=0;b<16;b++)for(let cin=0;cin<2;cin++){
  const kind=m===0?'logic':s===0?'addition':s===1&&a>b?'subtraction':'excluded';
  counts[kind]++;if(kind!=='excluded')defined.push([m,s,a,b,cin]);
}
assert.deepEqual(counts,{logic:2048,addition:512,subtraction:240,excluded:1296});
assert.equal(defined.length,2800);
const batches=Math.ceil(defined.length/32),sampleCount=defined.length*3;
const maxPacket=32*3*70+2048,totalBytes=sampleCount*70+batches*2048+6144;
assert.equal(batches,88);assert.equal(maxPacket,8768);assert.equal(totalBytes,774368);
assert(maxPacket<65536&&totalBytes<1048576);
console.log(JSON.stringify({kind:'H3 proposal preflight only; not HDL behavior acceptance',counts,expectedVectors:defined.length,
  tupleOrder:'M,S,A,B,Cin numeric ascending; compact JSON tuples',tupleSetSha256:createHash('sha256').update(JSON.stringify(defined)).digest('hex'),
  batches,privateSamples:sampleCount,maxPacketBytes:maxPacket,maxTotalBytes:totalBytes,
  jobDeadlineMs:120000,sumOfPerBatchCeilingsMs:batches*2000,throughputVerified:false,
  existingPublicFrameLimit:4096,privateSamplesFitPublicFrameLimit:false,requiresDedicatedPrivateCompactRows:true,
  gradedSignals:'F; addition additionally Cout; all undefined inputs/nonaddition Cout remain ungraded',
  sharedContractApproved:false,nodeMaintenanceApproved:false,hdlBehaviorPassCount:0},null,2));

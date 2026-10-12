import {z} from 'zod';
const id=z.string().min(1).max(128),hash=z.string().regex(/^[a-f0-9]{64}$/),natural=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const hdlIdentity=z.strictObject({id,commandId:id,requestHash:hash,recoveryGeneration:id,
  scope:z.strictObject({courseId:id,studentId:id,attemptId:id,activityVersionId:id})});
const signal=z.enum(['clock','switches','buttons','resetN','leds','anodes','segments','dp']);
const board=z.strictObject({boardProfileVersion:id,mappingVersion:id,topModule:id,bindings:z.array(z.strictObject({signal,offset:natural,port:id,portOffset:natural,width:natural.min(1)})).min(1).max(128)});
const bits=(width:number)=>z.string().regex(new RegExp(`^[01xz]{${width}}$`));
export const signalFrame=z.strictObject({simTimePs:z.string().regex(/^\d{1,32}$/),switches:bits(16),buttons:bits(5),resetN:bits(1),leds:bits(16),anodes:bits(8),segments:bits(7),dp:bits(1)});
export const hdlBuild=z.strictObject({buildId:id,identity:hdlIdentity,snapshotId:id,snapshotHash:hash,board,runtimeProfileVersion:id,engineVersion:id,
  imageDigest:z.string().regex(/^sha256:[a-f0-9]{64}$/),configurationHash:hash,status:z.enum(['queued','running','succeeded','failed','cancelled','outcome_unknown']),terminationConfirmed:z.boolean(),
  artifactHash:hash.optional(),diagnostics:z.array(z.strictObject({severity:z.enum(['error','warning']),message:z.string().max(65536),fileId:id.optional(),path:z.string().optional(),line:natural.min(1).optional(),location:z.enum(['line-only','unavailable'])})).max(100),
  stdout:z.string().max(65536),stderr:z.string().max(65536),failureKind:id.optional()});
export const hdlSession=z.strictObject({sessionId:id,identity:hdlIdentity,buildId:id,snapshotId:id,snapshotHash:hash,boardProfileVersion:id,mappingVersion:id,engineVersion:id,runtimeProfileVersion:id,
  sessionRevision:natural.min(1),confirmedSequence:natural,simTimePs:z.string().regex(/^\d{1,32}$/),status:z.enum(['starting','active','stopping','stopped','failed','outcome_unknown']),
  terminationConfirmed:z.boolean(),stopRequested:z.boolean(),createdAt:z.iso.datetime(),deadline:z.iso.datetime(),lastOperationAt:z.iso.datetime(),pendingOperationId:id.optional(),failureKind:id.optional()});
export const hdlResult=z.strictObject({operationId:id,sessionId:id,buildId:id,snapshotId:id,snapshotHash:hash,boardProfileVersion:id,mappingVersion:id,engineVersion:id,sequence:natural,
  sessionRevision:natural.min(1),frames:z.array(signalFrame).min(1).max(4096),finalFrame:signalFrame,sampleCount:natural,droppedFrames:natural,coverage:z.enum(['complete','incomplete']),resultHash:hash});

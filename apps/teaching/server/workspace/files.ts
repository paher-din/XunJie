import {RunnerError,sha256,validatePath} from '../../runner/snapshot.ts';
import type {Attempt,ProjectFile,Range,SyncBatch,TextChange} from '../../contracts/workspace/index.ts';
import {onlyFields} from '../records/commands.ts';

export function validateText(text:unknown):asserts text is string {
  if(typeof text!=='string'||/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text))throw new RunnerError('INVALID_REQUEST','Valid Unicode text required');
}
export function rangeOffsets(text:string,range:Range):[number,number] {
  onlyFields(range,['startLine','startColumn','endLine','endColumn']);
  if(!range||[range.startLine,range.startColumn,range.endLine,range.endColumn].some(value=>!Number.isSafeInteger(value)||value<1))throw new RunnerError('INVALID_REFERENCE','Invalid UTF-16 range');
  const lines=text.split('\n');
  const offset=(line:number,column:number)=>{
    if(line>lines.length)throw new RunnerError('INVALID_REFERENCE','Range line exceeds snapshot');
    const raw=lines[line-1];
    if(raw===undefined)throw new RunnerError('INVALID_REFERENCE','Range line exceeds snapshot');
    const visible=raw.endsWith('\r')?raw.slice(0,-1):raw;
    if(column>visible.length+1)throw new RunnerError('INVALID_REFERENCE','Range column exceeds snapshot');
    return lines.slice(0,line-1).reduce((sum,value)=>sum+value.length+1,0)+column-1;
  };
  const start=offset(range.startLine,range.startColumn),end=offset(range.endLine,range.endColumn);
  if(end<start)throw new RunnerError('INVALID_REFERENCE','Range end precedes start');
  return [start,end];
}
export function applyChanges(text:string,changes:TextChange[]) {
  if(!Array.isArray(changes)||changes.length===0)throw new RunnerError('INVALID_REQUEST','Text changes required');
  const edits=changes.map(change=>{onlyFields(change,['range','text']);validateText(change.text);const [start,end]=rangeOffsets(text,change.range);return {start,end,text:change.text};}).sort((a,b)=>a.start-b.start||a.end-b.end);
  for(let index=1;index<edits.length;index++)if(edits[index]!.start<edits[index-1]!.end||edits[index]!.start===edits[index-1]!.start)throw new RunnerError('INVALID_REQUEST','Overlapping text changes');
  let result=text;
  for(const edit of edits.reverse())result=result.slice(0,edit.start)+edit.text+result.slice(edit.end);
  validateText(result);return result;
}
export function validateFiles(attempt:Attempt,files:ProjectFile[]) {
  const ids=new Set<string>(),paths=new Set<string>();let bytes=0,count=0;
  for(const file of files) {
    if(file.attemptId!==attempt.attemptId||typeof file.fileId!=='string'||!file.fileId||ids.has(file.fileId)||!Number.isSafeInteger(file.documentVersion)||file.documentVersion<1
      ||!['active','recycled'].includes(file.lifecycle))throw new RunnerError('INVALID_REFERENCE','Invalid scoped file instance');
    ids.add(file.fileId);validatePath(file.path);validateText(file.text);
    if(file.contentHash!==sha256(file.text))throw new RunnerError('INVALID_REFERENCE','Confirmed file hash mismatch');
    if(file.lifecycle==='active'){
      if(paths.has(file.path))throw new RunnerError('STATE_CONFLICT','Active path is already occupied');
      paths.add(file.path);count++;bytes+=Buffer.byteLength(file.text);
    }
  }
  if(count>50||bytes>1048576)throw new RunnerError('CONTENT_LIMIT','Active workspace limit exceeded');
}
export function activate(attempt:Attempt):Attempt {
  return attempt.status==='ready'?{...attempt,status:'active',attemptRevision:attempt.attemptRevision+1}:structuredClone(attempt);
}

export function syncFiles(attempt:Attempt,files:ProjectFile[],batch:SyncBatch,assignmentActive:boolean,
  generatedIds:Record<string,string>) {
  validateFiles(attempt,files);
  onlyFields(batch,['expectedWorkspaceRevision','clientId','clientSeq','operations','process']);
  if(!batch||!batch.clientId||!Number.isSafeInteger(batch.clientSeq)||batch.clientSeq<0
    ||!Number.isSafeInteger(batch.expectedWorkspaceRevision)||!Array.isArray(batch.operations)||batch.operations.length===0||batch.operations.length>100)throw new RunnerError('INVALID_REQUEST','Invalid sync batch');
  if(batch.expectedWorkspaceRevision!==attempt.workspaceRevision)throw new RunnerError('VERSION_CONFLICT','Workspace version conflict');
  if(!['ready','active','paused'].includes(attempt.status))throw new RunnerError('STATE_CONFLICT','Attempt workspace is read-only');
  const next=structuredClone(files),seen=new Set<string>(),createKeys=new Set<string>(),created:Record<string,string>=Object.create(null);
  for(const operation of batch.operations) {
    if(!operation||!['create','update','recycle','restore'].includes(operation.kind))throw new RunnerError('INVALID_REQUEST','Invalid file operation');
    if((attempt.status==='paused'||!assignmentActive)&&operation.kind!=='update')throw new RunnerError('STATE_CONFLICT','Paused workspace only permits updating active files');
    onlyFields(operation,operation.kind==='create'?['kind','clientFileKey','path','text']:
      operation.kind==='update'?['kind','fileId','baseVersion','text','changes']:['kind','fileId','baseVersion']);
    if(operation.kind==='create') {
      validatePath(operation.path);validateText(operation.text);
      const id=Object.hasOwn(generatedIds,operation.clientFileKey)?generatedIds[operation.clientFileKey]:undefined;
      if(!operation.clientFileKey||createKeys.has(operation.clientFileKey)||typeof id!=='string'||!id||next.some(file=>file.fileId===id))throw new RunnerError('INVALID_REQUEST','Server-allocated file ID required');
      createKeys.add(operation.clientFileKey);created[operation.clientFileKey]=id;
      next.push({fileId:id,attemptId:attempt.attemptId,path:operation.path,documentVersion:1,text:operation.text,contentHash:sha256(operation.text),lifecycle:'active'});
      continue;
    }
    if(seen.has(operation.fileId))throw new RunnerError('INVALID_REQUEST','One operation per file instance required');
    seen.add(operation.fileId);
    const file=next.find(file=>file.fileId===operation.fileId);
    if(!file||!files.some(row=>row.fileId===operation.fileId))throw new RunnerError('INVALID_REFERENCE','File does not belong to the confirmed attempt');
    if(!Number.isSafeInteger(operation.baseVersion)||operation.baseVersion!==file.documentVersion)throw new RunnerError('VERSION_CONFLICT','File version conflict');
    if(operation.kind==='update') {
      if(file.lifecycle!=='active')throw new RunnerError('STATE_CONFLICT','Only active files can be updated');
      if((operation.text===undefined)===(operation.changes===undefined))throw new RunnerError('INVALID_REQUEST','Exactly one of text or changes required');
      const text=operation.changes===undefined?operation.text:applyChanges(file.text,operation.changes);
      validateText(text);file.text=text;file.contentHash=sha256(text);
    } else {
      const expected=operation.kind==='recycle'?'active':'recycled';
      if(file.lifecycle!==expected)throw new RunnerError('STATE_CONFLICT','Invalid file lifecycle transition');
      file.lifecycle=operation.kind==='recycle'?'recycled':'active';
    }
    file.documentVersion++;
  }
  validateFiles(attempt,next);
  const nextAttempt=assignmentActive?activate(attempt):structuredClone(attempt);
  if(nextAttempt.attemptRevision===attempt.attemptRevision)nextAttempt.attemptRevision++;
  nextAttempt.workspaceRevision++;
  const processAccepted=Boolean(batch.process&&attempt.collecting&&Number.isSafeInteger(batch.process.captureRevision)&&batch.process.captureRevision===attempt.captureRevision);
  return {attempt:nextAttempt,files:next,created,
    process:{status:processAccepted?'eligible':'not_collected',reason:!batch.process?'not_requested':!attempt.collecting?'capture_paused':!processAccepted?'stale_capture_revision':undefined}};
}

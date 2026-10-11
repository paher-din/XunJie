import {RunnerError,sha256} from '../../runner/snapshot.ts';
import type {CommandIdentity,CommandReceipt,Records,AuditEvent,Scope} from '../../contracts/records/index.ts';

export function onlyFields(value:unknown,allowed:string[]) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!allowed.includes(key)))throw new RunnerError('INVALID_REQUEST','Only approved command fields are accepted');
}

export function canonical(value:unknown):string {
  if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);
  if(typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype) {
    return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical((value as Record<string,unknown>)[key])).join(',')+'}';
  }
  throw new RunnerError('INVALID_REQUEST','Validated JSON fields required');
}
export function requestHash(target:string,validatedFields:unknown) {
  if(['/api/sessions','/api/logout'].includes(target))throw new RunnerError('INVALID_REQUEST','Session credentials are excluded from receipts');
  return sha256(canonical({target,fields:validatedFields}));
}
export function sameScope(a:Scope,b:Scope) {return canonical(a)===canonical(b);}
function publicKey(id:CommandIdentity){return canonical([id.actorId,id.command,id.target,id.idempotencyKey]);}
function syncKey(id:CommandIdentity){return id.sync?canonical([id.actorId,id.scope.attemptId,id.sync.clientId,id.sync.clientSeq]):undefined;}

// Caller re-authorizes inside A's transaction before resolving a committed receipt.
export function resolveCommandReceipt(records:Records,id:CommandIdentity,hash:string,generation:string) {
  if(!id.actorId||!id.command||!id.target||!id.idempotencyKey||!id.scope.courseId||!generation
    ||! /^[0-9a-f]{64}$/.test(hash)||['login','logout'].includes(id.command))throw new RunnerError('INVALID_REQUEST','Invalid command identity');
  if(id.recoveryGeneration!==generation)throw new RunnerError('RECOVERY_REQUIRED','Stale command generation');
  if(id.sync&&(!id.scope.attemptId||!id.sync.clientId||!Number.isSafeInteger(id.sync.clientSeq)||id.sync.clientSeq<0))throw new RunnerError('INVALID_REQUEST','Invalid sync identity');
  const alias=records.commandAliases.find(row=>publicKey(row.identity)===publicKey(id));
  const byKey=records.receipts.find(receipt=>publicKey(receipt.identity)===publicKey(id)||receipt.receiptId===alias?.receiptId);
  const bySync=id.sync?records.receipts.find(receipt=>syncKey(receipt.identity)===syncKey(id)):undefined;
  if(byKey&&bySync&&byKey.receiptId!==bySync.receiptId)throw new RunnerError('IDEMPOTENCY_CONFLICT','Command keys identify different receipts');
  const existing=byKey??bySync;
  if(existing&&(!sameScope(existing.identity.scope,id.scope)||existing.requestHash!==hash
    ||existing.identity.command!==id.command||existing.identity.target!==id.target))throw new RunnerError('IDEMPOTENCY_CONFLICT','Original command mismatch');
  return existing?structuredClone(existing):undefined;
}

export function appendEvent(records:Records,event:Omit<AuditEvent,'serverSeq'>):Records {
  if(!event.eventId||!event.type||!event.scope.courseId||!Number.isFinite(Date.parse(event.occurredAt))
    ||records.events.some(item=>item.eventId===event.eventId))throw new RunnerError('INVALID_REQUEST','Invalid event');
  return {...records,serverSeq:records.serverSeq+1,events:[...records.events,structuredClone({...event,serverSeq:records.serverSeq+1})]};
}

// This returns a write plan; only a successful real DB commit makes it an ACK.
export function finishCommand<T>(records:Records,receipt:Omit<CommandReceipt<T>,'serverSeq'>,
  event:Omit<AuditEvent,'serverSeq'>,generation:string) {
  const existing=resolveCommandReceipt(records,receipt.identity,receipt.requestHash,generation);
  if(existing) {
    const bound=records.receipts.some(row=>publicKey(row.identity)===publicKey(receipt.identity))
      ||records.commandAliases.some(row=>publicKey(row.identity)===publicKey(receipt.identity));
    const next=bound?records:{...records,commandAliases:[...records.commandAliases,{identity:structuredClone(receipt.identity),receiptId:existing.receiptId}]};
    return {records:next,receipt:existing,replayed:true};
  }
  if(!receipt.receiptId||!receipt.commandId||records.receipts.some(item=>item.receiptId===receipt.receiptId||item.commandId===receipt.commandId)
    ||!sameScope(event.scope,receipt.identity.scope)||event.occurredAt!==receipt.committedAt)throw new RunnerError('INVALID_REQUEST','Invalid receipt/event association');
  const next=appendEvent(records,event);
  const completed={...structuredClone(receipt),serverSeq:next.serverSeq};
  return {records:{...next,receipts:[...next.receipts,completed]},receipt:completed,replayed:false};
}

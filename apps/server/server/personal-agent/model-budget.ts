import { AsyncLocalStorage } from 'node:async_hooks';
import type { CompatibleTransport } from './types.ts';
import type { TutoringFailure } from '../../contracts/tutoring/index.ts';
import {ProviderCallNotStartedError,type ModelProvider} from '../tutoring/providers.ts';

export const MODEL_QUEUE_LIMITS={active:2,perMember:1,waiting:20,waitingMs:120_000,waitingBytes:32*1024*1024} as const;
export type ModelQueueCode='MODEL_QUEUE_FULL'|'MODEL_QUEUE_TIMEOUT'|'MODEL_QUEUE_CANCELLED'|'MODEL_QUEUE_CLOSED';
export class ModelQueueError extends Error {
  readonly code:ModelQueueCode;
  constructor(code:ModelQueueCode){super(code);this.code=code;}
}
export function modelQueueFailure(error:ModelQueueError):TutoringFailure {
  return {outcome:error.code==='MODEL_QUEUE_CANCELLED'?'cancelled':error.code==='MODEL_QUEUE_TIMEOUT'?'timed_out':'unavailable',
    code:error.code,retryable:error.code==='MODEL_QUEUE_FULL',calls:0,usage:{status:'unknown'}};
}
type Admission={memberId:string;payloadBytes:number;signal?:AbortSignal};
type Entry={memberId:string;payloadBytes:number;controller:AbortController;work:(signal:AbortSignal)=>Promise<unknown>;
  resolve:(value:unknown)=>void;reject:(error:unknown)=>void;cleanup:()=>void;timer?:ReturnType<typeof setTimeout>;
  done:boolean;pending:Set<Promise<unknown>>;drained:Promise<void>;drain:()=>void};

/** One application process: two admitted model operations, one per account. */
export function createModelBudget(limits:Partial<{waiting:number;waitingMs:number;waitingBytes:number}>={}) {
  const maximum={...MODEL_QUEUE_LIMITS,...limits};
  const context=new AsyncLocalStorage<Entry>(),active=new Set<Entry>(),waiting:Entry[]=[];
  let closed=false,waitingBytes=0;
  const eligible=(memberId:string)=>active.size<maximum.active&&![...active].some(entry=>entry.memberId===memberId);
  function release(entry:Entry){
    if(!entry.done||entry.pending.size||!active.delete(entry))return;
    entry.cleanup();entry.drain();dispatch();
  }
  function start(entry:Entry){
    if(entry.timer!==undefined)clearTimeout(entry.timer);
    active.add(entry);
    void Promise.resolve().then(()=>{
      if(entry.controller.signal.aborted)throw new ModelQueueError('MODEL_QUEUE_CANCELLED');
      return context.run(entry,()=>entry.work(entry.controller.signal));
    }).then(entry.resolve,entry.reject).finally(()=>{entry.done=true;release(entry);});
  }
  function dispatch(){
    if(closed)return;
    while(active.size<maximum.active){
      const index=waiting.findIndex(entry=>eligible(entry.memberId));
      if(index<0)return;
      const [entry]=waiting.splice(index,1);waitingBytes-=entry!.payloadBytes;start(entry!);
    }
  }
  function remove(entry:Entry,code:ModelQueueCode){
    const index=waiting.indexOf(entry);if(index<0)return;
    waiting.splice(index,1);waitingBytes-=entry.payloadBytes;
    if(entry.timer!==undefined)clearTimeout(entry.timer);
    entry.cleanup();entry.reject(new ModelQueueError(code));entry.drain();dispatch();
  }
  function run<T>(input:Admission,work:(signal:AbortSignal)=>Promise<T>):Promise<T>{
    if(closed)return Promise.reject(new ModelQueueError('MODEL_QUEUE_CLOSED'));
    if(input.signal?.aborted)return Promise.reject(new ModelQueueError('MODEL_QUEUE_CANCELLED'));
    if(!Number.isSafeInteger(input.payloadBytes)||input.payloadBytes<0)throw new Error('Invalid model payload size.');
    dispatch();
    const immediate=eligible(input.memberId);
    if(!immediate&&(waiting.length>=maximum.waiting||input.payloadBytes>maximum.waitingBytes-waitingBytes))
      return Promise.reject(new ModelQueueError('MODEL_QUEUE_FULL'));
    return new Promise<T>((resolve,reject)=>{
      let drain!:()=>void;const drained=new Promise<void>(done=>{drain=done;});
      const controller=new AbortController();
      const entry:Entry={memberId:input.memberId,payloadBytes:input.payloadBytes,controller,work,
        resolve:value=>resolve(value as T),reject,done:false,pending:new Set(),drained,drain,cleanup:()=>input.signal?.removeEventListener('abort',abort)};
      const abort=()=>{controller.abort();remove(entry,'MODEL_QUEUE_CANCELLED');};
      input.signal?.addEventListener('abort',abort,{once:true});
      if(immediate)start(entry);
      else {waiting.push(entry);waitingBytes+=entry.payloadBytes;entry.timer=setTimeout(()=>remove(entry,'MODEL_QUEUE_TIMEOUT'),maximum.waitingMs);}
    });
  }
  function track<T>(call:()=>Promise<T>):Promise<T>{
    const entry=context.getStore();
    if(!entry||entry.done||entry.controller.signal.aborted)
      throw new ProviderCallNotStartedError('cancelled','Model dispatch has no live admission');
    const promise=call();entry.pending.add(promise);
    // Never race the physical upstream against abort here. The caller may stop
    // promptly, but this lease remains occupied until the real promise settles.
    void promise.then(()=>{entry.pending.delete(promise);release(entry);},()=>{entry.pending.delete(promise);release(entry);});
    return promise;
  }
  async function close(){
    closed=true;
    for(const entry of [...waiting])remove(entry,'MODEL_QUEUE_CLOSED');
    const running=[...active];for(const entry of running)entry.controller.abort();
    await Promise.all(running.map(entry=>entry.drained));
  }
  return {run,track,close,status:()=>({active:active.size,waiting:waiting.length,waitingBytes,closed})};
}
export type ModelBudget=ReturnType<typeof createModelBudget>;

const wrapped=new WeakMap<CompatibleTransport,ModelBudget>();
export function budgetedTransport(transport:CompatibleTransport,budget:ModelBudget):CompatibleTransport {
  if(wrapped.get(transport)===budget)return transport;
  const result:CompatibleTransport={
    complete:input=>budget.track(()=>{assertDispatch(input.signal);return transport.complete(input);}),
    test:input=>budget.track(()=>{assertDispatch(input.signal);return transport.test(input);}),
  };
  wrapped.set(result,budget);return result;
}

/** Also retain a directly injected provider's actual promise, before engine cancellation races it. */
export function budgetedProvider(provider:ModelProvider,budget:ModelBudget):ModelProvider {
  return {generate:request=>budget.track(()=>{assertDispatch(request.signal);return provider.generate(request);})};
}
function assertDispatch(signal:AbortSignal){
  if(signal.aborted)throw new ProviderCallNotStartedError('cancelled','Model stopped before dispatch');
}

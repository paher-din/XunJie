/** A network idle window, renewed by received bytes; never a total thinking budget. */
export const PERSONAL_MODEL_IDLE_MS=600_000;
export type InactivityGuard={signal:AbortSignal;touch():void;readonly expired:boolean;dispose():void};
export function inactivityGuard(parent:AbortSignal,milliseconds=PERSONAL_MODEL_IDLE_MS):InactivityGuard{
  const controller=new AbortController();
  let timer:ReturnType<typeof setTimeout>|undefined,expired=false;
  const abort=()=>controller.abort(parent.reason);
  parent.addEventListener('abort',abort,{once:true});
  function touch(){
    if(timer)clearTimeout(timer);
    if(controller.signal.aborted)return;
    timer=setTimeout(()=>{expired=true;controller.abort();},milliseconds);
  }
  if(parent.aborted)abort();else touch();
  return {signal:controller.signal,touch,get expired(){return expired;},dispose(){if(timer)clearTimeout(timer);parent.removeEventListener('abort',abort);}};
}

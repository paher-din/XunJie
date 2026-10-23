// Diagnostic loader for one explicit local patch. Never installed into or used by a running service.
import {registerHooks,stripTypeScriptTypes} from 'node:module';
import {readFileSync} from 'node:fs';
const original='file:///opt/xunjie/candidates/133-c896c52/apps/teaching/server/db/records-adapter.ts';
registerHooks({load(url,context,next){
  if(url===original)return {format:'module',source:stripTypeScriptTypes(readFileSync('/var/lib/xunjie/capacity-133/perf-0f7e1a3b/patched-records-adapter.ts','utf8')),
    shortCircuit:true};
  return next(url,context);
}});

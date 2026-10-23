// Isolated-copy diagnostic only. Never imported by a managed service or installed in an artifact root.
import './capacity-profile-patch.mjs';
import {registerHooks,stripTypeScriptTypes} from 'node:module';
import {readFileSync} from 'node:fs';
const root='file:///opt/xunjie/candidates/133-c896c52/apps/teaching/';
const patches=new Map([
  [root+'server/workspace/storage.ts','patched-workspace-storage.ts'],
  [root+'server/app/teacher-workbench.ts','patched-teacher-workbench.ts'],
]);
registerHooks({load(url,context,next){
  const file=patches.get(url);
  if(file)return {format:'module',source:stripTypeScriptTypes(readFileSync('/var/lib/xunjie/capacity-133/perf-0f7e1a3b/'+file,'utf8')),shortCircuit:true};
  return next(url,context);
}});

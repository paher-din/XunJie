import type { ExecutionActionV3 } from '@xunjie/contracts/execution'
import type { ExecutionAdapter } from '../adapter'
import { verifiedIcarus,icarusProfile } from '../icarus-runtime'
import { ExecutionError } from '../errors'

export type RuntimeResourceLoader=(action:ExecutionActionV3)=>Promise<Record<string,Uint8Array>>
export function aluControls(value:unknown): Record<'A'|'B'|'M'|'S'|'Cin',number> {
  if(!value || typeof value!=='object' || Array.isArray(value)) throw new Error('invalid-input')
  const input=value as Record<string,number>, limits={A:15,B:15,M:1,S:3,Cin:1}
  if(Object.keys(input).length!==5 || Object.entries(limits).some(([key,max])=>!Number.isInteger(input[key]) || input[key]<0 || input[key]>max)) throw new Error('invalid-input')
  return {A:input.A,B:input.B,M:input.M,S:input.S,Cin:input.Cin}
}
export function createAluAdapter(load:RuntimeResourceLoader):ExecutionAdapter {
  const runtimes=new Map<string,Awaited<ReturnType<typeof verifiedIcarus>>>()
  return {adapterId:icarusProfile.adapterId,adapterVersion:icarusProfile.adapterVersion,protocolVersion:3,
    handles:a=>a.protocolVersion===3 && a.execution.operation.operationId===icarusProfile.operationId,
    validateAndFreeze(action) {
      if(action.protocolVersion!==3) throw new ExecutionError('invalid-input','需要 v3 固定依据。')
      aluControls(action.execution.parameters)
      if(action.execution.limits.memoryMiB!==icarusProfile.memoryMiB)throw new ExecutionError('invalid-input','本运行包固定为每模块 256 MiB，不能声明未实现的内存限制。')
    },
    async run(action,context) {
      if(action.protocolVersion!==3) throw new ExecutionError('invalid-input','需要 v3 固定依据。')
      const {basis,limits}=action.execution, inputs=aluControls(action.execution.parameters)
      const resources=await load(action);await context.checkpoint()
      const verified=await verifiedIcarus(basis.runtime.bundleIdentity,resources)
      const runtime=runtimes.get(basis.runtime.bundleIdentity)??verified
      runtimes.set(basis.runtime.bundleIdentity,runtime)
      const scaffold=basis.runtime.resources.find(r=>r.resourceId===basis.observation.scaffoldResourceId)
      if(!scaffold || !resources[scaffold.path]) throw new ExecutionError('resource-unavailable','缺少固定采样支架。')
      const sources=basis.works.filter(f=>f.kind==='code' && /\.(sv|v|svh|vh)$/.test(f.name)).map(f=>({path:f.name,content:f.value}))
      if(sources.some(f=>f.path===scaffold.path)) throw new ExecutionError('invalid-input','作品不能覆盖只读支架。')
      sources.push({path:scaffold.path,content:new TextDecoder('utf-8',{fatal:true}).decode(resources[scaffold.path])})
      let budgetExpired=false
      const abort=new AbortController(), stop=()=>abort.abort(), timer=setTimeout(()=>{budgetExpired=true;stop()},limits.jobTimeoutMs)
      context.signal.addEventListener('abort',stop,{once:true})
      if(context.signal.aborted) stop()
      try {
        const compiled=await runtime.compile({top:basis.compile.top,sources,entryFiles:[...basis.compile.entryFiles,scaffold.path],
          options:{includeDirs:basis.compile.includeDirs,strictExprWidth:basis.compile.strictExprWidth}}, {signal:abort.signal,timeoutMs:limits.compileTimeoutMs})
        if(compiled.status!=='completed') throw new ExecutionError(budgetExpired?'budget-exceeded':compiled.status==='stopped'?'worker-terminated':compiled.status==='budget-exceeded'?'budget-exceeded':'algorithm-error',
          ['编译未完成',...(compiled.diagnostics??[])].join('\n'),[{name:'failure.json',mediaType:'application/json',text:JSON.stringify({stage:compiled.stage,inputs})},
            {name:'diagnostics.txt',mediaType:'text/plain',text:(compiled.diagnostics??[]).join('\n')}])
        await context.checkpoint()
        const result=await runtime.simulate({artifact:compiled.artifact,plusargs:Object.entries(inputs).map(([k,v])=>`+${k}=${v}`),expectedIndices:[0]},
          {signal:abort.signal,timeoutMs:limits.simulateTimeoutMs})
        if(result.status!=='completed') throw new ExecutionError(budgetExpired?'budget-exceeded':result.status==='stopped'?'worker-terminated':result.status==='budget-exceeded'?'budget-exceeded':'algorithm-error',
          ['仿真未完成',...(result.diagnostics??[])].join('\n'),[{name:'failure.json',mediaType:'application/json',text:JSON.stringify({stage:result.stage,code:result.code,inputs})},
            {name:'diagnostics.txt',mediaType:'text/plain',text:(result.diagnostics??[]).join('\n')}])
        const row=result.observations[0], output={f:row && !('invalid' in row)?row.f:'',cout:row && !('invalid' in row)?row.cout:'',observationState:result.observationState}
        const produced=[{name:'observation.json',mediaType:'application/json',text:JSON.stringify({inputs,...output,dependencyId:result.dependencyId})},
          {name:'diagnostics.txt',mediaType:'text/plain',text:[...compiled.diagnostics,...result.diagnostics,...result.output].join('\n')},
          ...(result.vcd===null?[]:[{name:'trace.vcd',mediaType:'text/plain',text:result.vcd}])]
        const size=(text:string)=>new TextEncoder().encode(text).length
        if(size(produced[1].text)>limits.textBytes || size(result.vcd??'')>limits.vcdBytes || produced.reduce((n,r)=>n+size(r.text),0)>limits.resultBytes)
          throw new ExecutionError('budget-exceeded','结果超过已声明预算。')
        return {output,resources:produced,diagnostics:result.diagnostics}
      } finally { clearTimeout(timer);context.signal.removeEventListener('abort',stop) }
    }}
}

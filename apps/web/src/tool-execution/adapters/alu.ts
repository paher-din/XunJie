import type { ExecutionActionV3 } from '@xunjie/contracts/execution'
import { isAluCodeWork } from '@xunjie/contracts/alu-learning'
import type { AdapterContext, ExecutionAdapter, ResultResource } from '../adapter'
import { verifiedIcarus, icarusProfile, aluOperationIds, type AluOperationId } from '../icarus-runtime'
import { ExecutionError, type ExecutionErrorCode } from '../errors'
import { analyzeCheck, CHECK_ROUNDS, type CheckAnalysis, type CheckRoundResult } from './alu-check'

export type RuntimeResourceLoader=(action:ExecutionActionV3)=>Promise<Record<string,Uint8Array>>
export function aluControls(value:unknown): Record<'A'|'B'|'M'|'S'|'Cin',number> {
  if(!value || typeof value!=='object' || Array.isArray(value)) throw new Error('invalid-input')
  const input=value as Record<string,number>, limits={A:15,B:15,M:1,S:3,Cin:1}
  if(Object.keys(input).length!==5 || Object.entries(limits).some(([key,max])=>!Number.isInteger(input[key]) || input[key]<0 || input[key]>max)) throw new Error('invalid-input')
  return {A:input.A,B:input.B,M:input.M,S:input.S,Cin:input.Cin}
}
function checkParameters(value:unknown) {
  if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).length) throw new Error('invalid-input')
}
const textSize=(text:string)=>new TextEncoder().encode(text).length
const roundIndex=(round:CheckRoundResult)=>round.round
const logsOf=(result:{diagnostics?:string[];output?:string[]})=>[...(result.diagnostics??[]),...(result.output??[])]
function failureLog(lines:string[], limit:number) {
  const text=lines.join('\n'), bytes=new TextEncoder().encode(text)
  if(bytes.length<=limit) return text
  const suffix='\n[日志达到本次文本预算，后续内容未保留。]'
  const suffixBytes=new TextEncoder().encode(suffix)
  if(limit<suffixBytes.length) return new TextDecoder().decode(bytes.subarray(0,limit),{stream:true})
  return new TextDecoder().decode(bytes.subarray(0,limit-suffixBytes.length),{stream:true})+suffix
}

function codeOf(action:ExecutionActionV3) {
  return action.execution.basis.works.filter(isAluCodeWork)
}
function statusError(status:string, expired:boolean):ExecutionErrorCode {
  if(expired || status==='budget-exceeded') return 'budget-exceeded'
  if(status==='stopped') return 'worker-terminated'
  return 'algorithm-error'
}
async function underBudget<T>(action:ExecutionActionV3, context:AdapterContext,
  task:(signal:AbortSignal, expired:()=>boolean)=>Promise<T>):Promise<T> {
  const {limits}=action.execution
  const abort=new AbortController(); let cause:'stop'|'deadline'|undefined
  const interrupted=new Promise<never>((_resolve,reject)=>abort.signal.addEventListener('abort',()=>reject(abort.signal.reason),{once:true}))
  const stop=()=>{if(!cause){cause='stop';abort.abort(new ExecutionError('worker-terminated','用户请求停止。'))}}
  const timer=setTimeout(()=>{if(!cause){cause='deadline';abort.abort(new ExecutionError('budget-exceeded','整体执行时间预算已用尽。',[
    {name:'failure.json',mediaType:'application/json',text:JSON.stringify({stage:'job-deadline',jobTimeoutMs:limits.jobTimeoutMs,
      operation:action.execution.operation.operationId})},
  ]))}},limits.jobTimeoutMs)
  context.signal.addEventListener('abort',stop,{once:true})
  if(context.signal.aborted) stop()
  try { return await Promise.race([Promise.resolve().then(()=>{
    abort.signal.throwIfAborted()
    return task(abort.signal,()=>cause==='deadline')
  }),interrupted]) }
  finally { clearTimeout(timer);context.signal.removeEventListener('abort',stop) }
}

type IcarusRuntime = Awaited<ReturnType<typeof verifiedIcarus>>
interface CompiledCheck {
  runtime:IcarusRuntime
  compiled:Extract<Awaited<ReturnType<Awaited<ReturnType<typeof verifiedIcarus>>['compile']>>,{status:'completed'}>
  resources:Record<string,Uint8Array>
  scaffold:{path:string;content:string;sha256:string}
  diagnostics:string[]
}
const runtimes=new Map<string,Promise<IcarusRuntime>>()
/** A verified runtime keeps its disposable compile cache; the loader re-verifies every byte it returns. */
function runtimeFor(identity:string,resources:Record<string,Uint8Array>) {
  const saved=runtimes.get(identity)
  if(saved) return saved
  const pending=verifiedIcarus(identity,resources)
  runtimes.set(identity,pending)
  void pending.catch(()=>{ if(runtimes.get(identity)===pending) runtimes.delete(identity) })
  return pending
}
async function compileAction(action:ExecutionActionV3, context:AdapterContext, load:RuntimeResourceLoader,
  signal:AbortSignal, expired:()=>boolean):Promise<CompiledCheck> {
  const {basis,limits}=action.execution
  const resources=await load(action)
  signal.throwIfAborted()
  await context.checkpoint()
  const runtime=await runtimeFor(basis.runtime.bundleIdentity,resources)
  const scaffoldRef=basis.runtime.resources.find(resource=>resource.resourceId===basis.observation.scaffoldResourceId)
  if(!scaffoldRef || !resources[scaffoldRef.path]) throw new ExecutionError('resource-unavailable','缺少固定采样支架。')
  const scaffoldContent=new TextDecoder('utf-8',{fatal:true}).decode(resources[scaffoldRef.path])
  const sources=codeOf(action).map(file=>({path:file.name,content:file.value}))
  if(sources.some(file=>file.path===scaffoldRef.path)) throw new ExecutionError('invalid-input','作品不能覆盖只读支架。')
  sources.push({path:scaffoldRef.path,content:scaffoldContent})
  const compiled=await runtime.compile({top:basis.compile.top,sources,entryFiles:[...basis.compile.entryFiles,scaffoldRef.path],
    options:{includeDirs:basis.compile.includeDirs,strictExprWidth:basis.compile.strictExprWidth}},
    {signal,timeoutMs:limits.compileTimeoutMs})
  if(compiled.status!=='completed') throw new ExecutionError(statusError(compiled.status,expired()),
    ['编译未完成',...logsOf(compiled)].join('\n'),[
      {name:'failure.json',mediaType:'application/json',text:JSON.stringify({stage:compiled.stage,operation:action.execution.operation.operationId})},
      {name:'diagnostics.txt',mediaType:'text/plain',text:failureLog(logsOf(compiled),limits.textBytes)}])
  return {runtime,compiled,resources,scaffold:{path:scaffoldRef.path,content:scaffoldContent,sha256:scaffoldRef.sha256},
    diagnostics:compiled.diagnostics}
}

function assertSizes(resources:ResultResource[], limits:ExecutionActionV3['execution']['limits']) {
  const sizes=resources.map(resource=>textSize(resource.text))
  if(sizes[0]!==undefined && sizes[0]>1048576) throw new ExecutionError('output-too-large','主检查报告超过 1 MiB。')
  if(sizes.some(size=>size>8388608)) throw new ExecutionError('budget-exceeded','单个保留资源超过 8 MiB。')
  if(sizes.reduce((total,size)=>total+size,0)>limits.resultBytes) throw new ExecutionError('budget-exceeded','检查结果超过已声明预算。')
  const diagnostics=resources.find(resource=>resource.name==='diagnostics.txt')
  if(diagnostics && textSize(diagnostics.text)>limits.textBytes)
    throw new ExecutionError('budget-exceeded','诊断文本超过已声明预算。')
}

async function sha256Text(text:string) {
  const bytes=new TextEncoder().encode(text)
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('')
}

function summaryOf(analysis:CheckAnalysis) {
  return {verdict:analysis.verdict,totalInputs:analysis.totalInputs,plannedSamples:analysis.plannedSamples,
    sampledRows:analysis.sampledRows,comparedRows:analysis.comparedRows,behaviorErrorInputs:analysis.behaviorErrorInputs,
    unknownInputs:analysis.unknownInputs,inconsistentInputs:analysis.inconsistentInputs,missingInputs:analysis.missingInputs,
    roundsCompleted:analysis.roundsCompleted}
}

interface CheckSources {
  action:ExecutionActionV3
  compiled:CompiledCheck
  rounds:CheckRoundResult[]
  analysis:CheckAnalysis
  workDigests:Array<{name:string;contentId:string;sha256:string}>
  at:string
}
function reportOf(source:CheckSources) {
  const {action,compiled,rounds,analysis,workDigests,at}=source
  return {formatVersion:1,kind:'alu-check',createdAt:at,verdict:analysis.verdict,
    ...Object.fromEntries(Object.entries(summaryOf(analysis)).filter(([key])=>key!=='verdict')),
    reservedInputs:analysis.reservedInputs,reservedCovered:analysis.reservedCovered,
    fullySampledInputs:analysis.fullySampledInputs,fullyComparedInputs:analysis.fullyComparedInputs,
    formatErrors:analysis.formatErrors,duplicateRows:analysis.duplicateRows,outOfRange:analysis.outOfRange,
    reasons:analysis.reasons,counterexampleTotal:analysis.counterexampleTotal,
    counterexamples:analysis.counterexamples.slice(0,20),
    rounds:CHECK_ROUNDS.map(spec=>{const round=rounds.find(item=>item.round===spec.round)
      return {round:spec.round,precursor:spec.precursor,sampleTime:spec.sampleTime,status:round?.status??'missing',
        observationState:round?.observationState??'unavailable',rows:round?.rows.filter(row=>!('invalid' in row)).length??0,
        invalidRows:round?.rows.filter(row=>'invalid' in row).length??0,durationMs:round?.durationMs??0,
        vcdBytes:round?.vcd===null||round?.vcd===undefined?null:textSize(round.vcd)}}),
    source:{adapterId:icarusProfile.adapterId,adapterVersion:icarusProfile.adapterVersion,
      bundleIdentity:action.execution.basis.runtime.bundleIdentity,dependencyId:compiled.compiled.artifact.dependencyId,
      suiteVersion:1,scaffold:{path:compiled.scaffold.path,sha256:compiled.scaffold.sha256,version:action.execution.basis.observation.scaffoldVersion},
      rule:{version:1,digest:action.execution.basis.course.behaviorRuleDigest},works:workDigests}}
}
const validRow=(row:CheckRoundResult['rows'][number]):row is Exclude<CheckRoundResult['rows'][number],{invalid:string}>=>!('invalid' in row)
function observationsOf(source:CheckSources) {
  return {formatVersion:1,kind:'alu-check-observations',totalInputs:source.analysis.totalInputs,
    plannedSamples:source.analysis.plannedSamples,verdict:source.analysis.verdict,
    rounds:CHECK_ROUNDS.map(spec=>{const round=source.rounds.find(item=>item.round===spec.round)
      return {round:spec.round,precursor:spec.precursor,sampleTime:spec.sampleTime,status:round?.status??'missing',
        observationState:round?.observationState??'unavailable',durationMs:round?.durationMs??0,
        rows:round?.rows.filter(validRow).map(row=>[row.index,row.f,row.cout])??[],
        invalid:round?.rows.filter(row=>'invalid' in row).map(row=>row.invalid)??[]}}),
    counterexamples:source.analysis.counterexamples}
}
function tracesOf(rounds:CheckRoundResult[]) {
  return {formatVersion:1,kind:'alu-check-traces',rounds:CHECK_ROUNDS.map(spec=>{const round=rounds.find(item=>item.round===spec.round)
    return {round:spec.round,precursor:spec.precursor,sampleTime:spec.sampleTime,vcd:round?.vcd??null,
      vcdBytes:round?.vcd?textSize(round.vcd):null}})}
}
function diagnosticsOf(compiled:CompiledCheck, rounds:CheckRoundResult[], analysis?:CheckAnalysis) {
  const lines=[...compiled.diagnostics]
  for(const round of rounds) lines.push(`第 ${roundIndex(round)+1} 轮（${round.precursor}/T${round.sampleTime}）：${round.status}，${round.rows.length} 行`,...round.diagnostics)
  if(analysis) lines.push(`结论：${analysis.verdict}`,...analysis.reasons)
  return lines.join('\n')
}
async function checkResources(source:CheckSources):Promise<ResultResource[]> {
  return [
    {name:'check-report.json',mediaType:'application/json',text:JSON.stringify(reportOf(source))},
    {name:'check-observations.json',mediaType:'application/json',text:JSON.stringify(observationsOf(source))},
    {name:'diagnostics.txt',mediaType:'text/plain',text:diagnosticsOf(source.compiled,source.rounds,source.analysis)},
    {name:'check-traces.json',mediaType:'application/json',text:JSON.stringify(tracesOf(source.rounds))},
  ]
}

async function runSingle(action:ExecutionActionV3, context:AdapterContext, load:RuntimeResourceLoader) {
  const inputs=aluControls(action.execution.parameters)
  return underBudget(action,context,async(signal,expired)=>{
    const {runtime,compiled,diagnostics}=await compileAction(action,context,load,signal,expired)
    await context.checkpoint()
    const {limits}=action.execution
    const result=await runtime.simulate({artifact:compiled.artifact,plusargs:Object.entries(inputs).map(([key,value])=>`+${key}=${value}`),
      expectedIndices:[0]},{signal,timeoutMs:limits.simulateTimeoutMs})
    if(result.status!=='completed') throw new ExecutionError(statusError(result.status,expired()),
      ['仿真未完成',...logsOf(result)].join('\n'),[
        {name:'failure.json',mediaType:'application/json',text:JSON.stringify({stage:result.stage,code:result.code,inputs,operation:action.execution.operation.operationId})},
        {name:'diagnostics.txt',mediaType:'text/plain',text:failureLog([...diagnostics,...logsOf(result)],limits.textBytes)}])
    // An explicit run may enable a four-state observation, but a missing/incomplete sample cannot.
    if(result.observationState!=='complete' && result.observationState!=='complete-with-unknown')
      throw new ExecutionError('algorithm-error','观察不完整，未取得可启用的采样。',[
        {name:'failure.json',mediaType:'application/json',text:JSON.stringify({stage:result.stage,inputs,
          observationState:result.observationState,operation:action.execution.operation.operationId})},
        {name:'diagnostics.txt',mediaType:'text/plain',text:failureLog([...diagnostics,...logsOf(result)],limits.textBytes)}])
    const row=result.observations[0], output={f:row && !('invalid' in row)?row.f:'',cout:row && !('invalid' in row)?row.cout:'',
      observationState:result.observationState,...(action.execution.instance.stateVersion > 1
        ? {operationId:action.execution.operation.operationId,dependencyId:result.dependencyId} : {})}
    const produced:ResultResource[]=[{name:'observation.json',mediaType:'application/json',
      text:JSON.stringify({inputs,...output})},{name:'diagnostics.txt',mediaType:'text/plain',
      text:[...diagnostics,...result.diagnostics,...result.output].join('\n')},
      ...(result.vcd===null?[]:[{name:'trace.vcd',mediaType:'text/plain',text:result.vcd}])]
    if(textSize(produced[1]!.text)>limits.textBytes || textSize(result.vcd??'')>limits.vcdBytes
      || produced.reduce((total,resource)=>total+textSize(resource.text),0)>limits.resultBytes)
      throw new ExecutionError('budget-exceeded','结果超过已声明预算。')
    return {output,resources:produced,diagnostics:result.diagnostics}
  })
}

async function runCheck(action:ExecutionActionV3, context:AdapterContext, load:RuntimeResourceLoader) {
  return underBudget(action,context,async(signal,expired)=>{
    const compiled=await compileAction(action,context,load,signal,expired)
    const {limits}=action.execution, indices=Array.from({length:4096},(_,index)=>index)
    const rounds:CheckRoundResult[]=[]
    for(const spec of CHECK_ROUNDS) {
      await context.checkpoint()
      const started=performance.now()
      const result=await compiled.runtime.simulate({artifact:compiled.compiled.artifact,
        plusargs:[`+ROUND=${spec.precursor==='P1'?1:0}`,`+SAMPLE=${spec.sampleTime}`],expectedIndices:indices},
        {signal,timeoutMs:limits.simulateTimeoutMs})
      if(result.status!=='completed') {
        rounds.push({round:spec.round,precursor:spec.precursor,sampleTime:spec.sampleTime,status:result.status,
          observationState:'unavailable',rows:[],diagnostics:logsOf(result),
          durationMs:Math.round(performance.now()-started),vcd:null})
        const analysis=analyzeCheck(rounds)
        const partial:ResultResource[]=[
          {name:'check-report.json',mediaType:'application/json',text:JSON.stringify({...reportOf({action,compiled,rounds,analysis,
            workDigests:await Promise.all(codeOf(action).map(async file=>({name:file.name,contentId:file.contentId,sha256:await sha256Text(file.value)}))),
            at:new Date().toISOString()}),reason:`第 ${spec.round+1} 轮未完成：${result.status}`})},
          {name:'check-observations.json',mediaType:'application/json',text:JSON.stringify(observationsOf({action,compiled,rounds,analysis,
            workDigests:[],at:new Date().toISOString()}))},
          {name:'diagnostics.txt',mediaType:'text/plain',text:failureLog([diagnosticsOf(compiled,rounds,analysis)],limits.textBytes)},
        ]
        throw new ExecutionError(statusError(result.status,expired()),
          [`第 ${spec.round+1} 轮未完成`,...logsOf(result)].join('\n'),partial)
      }
      rounds.push({round:spec.round,precursor:spec.precursor,sampleTime:spec.sampleTime,status:'completed',
        observationState:result.observationState,rows:result.observations as CheckRoundResult['rows'],
        diagnostics:logsOf(result),durationMs:Math.round(performance.now()-started),vcd:result.vcd})
    }
    const analysis=analyzeCheck(rounds)
    const workDigests=await Promise.all(codeOf(action).map(async file=>({name:file.name,contentId:file.contentId,sha256:await sha256Text(file.value)})))
    const source:CheckSources={action,compiled,rounds,analysis,workDigests,at:new Date().toISOString()}
    const resources=await checkResources(source)
    const diagnostics=resources.find(resource=>resource.name==='diagnostics.txt')!
    if(textSize(diagnostics.text)>limits.textBytes) {
      const partial=resources.filter(resource=>resource.name!=='check-traces.json').map(resource=>resource===diagnostics
        ? {...resource,text:failureLog([resource.text],limits.textBytes)} : resource)
      assertSizes(partial,limits)
      throw new ExecutionError('budget-exceeded','累计日志超过文本预算；已保留报告、观察和预算内日志。',partial)
    }
    assertSizes(resources,limits)
    const vcdBytes=rounds.reduce((total,round)=>total+(round.vcd?textSize(round.vcd):0),0)
    if(vcdBytes>limits.vcdBytes) {
      const failure=[resources[0]!,resources[1]!,{name:'diagnostics.txt',mediaType:'text/plain',
        text:`${diagnosticsOf(compiled,rounds,analysis)}\nVCD 合计 ${vcdBytes} 字节超过 ${limits.vcdBytes} 字节。`}]
      throw new ExecutionError('budget-exceeded','VCD 合计超过已声明预算。',failure)
    }
    return {output:summaryOf(analysis),resources,diagnostics:[`检查结论：${analysis.verdict}`,...analysis.reasons]}
  })
}

export function createAluAdapter(load:RuntimeResourceLoader):ExecutionAdapter {
  return {adapterId:icarusProfile.adapterId,adapterVersion:icarusProfile.adapterVersion,protocolVersion:3,
    handles:action=>action.protocolVersion===3 && (aluOperationIds as readonly string[]).includes(action.execution.operation.operationId),
    validateAndFreeze(action) {
      if(action.protocolVersion!==3) throw new ExecutionError('invalid-input','需要 v3 固定依据。')
      const operation=action.execution.operation.operationId
      if(!(aluOperationIds as readonly string[]).includes(operation)) throw new ExecutionError('invalid-input','本 Adapter 不接受这个 ALU 操作。')
      if(operation==='check-all') checkParameters(action.execution.parameters)
      else aluControls(action.execution.parameters)
      if(action.execution.limits.memoryMiB!==icarusProfile.memoryMiB)
        throw new ExecutionError('invalid-input','本运行包固定为每模块 256 MiB，不能声明未实现的内存限制。')
      if(action.execution.basis.observation.ports.result!=='F' || action.execution.basis.observation.ports.carry!=='Cout')
        throw new ExecutionError('invalid-input','固定观察端口必须是 F/Cout。')
    },
    async run(action,context) {
      if(action.protocolVersion!==3) throw new ExecutionError('invalid-input','需要 v3 固定依据。')
      const operation=action.execution.operation.operationId as AluOperationId
      if(operation==='check-all') return runCheck(action,context,load)
      return runSingle(action,context,load)
    }}
}

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { SelectField } from '@xunjie/ui/foundation'
import { toast } from '@xunjie/ui/feedback'
import type { ComponentBinding } from '@xunjie/contracts/components'
import { componentStateName } from '@xunjie/contracts/components'
import type { LearningActivity } from '@xunjie/contracts/learning-data'
import { isTerminalExecutionState } from '@xunjie/contracts/execution'
import { useActivitySession } from '../../product/ActivitySession'
import { runtimePreparation } from '../../component-preparation/runtime'
import { runtimeAction } from '../../tool-execution/runtime-action'
import { readComponentState, componentStateMediaType } from '../../tool-execution/action'
import { ExecutionPanel } from '../../product/ExecutionPanel'
import { preparationMessage } from './preparation-message'

/** Registered runtime controls reuse the activity workspace and executor, including from the editor. */
export function LegacyAluExperimentTool({activity,binding,spaceKey,namespace,authorized,compact=false}:{
  activity:LearningActivity;binding:ComponentBinding;spaceKey:string;namespace:string;authorized:boolean;compact?:boolean
}) {
  const {workspace,execution}=useActivitySession(),work=useSyncExternalStore(workspace.subscribe,workspace.snapshot)
  const executions=useSyncExternalStore(execution.subscribe,execution.snapshot)
  const [ready,setReady]=useState(false),[note,setNote]=useState('正在准备实验环境…'),[attempt,setAttempt]=useState(0),[view,setView]=useState('')
  const [preparationDetails,setPreparationDetails]=useState('')
  const alive=useRef(true),frame=useRef<HTMLIFrameElement>(null),manifest=binding.definition.manifest
  useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[])
  useEffect(()=>{
    let active=true
    if(!authorized || workspace.isReadOnly()) return
    const target={activity,binding,spaceKey,namespace}
    void runtimePreparation.prepare(target,crypto.randomUUID()).then(async result=>{
      if(!active) return
      const message=preparationMessage(result)
      setReady(result.status==='ready');setNote(message.note)
      setPreparationDetails(message.details)
      if(result.status==='ready' && !compact) {
        const html=await runtimePreparation.entry(target)
        if(active) setView(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src data:; img-src data:; connect-src 'none'; worker-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'">${html}`)
      }
    }).catch(error=>{if(active)setNote(`实验准备未完成：${error instanceof Error?error.message:'存储不可用'}`)})
    return()=>{active=false}
  },[activity,binding,spaceKey,namespace,authorized,workspace,attempt,compact])
  if(manifest.formatVersion!==3) return null
  const instanceId=`${activity.activityId}:${binding.key}`,current=readComponentState(workspace,binding,instanceId)
  const values=current.content as Record<string,number>
  const running=executions.records.some(r=>r.action.execution.instance.instanceId===instanceId && r.query.statusKnowledge==='confirmed' && !isTerminalExecutionState(r.query.state))
  const canWrite=authorized && work.ready && work.files.some(f=>f.kind==='code') && !work.conflict && !workspace.isReadOnly() && !workspace.accessDenied()
  const change=(key:string,value:number)=>{
    try {
      const previous=readComponentState(workspace,binding,instanceId), file=previous.file
      workspace.change([...workspace.snapshot().files.filter(f=>f.objectId!==file?.objectId),{
        objectId:file?.objectId??crypto.randomUUID(),contentId:crypto.randomUUID(),name:componentStateName(binding.key),
        kind:'state',encoding:'json',mediaType:componentStateMediaType,value:JSON.stringify({formatVersion:1,instanceId,
          componentId:manifest.componentId,version:manifest.version,definitionDigest:binding.definition.digest,stateVersion:manifest.stateVersion,
          operationId:crypto.randomUUID(),content:{...previous.content as object,[key]:value}})}])
    } catch(error) {toast.error(error instanceof Error?error.message:'输入未能保护')}
  }
  const run=async()=>{
    if(!canWrite || !ready || running)return
    try {
      await workspace.trackInput((async()=>{
        const action=await runtimeAction(workspace,activity,binding,execution.receiver.identity.receiverId)
        await execution.submit(action)
      })())
    } catch(error){if(alive.current)toast.error(error instanceof Error?error.message:'本次未能运行')}
  }
  const last=executions.records.find(r=>r.action.execution.instance.instanceId===instanceId)
  const changed=last && (last.action.execution.basis.works.filter(f=>f.kind==='code').some(f=>!work.files.some(now=>now.objectId===f.objectId&&now.value===f.value&&now.name===f.name))
    ||work.files.filter(f=>f.kind==='code').some(f=>!last.action.execution.basis.works.some(previous=>previous.objectId===f.objectId)))
  const inputChanged=last && Object.keys(values).some(key=>(last.action.execution.parameters as Record<string,number>)[key]!==values[key])
  return <section className={`execution-panel runtime-tool ${compact?'runtime-tool-compact':'runtime-tool-full'}`} aria-label="ALU 单次实验">
    <div className="execution-actions">{Object.entries({A:4,B:4,M:1,S:2,Cin:1}).map(([key,width])=><label key={key}>{key}（{width} 位） <SelectField label={`${key}（${width} 位）`} disabled={!canWrite} value={String(values[key]??0)} onChange={value=>change(key,Number(value))}
      options={Array.from({length:2**width},(_,value)=>({value:String(value),label:value.toString(2).padStart(width,'0')}))} /></label>)}
    <button className="ws-btn solid" type="button" disabled={!canWrite||!ready||running} onClick={()=>void run()}>{running?'运行中…':'运行'}</button>
    {!ready && canWrite && <button className="ws-btn ghost" onClick={()=>setAttempt(a=>a+1)}>重试准备</button>}</div>
    {changed&&<p role="status">修改尚未运行，原观察对应上次运行的代码。</p>}
    {!changed&&inputChanged&&<p role="status">输入已改动，尚未运行；原观察保留它的原输入。</p>}
    {note&&<p role="status">{note}</p>}
    {!ready&&preparationDetails&&<details><summary>准备详情</summary><pre>{preparationDetails}</pre></details>}
    {!compact&&<details><summary>公开行为与采样规则</summary><p>A/B 为无符号 4 位；允许内置加法。逻辑模式忽略 Cin，NOT 还忽略 B。</p>
      <table><thead><tr><th>M</th><th>S</th><th>F</th><th>Cout</th></tr></thead><tbody>
        {['NOT A','A AND B','A OR B','A XOR B'].map((operation,i)=><tr key={operation}><td>0</td><td>{i.toString(2).padStart(2,'0')}</td><td>{operation}</td><td>0</td></tr>)}
        <tr><td>1</td><td>00</td><td>A + B + Cin 的低 4 位</td><td>完整和第 5 位</td></tr><tr><td>1</td><td>01 / 10 / 11</td><td>0（保留组合）</td><td>0</td></tr>
      </tbody></table></details>}
    {!compact&&view&&<details><summary>固定实验说明</summary><iframe ref={frame} title="固定实验说明" sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={view} onLoad={()=>{
      const channel=new MessageChannel();channel.port1.onmessage=()=>{};
      frame.current?.contentWindow?.postMessage({hostApiVersion:1,connectionId:crypto.randomUUID(),instanceId},'*',[channel.port2]);channel.port1.close()
    }}/></details>}
    {!compact&&<ExecutionPanel activity={activity} binding={binding} authorized={authorized}/>}
  </section>
}

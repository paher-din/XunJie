import type { RecordPresenter } from './model'
import {useEffect,useState} from 'react'
import {useActivitySession} from '../ActivitySession'
import type {ExecutionRecord} from '../../tool-execution/ledger'
import type {ExecutionRetainedResource} from '@xunjie/contracts/execution'
export const aluPresenter:RecordPresenter={id:'icarus-alu',artifactLabel:'下载原始观察',
  matches:action=>action.protocolVersion===3&&action.execution.basis.runtime.adapterId==='icarus-alu',
  Detail({record}) {
    return <AluRecord record={record}/>
  }}
function AluRecord({record}:{record:ExecutionRecord}) {
    const {execution}=useActivitySession(),[resources,setResources]=useState<ExecutionRetainedResource[]>([]),[error,setError]=useState(''),[expanded,setExpanded]=useState(false)
    useEffect(()=>{
      let live=true
      if(expanded&&record.query.output)void execution.artifact(record.requestId).then(result=>{if(live)setResources(result?.resources??[])}).catch(()=>{if(live)setError('原结果资源暂时不可读，未重新仿真。')})
      return()=>{live=false}
    },[execution,record.requestId,record.query.output,expanded])
    const parameters=record.action.execution.parameters as Record<string,number>
    const output=record.query.output?.output as {f?:string;cout?:string;observationState?:string}|undefined
    return <><p className="execution-hint">该次输入：{Object.entries(parameters).map(([key,value])=>`${key}=${value}`).join('，')}</p>
      {output ? <p>F：{output.f||'未取得'}　Cout：{output.cout||'未取得'}（{output.observationState==='complete'?'已取得观察':output.observationState==='complete-with-unknown'?'输出包含 X/Z':'观察不完整'}）</p>:null}
      {error&&<p role="alert">{error}</p>}
      <details onToggle={event=>setExpanded(event.currentTarget.open)}><summary>原依据与结果资源</summary>
        {record.action.execution.basis.works.filter(f=>f.kind==='code').map(f=><details key={f.contentId}><summary>{f.name}（该次运行的只读依据）</summary><pre>{f.value}</pre></details>)}
        {resources.map(resource=><div key={resource.contentId}>
          {resource.name==='diagnostics.txt'&&resource.text&&<pre>{resource.text}</pre>}
          <button className="ws-btn ghost" onClick={()=>{
            const url=URL.createObjectURL(new Blob([resource.text],{type:resource.mediaType})),anchor=document.createElement('a')
            anchor.href=url;anchor.download=resource.name;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000)
          }}>下载 {resource.name}</button>
        </div>)}
      </details></>
}

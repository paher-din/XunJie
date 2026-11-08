import { DesignValue, designValueLabels } from './DesignValue'
export type DesignAgentMode = 'candidates' | 'blueprint' | 'patch' | 'rubric_trial'
export interface DesignProposalDisplay {
  baseRevision: number
  body: {kind:DesignAgentMode;candidates?:Record<string,unknown>[];[key:string]:unknown}
  rationale:string; affectedReferences:string[]
  diff:{path:string;before:unknown;after:unknown}[]
}
export interface DesignAgentViewProps<Field extends string = string> {
  hasDraft:boolean;dirty:boolean;blocked:boolean;active:boolean;disabled:boolean;busy:boolean
  mode:DesignAgentMode;setMode:(value:DesignAgentMode)=>void
  request:string;setRequest:(value:string)=>void
  fields:Field[];setFields:(value:Field[])=>void;availableFields:readonly Field[]
  selected:string[];setSelected:(value:string[])=>void
  samples:string[];setSamples:(value:string[])=>void
  paragraphs:{paragraphId:string;title:string;ordinal:number;private:boolean;text:string}[]
  error:string;canRecover:boolean
  run:{jobId:string}|null;job:{status:string;failure?:string}|null
  restoreId:string;setRestoreId:(value:string)=>void
  proposal:DesignProposalDisplay|null;candidate:number|undefined;setCandidate:(value:number)=>void
  stale:boolean;canAdopt:boolean
  onGenerate:(recover?:boolean)=>void;onCancel:()=>void;onAdopt:()=>void;onReload:()=>void;onRestore:()=>void
}
export function DesignAgentView<Field extends string>({hasDraft,dirty,blocked,active,disabled,busy,mode,setMode,request,setRequest,
 fields,setFields,availableFields,selected,setSelected,samples,setSamples,paragraphs,error,canRecover,run,job,restoreId,setRestoreId,
 proposal,candidate,setCandidate,stale,canAdopt,onGenerate,onCancel,onAdopt,onReload,onRestore}:DesignAgentViewProps<Field>) {
  return <details className="tda-panel">
    <summary>AI 协助设计<span>候选由教师核对、选择采用</span></summary>
    <p className="td-hint">使用宿主获准的教师设计模型与独立预算。个人模型设置成功不代表设计预算已开放；预算关闭或服务不可用时会保留真实错误。</p>
    <fieldset className="td-fields" disabled={blocked || active}>
      <label className="td-field"><span className="td-field-title">设计协助类型</span><select value={mode} onChange={event => setMode(event.target.value as DesignAgentMode)}>
        {!hasDraft && <option value="candidates">起草项目候选</option>}
        <option value="blueprint">完整蓝图建议</option>
        {hasDraft && <><option value="patch">局部修改建议</option><option value="rubric_trial">样例试评量规</option></>}
      </select></label>
      <label className="td-field"><span className="td-field-title">给 AI 的设计要求</span><textarea maxLength={32000} rows={3} value={request} onChange={event => setRequest(event.target.value)} placeholder="课程目标、学生基础、时间约束、希望改进的部分……" /></label>
      {hasDraft && mode !== 'rubric_trial' && <fieldset className="tda-choices"><legend>允许修改的字段</legend>{availableFields.map(field => <label key={field}><input type="checkbox" checked={fields.includes(field)} onChange={event => setFields(event.target.checked ? [...fields, field] : fields.filter(item => item !== field))} />{designValueLabels[field]}</label>)}</fieldset>}
      <fieldset className="tda-choices tda-references"><legend>获准用于教师设计的材料段落（最多64段）</legend>
        {!paragraphs.length && <p className="td-hint">当前没有开放教师设计用途的材料，可先说明要求；量规试评需要获准样例。</p>}
        {paragraphs.map(paragraph => <div key={paragraph.paragraphId}><label><input type="checkbox" checked={selected.includes(paragraph.paragraphId)} disabled={!selected.includes(paragraph.paragraphId) && selected.length >= 64}
          onChange={event => { setSelected(event.target.checked ? [...selected, paragraph.paragraphId] : selected.filter(id => id !== paragraph.paragraphId)); setSamples(samples.filter(id => id !== paragraph.paragraphId)) }} />
          <span>{paragraph.title} · 段落{paragraph.ordinal + 1}{paragraph.private ? ' · 教师私有材料' : ''}<small>{paragraph.text.slice(0, 180)}</small></span></label>
          {mode === 'rubric_trial' && selected.includes(paragraph.paragraphId) && <label><input type="checkbox" checked={samples.includes(paragraph.paragraphId)} onChange={event => setSamples(event.target.checked ? [...samples, paragraph.paragraphId] : samples.filter(id => id !== paragraph.paragraphId))} />将此段作为教师认可的试评样例</label>}
        </div>)}
      </fieldset>
      <button type="button" className="td-btn" disabled={!request.trim()} onClick={() => { onGenerate() }}>提交设计请求</button>
    </fieldset>
    {hasDraft && dirty && <p role="status">请先保存人工编辑，再请求或采用基于该版本的建议。</p>}
    {error && <div className="td-notice tld-error" role="alert">{error} 结果未知时请核对原请求，不要另发新任务。</div>}
    {canRecover && <button type="button" className="td-btn" disabled={busy} onClick={() => { onGenerate(true) }}>核对原 AI 请求</button>}
    {run?.jobId && <div className="tda-job" role="status"><p>设计任务：{run.jobId}</p><p>状态：{job ? ({ queued: '排队中', running: '生成中', succeeded: '已取得候选', cancelling: '正在取消', cancelled: '已取消', failed: '失败', stale: '上下文已过时', timed_out: '已超时', outcome_unknown: '结果未知' }[job.status] ?? job.status) : '正在读取'}</p>{job?.failure && <p>原因：{job.failure}</p>}
      <button type="button" className="td-btn" disabled={busy} onClick={() => onReload()}>重新读取原任务</button>
      {active && <button type="button" className="td-btn" disabled={disabled || busy} onClick={() => { onCancel() }}>取消设计任务</button>}
    </div>}
    <details className="tda-restore"><summary>恢复已有设计任务</summary><label className="td-field"><span className="td-field-title">原设计任务 ID</span><input value={restoreId} maxLength={128} onChange={event => setRestoreId(event.target.value)} /></label><button type="button" className="td-btn" disabled={busy || active || !restoreId.trim()} onClick={() => {
      onRestore()
    }}>读取已有任务</button></details>
    {proposal && <section className="tda-proposal" aria-label="模型设计候选">
      <h2>模型设计候选 · 基础版本 {proposal.baseRevision}</h2>
      <p>候选不是正式教学决定，也不会直接分配给学生。</p>
      {proposal.body.kind === 'candidates' ? proposal.body.candidates?.map((item, index) => <article key={index}><label className="tld-checkbox"><input type="radio" name="design-candidate" checked={candidate === index} onChange={() => setCandidate(index)} />选择候选 {index + 1}</label><DesignValue value={item} /></article>) : <DesignValue value={Object.fromEntries(Object.entries(proposal.body).filter(([key]) => key !== 'kind'))} />}
      {proposal.rationale && <p>建议理由：{proposal.rationale}</p>}
      <details><summary>依据与受影响项</summary><DesignValue value={proposal.affectedReferences} /></details>
      {proposal.diff.length > 0 && <details><summary>与原版本的差异</summary>{proposal.diff.map((item, index) => <div className="tda-diff" key={index}><h3>{designValueLabels[item.path] ?? item.path}</h3><div><strong>原内容</strong><DesignValue value={item.before} /></div><div><strong>候选内容</strong><DesignValue value={item.after} /></div></div>)}</details>}
      {stale && <p className="tld-error" role="status">候选已过时或期间发生人工编辑，不能覆盖当前设计。候选保留供对照。</p>}
      {proposal.body.kind === 'rubric_trial' ? <p>试评仅供教师判断。请在“里程碑与量规”中明确修订、记录歧义及处理方式，再保存和检查。</p>
        : <><p>采用基础字段并保留已选课程配置；文字目标、量规等结构建议仍需教师补齐关联并通过设计检查。</p><button type="button" className="td-btn td-btn-primary" disabled={!canAdopt} onClick={() => { onAdopt() }}>{hasDraft ? '采用允许字段到草稿新版本' : '采用为新草稿'}</button></>}
    </section>}
  </details>
}

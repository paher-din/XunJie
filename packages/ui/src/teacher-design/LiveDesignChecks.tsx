import { Icon } from '../icons'
import { LiveDesignField as Field } from './controls'
import type { LiveConcernDisplay } from './types'
const blockingNames: Record<string, string> = {
  missing_field: '内容尚未补齐', missing_domain: '缺少能力线', missing_goal_observation: '核心目标缺少观察安排',
  missing_link: '缺少关联', duplicate_reference: '引用重复', invalid_reference: '引用已失效', inconsistent_goal_link: '目标关联不一致',
  unavailable_resource: '材料版本不可用', forbidden_resource: '材料用途权限不允许', missing_version: '缺少已确认的政策或规则', runtime_not_ready: '执行环境未就绪',
}

export interface LiveDesignChecksProps {
 ready:boolean;checksCurrent:boolean;version:string
 report:{blocking:{code:string;path:string}[];designConcerns:{status:string}[];execution?:{kind:string}}|null
 concerns:LiveConcernDisplay[]
 concernKinds:{code:LiveConcernDisplay['code'];title:string;path:string}[]
 locked:boolean;dirty:boolean;remoteChanged:boolean
 released:{sourceRevision:number}|null;draft:{revision:number}|undefined
 onBlockingSelect:(path:string)=>void
 onConcernChange:(code:LiveConcernDisplay['code'],field:'reason'|'resolution',value:string)=>void
 onCheck:()=>void;onPreview:()=>void
}
export function LiveDesignChecks({ready,checksCurrent:current,version,report,concerns,concernKinds,locked,dirty,remoteChanged,released,draft,
 onBlockingSelect,onConcernChange,onCheck,onPreview}:LiveDesignChecksProps) {
 const checksCurrent = !!report && current
 return (<aside className="td-rail" aria-label="设计检查与分配"><div className="td-checks"><div className={`td-check-summary${ready ? ' is-ready' : ''}`}><Icon name={ready ? 'check-circle' : 'checklist'} size={28} /><h3>{ready ? '已通过结构检查' : checksCurrent ? '还有设计需要补齐' : '保存后，检查这份设计'}</h3><p>{checksCurrent ? `${version} 的真实服务端检查结果。` : '编辑或设计疑点变化后，需要重新检查。'}</p></div>
        <div className="td-check-group"><div className="td-check-group-title"><span className="td-check-dot block" /><strong>阻断项</strong><span>{checksCurrent ? report.blocking.length : '—'}</span></div>{checksCurrent && report.blocking.length ? report.blocking.map((item, index) => <button type="button" className="td-check-item" key={`${item.path}:${index}`} onClick={() => onBlockingSelect(item.path)}><span>{blockingNames[item.code] ?? item.code}<small className="tld-path">{item.path}</small></span><Icon name="alt-arrow-right" /></button>) : <p>{checksCurrent ? '没有结构阻断。' : '尚无当前版本的检查结果。'}</p>}</div>
        <div className="td-check-group"><div className="td-check-group-title"><span className="td-check-dot question" /><strong>设计疑点</strong><span>{concerns.length}</span></div><p>意义、难度和量规是否合适，由教师判断。可记录试评发现与处理方式。</p><fieldset className="td-fields" disabled={locked}>{concernKinds.map(kind => { const concern = concerns.find(c => c.code === kind.code); const update = (field: 'reason' | 'resolution', value: string) => onConcernChange(kind.code, field, value); return <details className="tld-concern" key={kind.code}><summary>{kind.title}{concern ? ' · 已记录' : ''}</summary><Field title={`${kind.title}：发现的疑点`}><textarea rows={2} value={concern?.reason ?? ''} onChange={event => update('reason', event.target.value)} /></Field><Field title={`${kind.title}：处理方式`}><textarea rows={2} value={concern?.resolution ?? ''} onChange={event => update('resolution', event.target.value)} /></Field></details> })}</fieldset>{checksCurrent && report.designConcerns.some(c => c.status === 'requires_teacher') && <p className="tld-error">请补充上述疑点的处理方式后重新检查。</p>}</div>
        <div className="td-check-group"><div className="td-check-group-title"><span className="td-check-dot pending" /><strong>待验证</strong><span>2</span></div><p>学习效果与工作量估计仍为未知。结构检查与执行环境就绪不代表教学效果。</p>{report?.execution && <p>数字逻辑配置结构已核对；实际电路行为仍需验证。</p>}</div>
        <button type="button" className="td-btn td-check-preview" disabled={locked || dirty || remoteChanged} onClick={() => { onCheck() }}>运行设计检查</button><button type="button" className="td-btn td-btn-primary td-check-preview tld-preview-button" disabled={locked || !ready || released?.sourceRevision === draft?.revision} onClick={() => { onPreview() }}>预览并确认版本<Icon name="arrow-right" /></button>
      </div><div className="td-rail-footnote"><Icon name="lock-keyhole" /><span>真实保存与分配使用当前账号、课程及恢复代际。</span></div></aside>)
}

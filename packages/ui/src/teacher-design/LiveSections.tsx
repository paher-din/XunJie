import { Icon, IconText } from '../icons'
import { LiveDesignField as Field, DesignLinkedChoices as LinkedChoices, DesignRepeatHeading, DesignAnchor } from './controls'
import { liveDesignDomains as domains } from './constants'
import type { DesignLinkComponent, GoalReferenceDisplay as GoalRef, LiveGoalDisplay as Goal, LiveContentDisplay } from './types'
export interface LiveSectionsProps {
 content:LiveContentDisplay;patch:<K extends keyof LiveContentDisplay>(key:K,value:LiveContentDisplay[K])=>void
 uid:()=>string;draft:{revision:number}|undefined;courseId:string;presetId:string
 data:{courses:{id:string;title:string}[]}
 workbench:{presets:{id:string;title:string}[];resources:{resourceVersionId:string;teacherDesignAllowed:boolean;material:{kind:'learning_material'|'private_answer'|'validation_asset';title:string;visibility:{student:boolean;tutor:boolean}}}[]}
 selectedPreset:unknown;policy:{description:string;helpAllowed:boolean}|undefined
 setPresetId:(value:string)=>void;onCourseChange:(value:string)=>void;onApplyPreset:()=>void
 changeGoal:(id:string,patch:Partial<Goal>)=>void
 resolveGoalRefs:(refs:GoalRef[],ids:string[])=>GoalRef[]
 canRemoveGoal:(id:string)=>boolean;canRemoveTask:(id:string)=>boolean;canRemoveObservation:(id:string)=>boolean
 base:string;Link?:DesignLinkComponent
}
function repeatedTitle(title:string,index:number,removable:boolean,onRemove:()=>void) {return <DesignRepeatHeading title={title} index={index} removable={removable} onRemove={onRemove} />}
export type LiveBriefSectionProps=Pick<LiveSectionsProps,'content'|'patch'|'draft'|'courseId'|'presetId'|'data'|'workbench'|'selectedPreset'|'setPresetId'|'onCourseChange'|'onApplyPreset'>
export function LiveBriefSection({content,patch,draft,courseId,presetId,data,workbench,selectedPreset,setPresetId,onCourseChange,onApplyPreset}:LiveBriefSectionProps){
 function textField(key:'projectTitle'|'problem'|'audience'|'artifact'|'studentBackground'|'timeConstraints',title:string,rows?:number) {
 return <Field title={title}>{rows ? <textarea rows={rows} value={content[key]??''} onChange={event=>patch(key,event.target.value)} /> : <input value={content[key]??''} onChange={event=>patch(key,event.target.value)} />}</Field>
 }

 return (<>
          <div className="td-form-pair"><Field title="任教课程"><select value={courseId} disabled={!!draft} onChange={event => onCourseChange(event.target.value)}>{data.courses.map(c => <option value={c.id} key={c.id}>{c.title}</option>)}</select></Field><Field title="已确认的课程范例" hint="范例沿用本课程已确认的帮助、检查与运行配置。"><select value={presetId} disabled={!!draft} onChange={event => setPresetId(event.target.value)}>{!workbench.presets.length && <option value="">暂无已确认范例</option>}{workbench.presets.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}</select></Field></div>
          {!draft && <div className="tld-preset-note"><p>当前起点来自真实课程范例。更换范例会替换本页尚未保存的设计。</p><button type="button" className="td-btn" disabled={!selectedPreset} onClick={onApplyPreset}>应用所选范例</button></div>}
          {textField('projectTitle', '项目标题')}{textField('problem', '驱动问题', 4)}<div className="td-form-pair">{textField('audience', '项目受众', 2)}{textField('artifact', '最终产物', 2)}</div><Field title="留给学生的选择空间" hint="每行一条可选择路线。"><textarea rows={3} value={content.routes.join('\n')} onChange={event => patch('routes', event.target.value.split('\n'))} /></Field>{textField('studentBackground', '前置基础', 3)}{textField('timeConstraints', '时间与资源限制', 2)}
        </>)
}
export type LiveGoalsSectionProps=Pick<LiveSectionsProps,'content'|'patch'|'uid'|'changeGoal'|'resolveGoalRefs'|'canRemoveGoal'|'canRemoveTask'|'canRemoveObservation'>
export function LiveGoalsSection({content,patch,uid,changeGoal,resolveGoalRefs,canRemoveGoal,canRemoveTask,canRemoveObservation}:LiveGoalsSectionProps){

 const linkedGoals=(refs:GoalRef[],onChange:(value:GoalRef[])=>void)=><LinkedChoices title="关联目标" options={content.goals.map(g=>({id:g.competencyId,title:`${domains.find(d=>d.id===g.domain)?.title} · ${g.title||'目标待补充'}`}))} value={refs.map(g=>g.competencyId)} onChange={ids=>onChange(resolveGoalRefs(refs,ids))} />
 const taskOptions=content.tasks.map(task=>({id:task.taskId,title:task.title}));
 return (<>
          <div className="td-inline-note"><Icon name="lightbulb" /><p>目标、任务与观察分别编辑。改动目标内容会形成新的目标版本，并同步本设计中的引用；原有活动保持固定。</p></div>
          {content.goals.map((goal, index) => <div className="td-repeat" key={goal.competencyId}>{repeatedTitle('学习目标', index, canRemoveGoal(goal.competencyId), () => patch('goals', content.goals.filter(g => g.competencyId !== goal.competencyId)))}<div className="td-form-pair"><Field title="能力线"><select value={goal.domain} onChange={event => changeGoal(goal.competencyId, { domain: event.target.value as Goal['domain'] })}>{domains.map(domain => <option value={domain.id} key={domain.id}>{domain.title}</option>)}</select></Field><Field title="目标版本"><input readOnly value={`v${goal.competencyVersion}`} /></Field></div><Field title="学习目标"><textarea rows={2} value={goal.title} onChange={event => changeGoal(goal.competencyId, { title: event.target.value })} /></Field><label className="tld-checkbox"><input type="checkbox" checked={goal.core} onChange={event => changeGoal(goal.competencyId, { core: event.target.checked })} />核心目标，需要关联可观察表现</label></div>)}
          <button type="button" className="td-add" onClick={() => patch('goals', [...content.goals, { competencyId: uid(), competencyVersion: 1, title: '', domain: 'domain', core: true }])}><IconText name="add">添加学习目标</IconText></button>
          <div className="td-subheading td-subheading-separated"><h3>实践任务</h3><p>每个任务关联对应目标，让学生知道为什么做。</p></div>
          {content.tasks.map((task, index) => <div className="td-repeat" key={task.taskId}>{repeatedTitle('实践任务', index, canRemoveTask(task.taskId), () => patch('tasks', content.tasks.filter(t => t.taskId !== task.taskId)))}<Field title="任务名称"><input value={task.title} onChange={event => patch('tasks', content.tasks.map(t => t.taskId === task.taskId ? { ...t, title: event.target.value } : t))} /></Field>{linkedGoals(task.goalRefs, refs => patch('tasks', content.tasks.map(t => t.taskId === task.taskId ? { ...t, goalRefs: refs } : t)))}</div>)}
          <button type="button" className="td-add" onClick={() => patch('tasks', [...content.tasks, { taskId: uid(), title: '', goalRefs: [] }])}><IconText name="add">添加实践任务</IconText></button>
          <div className="td-subheading td-subheading-separated"><h3>可观察表现</h3><p>描述凭什么判断，关联产生表现的任务与目标。</p></div>
          {content.observations.map((observation, index) => <div className="td-repeat" key={observation.observationId}>{repeatedTitle('可观察表现', index, canRemoveObservation(observation.observationId), () => patch('observations', content.observations.filter(o => o.observationId !== observation.observationId)))}<Field title="表现与证据描述"><textarea rows={3} value={observation.description} onChange={event => patch('observations', content.observations.map(o => o.observationId === observation.observationId ? { ...o, description: event.target.value } : o))} /></Field>{linkedGoals(observation.goalRefs, refs => patch('observations', content.observations.map(o => o.observationId === observation.observationId ? { ...o, goalRefs: refs } : o)))}<LinkedChoices title="来自哪些实践任务" options={taskOptions} value={observation.taskIds} onChange={ids => patch('observations', content.observations.map(o => o.observationId === observation.observationId ? { ...o, taskIds: ids } : o))} /></div>)}
          <button type="button" className="td-add" onClick={() => patch('observations', [...content.observations, { observationId: uid(), description: '', goalRefs: [], taskIds: [] }])}><IconText name="add">添加可观察表现</IconText></button>
        </>)
}
export type LiveMilestonesSectionProps=Pick<LiveSectionsProps,'content'|'patch'|'uid'|'resolveGoalRefs'>
export function LiveMilestonesSection({content,patch,uid,resolveGoalRefs}:LiveMilestonesSectionProps){

 const linkedGoals=(refs:GoalRef[],onChange:(value:GoalRef[])=>void)=><LinkedChoices title="关联目标" options={content.goals.map(g=>({id:g.competencyId,title:`${domains.find(d=>d.id===g.domain)?.title} · ${g.title||'目标待补充'}`}))} value={refs.map(g=>g.competencyId)} onChange={ids=>onChange(resolveGoalRefs(refs,ids))} />
 const taskOptions=content.tasks.map(task=>({id:task.taskId,title:task.title}));
 return (<>
          <div className="td-subheading"><h3>学习里程碑</h3><p>允许回看修订，每一步关联实际任务。</p></div>{content.milestones.map((milestone, index) => <div className="td-repeat" key={milestone.milestoneId}>{repeatedTitle('里程碑', index, true, () => patch('milestones', content.milestones.filter(m => m.milestoneId !== milestone.milestoneId)))}<Field title="里程碑名称"><input value={milestone.title} onChange={event => patch('milestones', content.milestones.map(m => m.milestoneId === milestone.milestoneId ? { ...m, title: event.target.value } : m))} /></Field><LinkedChoices title="包含的实践任务" options={taskOptions} value={milestone.taskIds} onChange={ids => patch('milestones', content.milestones.map(m => m.milestoneId === milestone.milestoneId ? { ...m, taskIds: ids } : m))} /></div>)}<button type="button" className="td-add" onClick={() => patch('milestones', [...content.milestones, { milestoneId: uid(), title: '', taskIds: [] }])}><IconText name="add">添加里程碑</IconText></button>
          <div className="td-subheading td-subheading-separated"><h3>评价量规</h3><p>评价依据指向观察，三条能力线保持各自的证据。</p></div>{content.rubricCriteria.map((criterion, index) => <div className="td-repeat" key={criterion.criterionId}>{repeatedTitle('评价维度', index, true, () => patch('rubricCriteria', content.rubricCriteria.filter(r => r.criterionId !== criterion.criterionId)))}<Field title="判定描述与证据要求"><textarea rows={3} value={criterion.description} onChange={event => patch('rubricCriteria', content.rubricCriteria.map(r => r.criterionId === criterion.criterionId ? { ...r, description: event.target.value } : r))} /></Field>{linkedGoals(criterion.goalRefs, refs => patch('rubricCriteria', content.rubricCriteria.map(r => r.criterionId === criterion.criterionId ? { ...r, goalRefs: refs } : r)))}<LinkedChoices title="依据哪些可观察表现" options={content.observations.map(o => ({ id: o.observationId, title: o.description }))} value={criterion.observationIds} onChange={ids => patch('rubricCriteria', content.rubricCriteria.map(r => r.criterionId === criterion.criterionId ? { ...r, observationIds: ids } : r))} /></div>)}<button type="button" className="td-add" onClick={() => patch('rubricCriteria', [...content.rubricCriteria, { criterionId: uid(), description: '', goalRefs: [], observationIds: [] }])}><IconText name="add">添加评价维度</IconText></button>
        </>)
}
export type LiveSupportSectionProps=Pick<LiveSectionsProps,'content'|'patch'|'workbench'|'policy'|'base'|'Link'>
export function LiveSupportSection({content,patch,workbench,policy,base,Link = DesignAnchor}:LiveSupportSectionProps){


 return (<>
          <Field title="已确认的帮助政策" hint="沿用课程已确认的政策版本。当前接口不支持创建新政策，修改此项须先由课程负责人确认。"><textarea readOnly rows={4} value={policy?.description ?? `政策版本：${content.helpPolicyVersionId || '尚未选择'}`} /></Field><div className="td-inline-note"><Icon name="shield-check" /><p>{policy?.helpAllowed ? '允许按课程政策求助。' : '当前政策未开放日常求助。'} 整份代做与限定检查中的辅导均未开放。</p></div><div className="td-subheading"><h3>关联材料版本</h3><p>用途权限与学生、辅导可见性分别核对，材料版本固定后不会随草稿变化。</p></div>
          {workbench.resources.length ? <div className="td-resource-list">{workbench.resources.map(resource => { const selected = content.resources.some(r => r.resourceVersionId === resource.resourceVersionId); return <label className="td-resource-option" key={resource.resourceVersionId}><input type="checkbox" checked={selected} disabled={!selected && !resource.teacherDesignAllowed} onChange={event => patch('resources', event.target.checked ? [...content.resources, { resourceVersionId: resource.resourceVersionId }] : content.resources.filter(r => r.resourceVersionId !== resource.resourceVersionId))} /><Icon name={resource.material.kind === 'learning_material' ? 'file-text' : 'lock-keyhole'} size={20} /><span><strong>{resource.material.title}</strong><span>{resource.material.kind === 'learning_material' ? '学习材料' : resource.material.kind === 'private_answer' ? '教师私有答案' : '验证资产'}</span><span>学生{resource.material.visibility.student ? '可见' : '不可见'} · 辅导{resource.material.visibility.tutor ? '可见' : '不可见'} · 教师设计{resource.teacherDesignAllowed ? '允许使用' : '未获用途授权'}</span><small className="tld-id">{resource.resourceVersionId}</small></span></label> })}</div> : <div className="td-inline-empty">暂无材料。<Link to={`${base}/materials`}>前往课程材料</Link></div>}
          {content.resources.filter(ref => !workbench.resources.some(r => r.resourceVersionId === ref.resourceVersionId)).map(ref => <div className="td-notice" key={ref.resourceVersionId}><span>未读到关联材料 {ref.resourceVersionId}</span><button type="button" className="td-btn" onClick={() => patch('resources', content.resources.filter(r => r.resourceVersionId !== ref.resourceVersionId))}>取消关联</button></div>)}
          <details className="tld-config"><summary>查看沿用的课程配置</summary><dl><dt>帮助政策</dt><dd>{content.helpPolicyVersionId || '未选择'}</dd><dt>检查规则</dt><dd>{content.checkRuleVersionId || '未选择'}</dd><dt>运行配置</dt><dd>{content.runtimeProfileVersionId || '未选择'}</dd>{content.digitalLogicConfigVersionId && <><dt>数字逻辑配置</dt><dd>{content.digitalLogicConfigVersionId}</dd></>}</dl></details>
        </>)
}

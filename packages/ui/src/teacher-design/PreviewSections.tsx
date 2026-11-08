import { Icon, IconText } from '../icons'
import { PreviewDesignField as Field, DesignAnchor } from './controls'
import type { PreviewDraftDisplay, PreviewResourceDisplay, DesignLinkComponent } from './types'
import { previewDesignDomains as domains } from './constants'
const kindNames = {learning:'学习材料',reference:'参考资料',private_answer:'教师私有答案',validation:'验证材料'}
export interface PreviewSectionsProps {
 draft:PreviewDraftDisplay
 patch:<K extends keyof PreviewDraftDisplay>(key:K,value:PreviewDraftDisplay[K])=>void
 uid:()=>string
 data:{courses:{id:string;title:string}[]}
 courseResources:PreviewResourceDisplay[]
 base:string; Link?:DesignLinkComponent
 onCourseChange:(courseId:string)=>void
}
export type PreviewBriefSectionProps = Pick<PreviewSectionsProps, 'draft'|'patch'|'data'|'onCourseChange'>
export function PreviewBriefSection({draft,patch,data,onCourseChange}:PreviewBriefSectionProps) {
 const field = (key: 'problem'|'foundation'|'helpPolicy'|'title'|'audience'|'deliverable'|'choices'|'duration', title:string, placeholder:string, required=false, rows=3) => <Field title={title} required={required}>{rows===1 ? <input value={draft[key]} onChange={event=>patch(key,event.target.value)} placeholder={placeholder} /> : <textarea rows={rows} value={draft[key]} onChange={event=>patch(key,event.target.value)} placeholder={placeholder} />}</Field>
 return (<>
              <div className="td-form-pair"><Field title="所属课程" required><select value={draft.courseId} onChange={event => onCourseChange(event.target.value)}><option value="">选择一门课程</option>{data.courses.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></Field>{field('duration', '预计时长', '例如：2 周 · 4 课时', false, 1)}</div>
              {field('title', '项目标题', '给项目一个简洁、具体的名字', true, 1)}
              {field('problem', '驱动问题', '学生将为谁，解决怎样的真实问题？哪些约束值得探索？', true, 5)}
              <div className="td-form-pair">{field('audience', '项目受众', '谁会使用这份作品？它回应了谁的实际问题？', true)}{field('deliverable', '最终产物', '可运行作品、设计说明，以及用于验证的证据', true)}</div>
              {field('choices', '留给学生的选择空间', '哪些情境、方案或实现路径可以由学生自己决定？')}
              {field('foundation', '前置基础', '学生开始前需要理解什么、能够完成什么？')}
            </>)
}
export type PreviewGoalsSectionProps = Pick<PreviewSectionsProps, 'draft'|'patch'>
export function PreviewGoalsSection({draft,patch}:PreviewGoalsSectionProps) {

 return (<><div className="td-inline-note"><Icon name="lightbulb" tone="neutral" /><p>目标描述“学会什么”，可观察表现说明“凭什么判断”。三条能力线分别保留证据，不合并成一个总分。</p></div>{domains.map((domain, index) => {
              const goal = draft.goals.find(item => item.domain === domain.id) ?? { id: `goal-${domain.id}`, domain: domain.id, title: '', evidence: '' }
              const update = (key: 'title' | 'evidence', value: string) => patch('goals', draft.goals.some(item => item.id === goal.id) ? draft.goals.map(item => item.id === goal.id ? { ...item, [key]: value } : item) : [...draft.goals, { ...goal, [key]: value }])
              return <div className="td-goal" key={domain.id}><div className="td-row-heading"><span className="td-mini-index">0{index + 1}</span><div><h3>{domain.title}</h3><p>{domain.hint}</p></div></div><Field title="学习目标" required><textarea rows={2} value={goal.title} onChange={event => update('title', event.target.value)} placeholder="使用具体、可观察的动词描述目标" /></Field><Field title="可观察表现与证据" required><textarea rows={3} value={goal.evidence} onChange={event => update('evidence', event.target.value)} placeholder="作品、解释、验证过程或独立核验中，会看到什么？" /></Field></div>
            })}</>)
}
export type PreviewMilestonesSectionProps = Pick<PreviewSectionsProps, 'draft'|'patch'|'uid'>
export function PreviewMilestonesSection({draft,patch,uid}:PreviewMilestonesSectionProps) {

 return (<>
              <div className="td-subheading"><h3>学习里程碑</h3><p>每一步都有一个可讨论、可回看的阶段产物。</p></div>
              {draft.milestones.map((item, index) => <div className="td-repeat" key={item.id}><div className="td-repeat-heading"><span className="td-mini-index">{String(index + 1).padStart(2, '0')}</span><strong>阶段 {index + 1}</strong><button type="button" className="td-icon-btn" aria-label={`移除里程碑 ${index + 1}`} disabled={draft.milestones.length === 1} onClick={() => patch('milestones', draft.milestones.filter(current => current.id !== item.id))}><Icon name="close" tone="neutral" /></button></div><Field title="里程碑名称" required><input value={item.title} onChange={event => patch('milestones', draft.milestones.map(current => current.id === item.id ? { ...current, title: event.target.value } : current))} placeholder="例如：提出方案并解释取舍" /></Field><Field title="阶段证据" required><textarea rows={2} value={item.evidence} onChange={event => patch('milestones', draft.milestones.map(current => current.id === item.id ? { ...current, evidence: event.target.value } : current))} placeholder="这一阶段要保留哪些作品、验证与解释？" /></Field></div>)}
              <button type="button" className="td-add" onClick={() => patch('milestones', [...draft.milestones, { id: uid(), title: '', evidence: '' }])}><IconText name="add" tone="neutral">添加里程碑</IconText></button>
              <div className="td-subheading td-subheading-separated"><h3>评价量规</h3><p>判定依据指向证据；有帮助下完成与独立核验分别描述。</p></div>
              {draft.rubric.map((item, index) => <div className="td-repeat" key={item.id}><div className="td-repeat-heading"><strong>评价维度 {index + 1}</strong><button type="button" className="td-icon-btn" aria-label={`移除评价维度 ${index + 1}`} disabled={draft.rubric.length === 1} onClick={() => patch('rubric', draft.rubric.filter(current => current.id !== item.id))}><Icon name="close" tone="neutral" /></button></div><Field title="评价维度" required><input value={item.criterion} onChange={event => patch('rubric', draft.rubric.map(current => current.id === item.id ? { ...current, criterion: event.target.value } : current))} placeholder="例如：验证方案与解释结果" /></Field><Field title="判定描述与证据要求" required><textarea rows={3} value={item.description} onChange={event => patch('rubric', draft.rubric.map(current => current.id === item.id ? { ...current, description: event.target.value } : current))} placeholder="不同表现如何区分？证据不足时保留哪些未知？" /></Field></div>)}
              <button type="button" className="td-add" onClick={() => patch('rubric', [...draft.rubric, { id: uid(), criterion: '', description: '' }])}><IconText name="add" tone="neutral">添加评价维度</IconText></button>
            </>)
}
export type PreviewSupportSectionProps = Pick<PreviewSectionsProps, 'draft'|'patch'|'courseResources'|'base'|'Link'>
export function PreviewSupportSection({draft,patch,courseResources,base,Link = DesignAnchor}:PreviewSupportSectionProps) {
 const field = (key: 'problem'|'foundation'|'helpPolicy'|'title'|'audience'|'deliverable'|'choices'|'duration', title:string, placeholder:string, required=false, rows=3) => <Field title={title} required={required}>{rows===1 ? <input value={draft[key]} onChange={event=>patch(key,event.target.value)} placeholder={placeholder} /> : <textarea rows={rows} value={draft[key]} onChange={event=>patch(key,event.target.value)} placeholder={placeholder} />}</Field>
 return (<>
              {field('helpPolicy', '帮助使用政策', '学生何时可以求助？如何记录与核验帮助？哪些部分需要独立解释？', true, 6)}
              <div className="td-subheading"><h3>项目资源</h3><p>选择本项目使用的课程材料。角色预览只显示该角色获准看到的内容。</p></div>
              {courseResources.length ? <div className="td-resource-list">{courseResources.map(resource => <label className="td-resource-option" key={resource.id}><input type="checkbox" checked={draft.resourceIds.includes(resource.id)} onChange={event => patch('resourceIds', event.target.checked ? [...draft.resourceIds, resource.id] : draft.resourceIds.filter(id => id !== resource.id))} /><Icon name={resource.kind === 'private_answer' ? 'lock-keyhole' : 'file-text'} tone="neutral" size={20} /><span><strong>{resource.title}</strong><span>{kindNames[resource.kind]} · v{resource.version}</span><span className="td-visibility">{resource.kind === 'private_answer' || resource.kind === 'validation' ? '教师 / 验证器可见 · 不进入学生与辅导预览' : `学生${resource.student ? '可见' : '不可见'} · 辅导${resource.tutor ? '可见' : '不可见'}`} · 教师设计 AI {resource.teacherDesign ? '可使用' : '不可使用'}</span></span></label>)}</div> : <div className="td-inline-empty"><Icon name="folder-with-files" tone="neutral" size={24} /><p>这门课程还没有可选材料。</p><Link to={`${base}/materials`}>前往课程材料</Link></div>}
              <div className="td-inline-note"><Icon name="shield-check" tone="neutral" /><p>私有答案与验证材料仅对教师 / 验证器可见，始终排除在学生与辅导预览之外。教师设计 AI 能否使用由单独的材料权限控制。</p></div>
            </>)
}

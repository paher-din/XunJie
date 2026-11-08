import type { LiveReleasedDisplay, LiveAssignmentDisplay } from './LiveDesignDialogs'
export interface LiveReleaseSummaryProps {
 released:LiveReleasedDisplay;locked:boolean;onSelectStudents:()=>void;assignments:LiveAssignmentDisplay[]
 members:{userId:string;displayName?:string}[]
}
export function LiveReleaseSummary({released,locked,onSelectStudents,assignments,members}:LiveReleaseSummaryProps) {
 return (<section className="tld-release" aria-label="固定活动与分配回执"><div><span className="td-draft-tag">已固定 · v{released.sourceRevision}</span><h2>{released.title}</h2><p>活动 {released.activityVersionId}</p><p>继续编辑草稿会产生新版本，已固定的活动内容保持原样。</p></div><button type="button" className="td-btn td-btn-primary" disabled={locked} onClick={onSelectStudents}>选择学生并分配</button>{assignments.length > 0 && <div className="tld-receipts" role="status"><strong>已收到 {assignments.length} 条分配回执</strong>{assignments.map(a => <p key={a.assignmentId}>{members.find(m => m.userId === a.studentId)?.displayName || a.studentId} · {a.assignmentId} · v{a.assignmentRevision}</p>)}</div>}</section>)
}

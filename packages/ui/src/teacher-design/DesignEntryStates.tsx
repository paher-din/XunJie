import { Icon } from '../icons'
import { DesignAnchor } from './controls'
import type { DesignLinkComponent } from './types'
export interface DesignUnavailableProps {title:string;description:string;projectsPath:string;onRefresh?:()=>void;Link?:DesignLinkComponent}
export function DesignUnavailable({title,description,projectsPath,onRefresh,Link = DesignAnchor}:DesignUnavailableProps){
 return <div className="td-empty"><Icon name="folder-search" size={36} /><h1>{title}</h1><p>{description}</p>{onRefresh && <button type="button" className="td-btn" onClick={onRefresh}>重新读取</button>}<Link className="td-btn" to={projectsPath}>返回项目与活动</Link></div>
}
export interface PreviewDesignSourceProps {source:{id:string;name:string;activityTitle:string};base:string;Link?:DesignLinkComponent}
export function PreviewDesignSource({source,base,Link = DesignAnchor}:PreviewDesignSourceProps){return (<p className="td-source"><Icon name="link" tone="neutral" /><span>来自 {source.name} 的后续活动设计 · {source.activityTitle}</span><Link to={`${base}/review?learner=${encodeURIComponent(source.id)}`}>返回证据审阅</Link></p>)}
export function PreviewDesignReadOnlyNotice(){return (<div className="td-notice" role="status"><Icon name="info-circle" tone="neutral" /><span>教师设计的保存、设计助手与分配服务尚待业务接线。本页当前只读，真实操作不可用。</span></div>)}
export interface LiveDesignNoticesProps {source:{blueprintId:string;revision:number}|undefined;base:string;Link?:DesignLinkComponent;error:string;remoteChanged:boolean;generationChanged:boolean}
export function LiveDesignNotices({source,base,Link = DesignAnchor,error,remoteChanged,generationChanged}:LiveDesignNoticesProps){return <>
 {source && <p className="td-source"><Icon name="copy" />复制来源：<Link to={`${base}/design/${encodeURIComponent(source.blueprintId)}`}>{source.blueprintId}</Link> · v{source.revision}</p>}
 {error && <div className="td-notice tld-error" role="alert"><Icon name="info-circle" /><span>{error} 若结果未知，请先核对原教师操作；保留当前页面与编辑内容。</span></div>}
 {remoteChanged && <div className="td-notice" role="status"><Icon name="info-circle" /><span>服务器存在更新的草稿版本。当前编辑仍保留；“重新读取已存版本”会用服务器内容替换当前编辑。</span></div>}
 {generationChanged && <div className="td-notice" role="status"><Icon name="info-circle" /><span>数据库恢复代际已变化，当前编辑仍保留。请重新读取已存版本；尚未保存的新设计请返回项目列表重新开始。</span></div>}
 </>}
export interface FollowUpDesignHeadingProps {base:string;courseName:string;Link?:DesignLinkComponent}
export function FollowUpDesignHeading({base,courseName,Link = DesignAnchor}:FollowUpDesignHeadingProps){return <><div className="td-topline"><Link className="td-back" to={`${base}/projects`}>项目与活动</Link><span>创建后续项目</span></div><header className="td-heading"><div><p className="td-eyebrow">FOLLOW-UP PROJECT</p><h1>从已有项目，设计下一步</h1><p>{courseName} · 保留来源，独立修订目标与活动安排。</p></div></header></>}
export interface FollowUpDesignActionsProps {base:string;busy:boolean;onRefresh:()=>void;Link?:DesignLinkComponent}
export function FollowUpDesignActions({base,busy,onRefresh,Link = DesignAnchor}:FollowUpDesignActionsProps){return (<div className="td-heading-actions tld-follow-up-actions"><button type="button" className="td-btn" disabled={busy} onClick={onRefresh}>重新读取来源版本</button><Link className="td-btn" to={`${base}/projects`}>返回项目与活动</Link></div>)}
export function FollowUpDesignError({error}:{error:string}) {return (<div className="td-notice tld-error" role="alert">{error} 若结果未知，请先核对原教师操作。</div>)}

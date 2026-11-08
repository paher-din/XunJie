export const designValueLabels: Record<string, string> = {
  projectTitle: '项目标题', problem: '真实问题', audience: '受众', artifact: '产物', studentBackground: '学生基础',
  timeConstraints: '时间约束', routes: '选择路线', goals: '目标', tasks: '任务', observations: '可观察表现',
  rubricCriteria: '量规', milestones: '里程碑', resources: '资源', helpPolicyVersionId: '帮助政策版本',
  checkRuleVersionId: '检查规则版本', runtimeProfileVersionId: '运行配置版本', digitalLogicConfigVersionId: '数字逻辑配置版本',
  kind: '建议类型', constraints: '约束', unresolved: '未决问题', resourceRefs: '材料依据', helpPolicy: '帮助建议',
  checkpoints: '检查点', rubric: '量规建议', goalEvidenceLinks: '目标与证据联系', rationale: '理由',
  affectedLinks: '受影响项', criterionComments: '量规试评', ambiguities: '歧义', suggestedChanges: '修订建议', sampleRefs: '样例引用',
  competencyId: '能力标识', competencyVersion: '能力版本', domain: '能力线', title: '标题', core: '核心目标',
  description: '描述', goalRefs: '目标关联', taskIds: '任务关联', observationIds: '观察关联', resourceVersionId: '材料版本',
}
export function DesignValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="td-hint">无</span>
  if (Array.isArray(value)) return value.length ? <ul>{value.map((item, index) => <li key={index}><DesignValue value={item} /></li>)}</ul> : <span className="td-hint">无</span>
  if (typeof value === 'object') return <dl>{Object.entries(value).map(([key, item]) => <div key={key}><dt>{designValueLabels[key] ?? key}</dt><dd><DesignValue value={item} /></dd></div>)}</dl>
  return <span>{String(value)}</span>
}

export interface DesignValueProps { value: unknown }

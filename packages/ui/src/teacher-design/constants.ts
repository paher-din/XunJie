import type { DesignDomain } from './types'
export const previewDesignSections = [
  { id: 'brief', title: '项目简报', subtitle: '把真实问题写清楚', icon: 'file-text' },
  { id: 'goals', title: '目标与证据', subtitle: '三条能力线，共同生长', icon: 'route' },
  { id: 'milestones', title: '里程碑与量规', subtitle: '让学习过程可以被看见', icon: 'checklist' },
  { id: 'support', title: '帮助与资源', subtitle: '支持有边界，材料有分寸', icon: 'book-2' },
] as const
export const previewDesignDomains: { id: DesignDomain; title: string; hint: string }[] = [
  { id: 'domain', title: '学科能力', hint: '学生要理解哪些概念，并能做出什么？' },
  { id: 'project', title: '项目能力', hint: '学生如何分解、验证并解释自己的方案？' },
  { id: 'ai_collaboration', title: 'AI 协作能力', hint: '学生如何判断、核验并说明所获得的帮助？' },
]
export const liveDesignDomains: { id: DesignDomain; title: string }[] = [{ id: 'domain', title: '学科能力' }, { id: 'project', title: '项目能力' }, { id: 'ai_collaboration', title: 'AI 协作能力' }]
export const liveDesignRoles = [{id:'student',title:'学生视角'},{id:'tutor',title:'辅导视角'},{id:'teacher-validator',title:'教师 / 验证器'}] as const

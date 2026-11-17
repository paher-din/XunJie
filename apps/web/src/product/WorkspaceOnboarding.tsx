import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type RefObject } from 'react'
import { GuidancePresentation } from '@xunjie/ui/workspace'

const memory = new Map<string, string>()
export function readWorkspaceIntro(key: string) {
  try { return memory.get(key) ?? localStorage.getItem(key) ?? 'welcome' } catch { return memory.get(key) ?? 'welcome' }
}
export function saveWorkspaceIntro(key: string, step: string) {
  memory.set(key, step)
  try { localStorage.setItem(key, step) } catch { /* Preference failure never blocks learning. */ }
}
export interface WorkspaceOnboardingHandle { start(): void }
export interface WorkspaceIntroStep { id: string; title: string; text: string; selector: string; action: string }
export function workspaceIntroSteps(hasTools: boolean, school: boolean): WorkspaceIntroStep[] {
  return [
    { id: 'goals', title: '先看目标与材料', text: '在这里查看本次学习目标、任务要求和资料。先明确要解决什么，再开始动手。', selector: '[data-workspace-entry="materials"]', action: '查看目标与材料' },
    { id: 'works', title: '从作品开始实践', text: '在「文件」菜单新建代码或笔记。关闭文件标签只收起视图，仍可从文件列表重新打开。', selector: '.cw-filestrip', action: '打开作品区' },
    ...(hasTools ? [{ id: 'tools', title: '用课程工具观察结果', text: '课程提供的工具在上方标签中。打开后先看操作说明，运行、停止及结果都在对应工具内完成。', selector: '[data-workspace-entry="tools"]', action: '打开课程工具' }] : []),
    { id: 'help', title: '遇到问题时向 Agent 求助', text: '打开对话，描述你正在尝试什么、遇到了什么问题。发送前核对问题中的引用；查看引导本身不会发送问题。', selector: '[data-workspace-entry="help"]', action: '打开对话' },
    { id: 'delivery', title: school ? '保存和提交是两件事' : '保留你的学习成果', text: school
      ? '状态栏显示作品在本机的保存情况。准备交付时，点击「提交作品」选择版本并确认；保存或运行不会自动提交给学校。'
      : '作品自动保存在本机。通过状态栏核对保存情况；文件菜单可以导出作品备份。个人活动没有学校提交步骤。', selector: '[aria-label="活动与作品状态"]', action: '查看作品' },
  ]
}
export const WorkspaceOnboarding = forwardRef<WorkspaceOnboardingHandle, {
  preferenceKey: string; root: RefObject<HTMLDivElement | null>; hasTools: boolean; school: boolean
  suppressed?: boolean; auto?: boolean; onReveal(id: string): void
}>(function WorkspaceOnboarding({ preferenceKey, root, hasTools, school, suppressed, auto = true, onReveal }, ref) {
  const [stepId, setStepId] = useState(() => auto ? readWorkspaceIntro(preferenceKey) : 'done')
  const focusNext = useRef(false)
  const steps = workspaceIntroSteps(hasTools, school)
  const index = steps.findIndex(step => step.id === stepId)
  const welcome = stepId === 'welcome'
  const active = welcome || index >= 0
  const step = steps[Math.max(0, index)]
  const presentationId = `workspace-intro-${stepId}`
  const setStep = (id: string) => { saveWorkspaceIntro(preferenceKey, id); focusNext.current = true; setStepId(id) }
  const finish = () => { setStep('done'); root.current?.querySelector<HTMLElement>('#activity-title')?.focus() }
  useImperativeHandle(ref, () => ({ start: () => setStep('welcome') }))
  useEffect(() => {
    if (!active || suppressed) return
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !document.querySelector('[role="dialog"]')) { event.preventDefault(); finish() }
    }
    document.addEventListener('keydown', escape, true)
    return () => document.removeEventListener('keydown', escape, true)
  }, [active, suppressed, preferenceKey])
  useEffect(() => {
    if (!active || suppressed || !focusNext.current) return
    focusNext.current = false
    const frame = requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-presentation-id="${presentationId}"] button`)?.focus())
    return () => cancelAnimationFrame(frame)
  }, [stepId, active, suppressed])
  if (!active || suppressed) return null
  return <div className="product-workspace-intro"><GuidancePresentation item={{ id: presentationId,
    label: welcome ? '工作区使用引导' : `上手指引 ${index + 1} / ${steps.length}`,
    content: { kind: 'card', title: welcome ? '先认识一下你的学习工作区' : step.title,
      body: <p>{welcome ? '从看清目标、动手实践到交付作品，跟着几个简短提示找到入口。你也可以直接开始，之后从「活动」菜单重看。' : step.text}</p> },
    target: () => root.current?.querySelector(welcome ? '.product-activity-title' : step.selector) ?? null,
    actions: welcome ? [{ id: 'skip', label: '跳过引导' }, { id: 'start', label: '开始了解', primary: true }] : [
      { id: 'skip', label: '跳过' },
      ...(index > 0 ? [{ id: 'back', label: '上一步' }] : []),
      { id: 'reveal', label: step.action },
      { id: 'next', label: index === steps.length - 1 ? '开始学习' : '下一步', primary: true },
    ],
  }} appearance={{ tool: 'pointer' }} onAction={receipt => {
    if (receipt.actionId === 'skip') finish()
    else if (receipt.actionId === 'start') setStep(steps[0].id)
    else if (receipt.actionId === 'back') setStep(steps[index - 1].id)
    else if (receipt.actionId === 'next') index === steps.length - 1 ? finish() : setStep(steps[index + 1].id)
    else if (receipt.actionId === 'reveal') onReveal(step.id)
  }} /></div>
})

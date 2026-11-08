import { Link } from 'react-router-dom'
import { IconText } from '../../icons'
import { TextScopeBodyPane as Body, TextScopeRunCluster as Run, PrepTaskInfo as Info, ReadyTaskInfo as Ready,
  InitUnavailable as Unavailable, type WorkspaceInitDisplay, type TextScopeModeDisplay } from '@xunjie/ui/workspace'
import type { WorkspaceInit } from '../../workspace/init'
import { describeFailure } from '../../workspace/http'
import { reportDiagnostic } from '../../workspace/diagnostics'
import { PREP_ENTRY_COURSE, PREP_ENTRY_NOTE } from '../../workspace/prepEntry'
import { PREP_BUILD } from '../../workspace/mode'
export { CapabilityList, MaterialList, InitLoading, Section, Fact, Block, List } from '@xunjie/ui/workspace'
function display(init: WorkspaceInit | null): WorkspaceInitDisplay | null {
  if (init?.kind === 'unavailable') reportDiagnostic('workspace.initialize-failed', { stage: init.stage, reason: init.reason,
    technical: init.failure ? describeFailure(init.failure) : null })
  return init
}
function mode(): TextScopeModeDisplay {
  return { preparation: PREP_BUILD, courseLabel: PREP_ENTRY_COURSE, prepNotice: PREP_ENTRY_NOTE,
    returnLink: <Link className="primary" to="/"><IconText name="arrow-left">返回我的任务</IconText></Link> }
}
export function TextScopeBodyPane({ init, onReload }: { init: WorkspaceInit | null; onReload: () => void }) {
  return <Body init={display(init)} onReload={onReload} mode={mode()} />
}
export function TextScopeRunCluster({ init }: { init: WorkspaceInit | null }) {
  return <Run init={init} mode={mode()} />
}
export function PrepTaskInfo({ init, onReload }: { init: WorkspaceInit | null; onReload: () => void }) {
  return <Info init={display(init)} onReload={onReload} mode={mode()} />
}
export function ReadyTaskInfo({ init }: { init: Extract<WorkspaceInit, { kind: 'ready' }> }) {
  return <Ready init={init} mode={mode()} />
}
export function InitUnavailable({ init, onReload }: { init: WorkspaceInit; onReload: () => void }) {
  return <Unavailable init={display(init)!} onReload={onReload} mode={mode()} />
}

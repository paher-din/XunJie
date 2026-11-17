import { IconText } from '../icons'
import './workspace-status-bar.css'

export interface WorkspaceStatusBarProps {
  closed: boolean; workLabel: string; attention?: boolean; executionLabel?: string
  onWorks(): void; onTools?(): void; onGuide(): void
}
/** Read-only status presentation. All facts and navigation are provided by the host. */
export function WorkspaceStatusBar({ closed, workLabel, attention, executionLabel, onWorks, onTools, onGuide }: WorkspaceStatusBarProps) {
  return <div className="ui-workspace-status" aria-label="活动与作品状态">
    <span className="ui-workspace-activity">{closed ? '活动已关闭' : '活动进行中'}</span>
    <button type="button" className={'ws-btn ghost ui-workspace-work' + (attention ? ' attention' : '')} onClick={onWorks}
      title="仅表示当前作品在本机的保存及确认状态；正式提交需单独操作。"><IconText name="folder-with-files">{workLabel}</IconText></button>
    {executionLabel && <span className="ui-workspace-execution">{executionLabel}</span>}
    <div className="ui-workspace-status-actions">
      {onTools && <button type="button" className="ws-btn ghost" onClick={onTools}>打开课程工具</button>}
      <button type="button" className="ws-btn ghost" onClick={onGuide}>使用引导</button>
    </div>
  </div>
}

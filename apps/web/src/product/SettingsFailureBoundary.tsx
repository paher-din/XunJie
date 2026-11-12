import { Component, type ReactNode } from 'react'
import { SettingsStatus } from '@xunjie/ui/settings'

type Props = { children: ReactNode; onBack(): void }
type State = { failed: boolean }

/** 设置内容的动态模块或渲染失败时，保留设置外壳并给出恢复路径。 */
export class SettingsFailureBoundary extends Component<Props, State> {
  state: State = { failed: false }

  static getDerivedStateFromError(): State {
    return { failed: true }
  }

  render() {
    if (!this.state.failed) return this.props.children
    return <SettingsStatus tone="error" title="设置内容暂时无法打开"
      description="已保存的学习内容与配置不会因此改变。重新加载页面后再试。"
      action={<>
        <button type="button" className="outline" onClick={() => window.location.reload()}>重新加载页面</button>
        <button type="button" className="outline" onClick={this.props.onBack}>返回学习空间</button>
      </>} />
  }
}

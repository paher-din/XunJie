import { GenToolPane as GenToolPaneView, type GenToolPaneProps, type GenHostFactory } from '@xunjie/ui/workspace'
import { GenSandboxHost } from '../../bridge/genSandbox'
const createHost: GenHostFactory = options => new GenSandboxHost(options)
/** Only the sandbox runtime is legacy; the visible pane and card are formal implementations. */
export function GenToolPane(props: Omit<GenToolPaneProps, 'createHost'>) {
  return <GenToolPaneView {...props} createHost={createHost} />
}

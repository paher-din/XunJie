import { GenCard as GenCardView, GenLiveCard as GenLiveCardView, type GenCardProps as ViewProps, type GenLiveCardProps as LiveProps } from '@xunjie/ui/chat'
import { GenSandboxHost } from '../../bridge/genSandbox'
import type { GenHostFactory } from '@xunjie/ui/chat'
export { GenFailCard } from '@xunjie/ui/chat'
export type { GenFailCardProps } from '@xunjie/ui/chat'
export type GenCardProps = Omit<ViewProps, 'createHost'>
export type GenLiveCardProps = Omit<LiveProps, 'createHost'>
const createHost: GenHostFactory = options => new GenSandboxHost(options)
/** 旧运行宿主只负责提供沙箱协议实现。 */
export function GenCard(props: GenCardProps) { return <GenCardView {...props} createHost={createHost} /> }
export function GenLiveCard(props: GenLiveCardProps) { return <GenLiveCardView {...props} createHost={createHost} /> }

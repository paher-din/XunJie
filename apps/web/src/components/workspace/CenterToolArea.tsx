import { forwardRef, useEffect, useState, type ReactNode } from 'react'
import { CenterToolArea as CenterToolAreaView, defaultLayout, knownTools, DIGITAL_LOGIC_TOOLS,
  type CenterToolAreaHandle, type CenterVariant, type ToolSpec, type ToolKey, type CoreToolKey, type LayoutNode } from '@xunjie/ui/workspace'
import type { StoredGenCard } from '../../bridge/types'
import { GenToolPane } from './GenCardItems'
export { SEGMAP, Seg7, EditorPane, WavePane, BoardPane, DIGITAL_LOGIC_TOOLS, CODE_TOOLS, Divider, ToolTabs, DigitalLogicRunCluster } from '@xunjie/ui/workspace'
export type { ToolKey, ToolSpec, CenterVariant, CenterToolAreaHandle } from '@xunjie/ui/workspace'

export interface CenterToolAreaProps {
  taskId: string
  /** 外部（引导脚本）要求聚焦的工具。 */
  tool: ToolKey
  onToolChange: (t: ToolKey) => void
  onToast: (text: string) => void
  onDesignLoaded?: () => void
  /** 当前任务的生成卡收纳存储（标签页内容按 cardId 查；钉右缘与胶囊收纳同源）。 */
  genCards?: StoredGenCard[]
  /** 布局里打开着的生成卡标签（页面据此计算胶囊收纳列表与角标）。 */
  onGenTabsChange?: (cardIds: string[]) => void
  /** 标签页上「收纳」：拿到最新快照后由页面冻结入收纳并关闭标签。 */
  onGenCollect?: (cardId: string, snapshot: unknown) => void
  /** live 期间的交互状态续写。 */
  onGenStateSync?: (cardId: string, snapshot: unknown) => void
  /** 顶栏标签槽（浏览器式）：单窗格时标签条 portal 到这里；分屏后各窗格回到自带标签条。 */
  tabsSlot?: HTMLElement | null
  /** 顶栏运行簇槽：板状态、版本流与操作按钮 portal 到这里（不分屏也常驻顶栏）。 */
  runSlot?: HTMLElement | null
  /** 中心容器变体；缺省是原数字逻辑演示。 */
  variant?: CenterVariant
  /** 学科工具包声明的核心工具；缺省是数字逻辑那三枚。 */
  tools?: ToolSpec[]
  /** 「设计 / 代码」标签的正文：课程工具包自己给（缺省是数字逻辑的静态代码演示）。 */
  designBody?: ReactNode
  /** 真实板卡 / 有限波形由业务页面提供，不改变原标签与分屏布局。 */
  boardBody?: ReactNode
  waveBody?: ReactNode
  /** 顶栏运行簇内容：状态与操作由学科工具包声明（缺省是虚拟板的状态与烧录）。 */
  runCluster?: ReactNode
  /** Generic product tools supply content; legacy course variants remain with their existing consumers. */
  toolBodies?: Partial<Record<CoreToolKey, ReactNode>>
  beforeToolChange?: () => Promise<void>
}

/** Legacy adapter owns storage and generated-card business content, not the visual tool area. */
export const CenterToolArea = forwardRef<CenterToolAreaHandle, CenterToolAreaProps>(function CenterToolArea(
  { taskId, beforeToolChange, genCards = [], onGenCollect, onGenStateSync, ...props }, ref,
) {
  const toolKeys = (props.tools ?? DIGITAL_LOGIC_TOOLS).map(tool => tool.key)
  const storeKey = `ws-layout:${taskId}`
  const [layout, setLayoutState] = useState<LayoutNode>(() => {
    try {
      const raw = localStorage.getItem(storeKey)
      if (raw) {
        const stored = JSON.parse(raw) as LayoutNode
        if (knownTools(stored, toolKeys)) return stored
      }
    } catch { /* Corrupt/unavailable storage falls back to the existing default. */ }
    return defaultLayout(toolKeys)
  })
  const setLayout = (update: React.SetStateAction<LayoutNode>) => {
    if (!beforeToolChange) { setLayoutState(update); return }
    void beforeToolChange().then(() => setLayoutState(update)).catch(() => props.onToast('当前输入尚未保护，请保留页面并导出作品。'))
  }
  useEffect(() => { localStorage.setItem(storeKey, JSON.stringify(layout)) }, [storeKey, layout])
  return <CenterToolAreaView {...props} ref={ref} layout={layout} onLayoutChange={setLayout} genCards={genCards}
    renderGeneratedCard={(cardId, onClose) => <GenToolPane card={genCards.find(card => card.cardId === cardId) ?? null}
      onCollect={snapshot => onGenCollect?.(cardId, snapshot)} onStateSync={snapshot => onGenStateSync?.(cardId, snapshot)} onClose={onClose} />} />
})

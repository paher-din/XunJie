/**
 * 中心工具区的分屏布局树（docs/home-design.md Q7：类浏览器标签页 + 分屏拖拽）。
 * 纯函数实现：所有操作返回新树，由 CenterToolArea 持有状态并持久化。
 */

export type CoreToolKey = 'design' | 'board' | 'wave'
/**
 * 中心工具区标签：核心工具（课程包预置）+ 生成交互卡标签（gen:<cardId>，第 19 条）。
 * 生成卡标签与核心工具同级：可关闭（只关视图，卡本体仍在会话与收纳里）、可拖拽分屏，
 * 进 ws-layout:<taskId> 持久化，重开按快照重建。
 */
export type ToolKey = CoreToolKey | `gen:${string}`

/** 从标签 key 取生成卡 id；非生成卡返回 null。 */
export function genCardIdOf(tool: ToolKey): string | null {
  return typeof tool === 'string' && tool.startsWith('gen:') ? tool.slice(4) : null
}

export interface PaneNode {
  kind: 'pane'
  id: string
  tabs: ToolKey[]
  active: ToolKey
}
export interface SplitNode {
  kind: 'split'
  id: string
  /** row = 左右分屏，col = 上下分屏。 */
  dir: 'row' | 'col'
  /** 第一个子节点占比（0.2–0.8）。 */
  ratio: number
  a: LayoutNode
  b: LayoutNode
}
export type LayoutNode = PaneNode | SplitNode

let seq = 0
function nid(): string {
  return `n${Date.now().toString(36)}${++seq}`
}

/** 数字逻辑工具包的三个核心工具；其他课程由各自的工具包声明（见 bridge/projects.ts）。 */
export const DEFAULT_TOOLS: CoreToolKey[] = ['design', 'board', 'wave']

export function defaultLayout(tools: CoreToolKey[] = DEFAULT_TOOLS, active: CoreToolKey = 'board'): LayoutNode {
  const current = tools.includes(active) ? active : tools[0]
  return { kind: 'pane', id: nid(), tabs: [...tools], active: current }
}

export function panes(node: LayoutNode): PaneNode[] {
  return node.kind === 'pane' ? [node] : [...panes(node.a), ...panes(node.b)]
}

export function findPane(node: LayoutNode, tool: ToolKey): PaneNode | null {
  return panes(node).find((p) => p.tabs.includes(tool)) ?? null
}

/** 激活包含某工具的窗格中的对应标签；不需要变更时返回原树。 */
export function activateTool(node: LayoutNode, tool: ToolKey): LayoutNode {
  if (node.kind === 'pane') {
    return node.tabs.includes(tool) && node.active !== tool ? { ...node, active: tool } : node
  }
  const a = activateTool(node.a, tool)
  const b = activateTool(node.b, tool)
  return a === node.a && b === node.b ? node : { ...node, a, b }
}

function mapPane(node: LayoutNode, id: string, fn: (p: PaneNode) => LayoutNode): LayoutNode {
  if (node.kind === 'pane') return node.id === id ? fn(node) : node
  return { ...node, a: mapPane(node.a, id, fn), b: mapPane(node.b, id, fn) }
}

/** 从树中摘除某工具；窗格因此变空时整格移除、父分屏塌陷。 */
function removeTool(node: LayoutNode, tool: ToolKey): LayoutNode | null {
  if (node.kind === 'pane') {
    if (!node.tabs.includes(tool)) return node
    const tabs = node.tabs.filter((t) => t !== tool)
    if (tabs.length === 0) return null
    return { ...node, tabs, active: node.active === tool ? tabs[0] : node.active }
  }
  const a = removeTool(node.a, tool)
  const b = removeTool(node.b, tool)
  if (a === null) return b
  if (b === null) return a
  return a === node.a && b === node.b ? node : { ...node, a, b }
}

/** 关闭工具标签（只关视图）：生成卡关闭后卡本体仍在会话与收纳里（第 19 条）。 */
export function closeTool(node: LayoutNode, tool: ToolKey): LayoutNode {
  return removeTool(node, tool) ?? node
}

/** 把工具标签并入树中第一个窗格并激活（标签尚不在树中时；已存在则只激活）。 */
export function addTool(node: LayoutNode, tool: ToolKey): LayoutNode {
  if (findPane(node, tool)) return activateTool(node, tool)
  return mapPane(node, panes(node)[0].id, (p) => ({ ...p, tabs: [...p.tabs, tool], active: tool }))
}

/** 把工具标签移动到目标窗格末尾并激活。 */
export function moveTab(node: LayoutNode, tool: ToolKey, targetId: string): LayoutNode {
  const src = findPane(node, tool)
  if (!src) return node
  if (src.id === targetId) return activateTool(node, tool)
  const removed = removeTool(node, tool)
  if (!removed) return node
  return mapPane(removed, targetId, (p) => ({ ...p, tabs: [...p.tabs, tool], active: tool }))
}

/** 把工具标签拖出，在目标窗格的指定一侧分屏。 */
export function splitTab(
  node: LayoutNode,
  tool: ToolKey,
  targetId: string,
  dir: 'row' | 'col',
  before: boolean,
): LayoutNode {
  const src = findPane(node, tool)
  if (!src) return node
  // 唯一标签往自己所在的窗格拖：无意义，不分屏
  if (src.id === targetId && src.tabs.length === 1) return node
  const removed = removeTool(node, tool)
  if (!removed || !panes(removed).some((p) => p.id === targetId)) return node
  const fresh: PaneNode = { kind: 'pane', id: nid(), tabs: [tool], active: tool }
  return mapPane(removed, targetId, (p) => ({
    kind: 'split',
    id: nid(),
    dir,
    ratio: 0.5,
    a: before ? fresh : p,
    b: before ? p : fresh,
  }))
}

export function resizeSplit(node: LayoutNode, id: string, ratio: number): LayoutNode {
  const r = Math.min(0.8, Math.max(0.2, ratio))
  if (node.kind === 'pane') return node
  if (node.id === id) return { ...node, ratio: r }
  return { ...node, a: resizeSplit(node.a, id, ratio), b: resizeSplit(node.b, id, ratio) }
}

/** 结构指纹（忽略节点 id），用于判断是否已不是默认布局。 */
export function serialize(node: LayoutNode): string {
  if (node.kind === 'pane') return `p(${[...node.tabs].sort().join(',')})`
  return `s(${node.dir},${node.ratio.toFixed(2)},${serialize(node.a)},${serialize(node.b)})`
}

/** 是否还是该工具包声明的默认布局（单窗格、标签就是工具包那几枚）。 */
export function isDefaultShape(node: LayoutNode, tools: CoreToolKey[] = DEFAULT_TOOLS): boolean {
  return serialize(node) === serialize({ kind: 'pane', id: '-', tabs: [...tools], active: tools[0] })
}

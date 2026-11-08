import type { ComponentType } from 'react'

/** 一个状态一个稳定 ID；渲染函数只使用正式包和显式提供的演示数据。 */
export interface CatalogState {
  id: string
  name: string
  description?: string
  component: ComponentType
  /** 需要桌面宽度才能呈现原有媒体查询行为时启用。 */
  viewport?: 'wide'
  /** 宽视口中的示例固定在右侧时，初始滚动到右边。 */
  initialScroll?: 'end'
  /** 需要较高的视口呈现对话框或整页时指定。 */
  height?: number
}

export interface CatalogEntry {
  id: string
  name: string
  description: string
  importPath: string
  source: string
  exampleSource: string
  props: string[]
  dependencies: string[]
  /** 除名称、状态、属性外，允许索引可枚举的子项。 */
  searchTerms?: string[]
  states: CatalogState[]
}

export interface CatalogGroup {
  id: string
  name: string
  entries: CatalogEntry[]
}

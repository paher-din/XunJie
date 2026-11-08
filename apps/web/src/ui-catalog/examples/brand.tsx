import { useState } from 'react'
import { CompanionButton, MascotSvg, SproutMascot, XunjieLogo, type SproutMotion, type SproutTool } from '@xunjie/ui/brand'
import { Button } from '@xunjie/ui/foundation'
import type { CatalogEntry } from '../types'

function LogoFormats() {
  return <div className="demo-logo-grid"><div><XunjieLogo format="mark" label="循阶标记" /><span>mark</span></div>
    <div><XunjieLogo format="horizontal" label="循阶横排标志" /><span>horizontal</span></div>
    <div><XunjieLogo format="stacked" label="循阶竖排标志" /><span>stacked</span></div></div>
}
function LogoTones() {
  return <div className="demo-logo-grid"><div><XunjieLogo format="horizontal" tone="color" label="彩色循阶标志" /><span>color</span></div>
    <div><XunjieLogo format="horizontal" tone="mono" label="单色循阶标志" /><span>mono</span></div>
    <div className="demo-inverse"><XunjieLogo format="horizontal" tone="reverse" label="反白循阶标志" /><span>reverse</span></div></div>
}
function SproutTools() {
  const tools: SproutTool[] = ['none', 'glasses', 'pencil', 'pointer', 'chalk']
  return <div className="demo-sprout-grid">{tools.map(tool => <div key={tool}><SproutMascot tool={tool} motion="none" label={`${tool} 角色`} /><span>{tool}</span></div>)}</div>
}
function SproutMotions() {
  const [motion, setMotion] = useState<SproutMotion>('idle')
  const [replay, setReplay] = useState(0)
  const motions: SproutMotion[] = ['none', 'idle', 'think', 'invite', 'celebrate', 'equip']
  return <div className="demo-sprout-interactive"><div className="demo-sprout-one"><SproutMascot motion={motion} replay={replay} label="循阶角色" /></div>
    <div className="demo-row">{motions.map(value => <Button type="button" key={value} variant={value === motion ? 'primary' : 'outline'} onClick={() => { setMotion(value); setReplay(count => count + 1) }}>{value}</Button>)}</div></div>
}
function MascotDefault() { return <div className="demo-sprout-one"><MascotSvg label="循阶角色" /></div> }
function MascotThinking() { return <div className="demo-sprout-one"><MascotSvg motion="think" tool="glasses" label="思考中的循阶角色" /></div> }
function CompanionDemo() {
  const [working, setWorking] = useState(false)
  const [attention, setAttention] = useState(false)
  const [count, setCount] = useState(0)
  return <div className="demo-sprout-interactive"><CompanionButton className="demo-companion" working={working} attention={attention} aria-label="学习助手" onClick={() => setCount(value => value + 1)} />
    <div className="demo-row"><Button type="button" variant="outline" onClick={() => setWorking(!working)}>{working ? '停止忙碌' : '忙碌'}</Button>
      <Button type="button" variant="outline" onClick={() => setAttention(!attention)}>{attention ? '取消关注' : '关注'}</Button></div>
    <output>角色按钮已点击 {count} 次</output></div>
}
const source = 'apps/web/src/ui-catalog/examples/brand.tsx'
export const brandEntries: CatalogEntry[] = [
  { id: 'xunjie-logo', name: 'XunjieLogo', description: '正式循阶标志及排版形式。', importPath: '@xunjie/ui/brand', source: 'packages/ui/src/brand/XunjieLogo.tsx', exampleSource: source, props: ['format?: mark | horizontal | stacked', 'tone?: color | mono | reverse', 'label? 与原生 SVG 属性'], dependencies: ['包内正式标志主文件'], states: [
    { id: 'formats', name: '标记 / 横排 / 竖排', component: LogoFormats }, { id: 'tones', name: '彩色 / 单色 / 反白', component: LogoTones },
  ] },
  { id: 'sprout-mascot', name: 'SproutMascot', description: '角色形象、道具与动作。', importPath: '@xunjie/ui/brand', source: 'packages/ui/src/brand/SproutMascot.tsx', exampleSource: source, props: ['expression?, tool?, motion?', 'label?, className?, replay?', 'previewTime?, speed?, paused?'], dependencies: ['包内角色素材和动画；资源由打包器解析'], states: [
    { id: 'tools', name: '全部道具', component: SproutTools }, { id: 'motions', name: '动作', component: SproutMotions },
  ] },
  { id: 'mascot-svg', name: 'MascotSvg', description: '使用默认待机动作的角色组件。', importPath: '@xunjie/ui/brand', source: 'packages/ui/src/foundation/Mascot.tsx', exampleSource: source, props: ['继承 SproutMascotProps', 'motion 默认 idle'], dependencies: ['SproutMascot'], states: [
    { id: 'idle', name: '待机', component: MascotDefault }, { id: 'thinking', name: '思考', component: MascotThinking },
  ] },
  { id: 'companion-button', name: 'CompanionButton', description: '带角色动作的可交互按钮。', importPath: '@xunjie/ui/brand', source: 'packages/ui/src/foundation/CompanionButton.tsx', exampleSource: source, props: ['attention?, working?, tool?, cue?, ambient?', '原生 button 属性'], dependencies: ['角色素材及动作由包内组件提供'], states: [{ id: 'interactive', name: '待机 / 忙碌 / 关注', component: CompanionDemo }] },
]

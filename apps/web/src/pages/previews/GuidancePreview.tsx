import { useRef, useState } from 'react'
import { GuidancePresentation } from '../../components/workspace/guidance/GuidancePresentation'
import type { GuidanceItem, GuidancePresentationProps, GuidanceReceipt, GuidanceTarget } from '../../components/workspace/guidance/GuidancePresentation'
import { GuideLayer } from '../../components/workspace/GuideLayer'
import type { GuideStep } from '../../components/workspace/GuideLayer'
import './guidance-preview.css'

const LEGACY_STEPS: GuideStep[] = [
  { at: 'dock', text: '旧脚本仍可提供文字，并由同一展示组件呈现。' },
  { at: 'boardRich', card: 'debounce', below: true },
]
export default function GuidancePreview() {
  const [version, setVersion] = useState(1)
  const [kind, setKind] = useState<'text' | 'card'>('text')
  const [state, setState] = useState<GuidancePresentationProps['state']>('showing')
  const [targetMode, setTargetMode] = useState('element')
  const [mounted, setMounted] = useState(true)
  const [long, setLong] = useState(false)
  const [moved, setMoved] = useState(false)
  const [hiddenTarget, setHiddenTarget] = useState(false)
  const [removedTarget, setRemovedTarget] = useState(false)
  const [renderCount, setRenderCount] = useState(0)
  const [receipts, setReceipts] = useState<GuidanceReceipt[]>([])
  const [value, setValue] = useState('')
  const [clicks, setClicks] = useState(0)
  const [legacy, setLegacy] = useState(false)
  const [legacyIndex, setLegacyIndex] = useState(0)
  const [legacyFirst, setLegacyFirst] = useState(LEGACY_STEPS[0])
  const [collected, setCollected] = useState<string[]>([])
  const anchor = useRef<HTMLButtonElement>(null)
  const text = '先看看你选择的对象。你可以继续探索，也可以暂时收起提示。'
  const target: GuidanceTarget | undefined = targetMode === 'none' ? undefined : () => {
    if (targetMode === 'invalid') throw new Error('unavailable target')
    if (targetMode === 'position') return { left: 200, top: 300, width: 1, height: 1 }
    return anchor.current
  }
  const item: GuidanceItem = {
    id: `preview-${version}`, label: `展示 ${version}`, target,
    content: kind === 'text' ? { kind: 'text', text: long ? Array(40).fill(text).join('\n') : text } : {
      kind: 'card', title: '观察与预测', body: <div className="guidance-preview-card">
        <p>先写下自己的预测，再选择下一步。卡片内容由调用方提供。</p>
        {long && Array.from({ length: 30 }, (_, index) => <p key={index}>观察记录 {index + 1}：改变一个条件，比较现象是否变化。</p>)}
        <label>我的预测<input value={value} onChange={event => setValue(event.target.value)} /></label>
      </div>,
    },
    actions: [{ id: 'continue', label: '继续探索', primary: true, disabled: state === 'busy' }, { id: 'later', label: '暂不' }, { id: 'close', label: '关闭' }],
  }
  const receive = (receipt: GuidanceReceipt) => {
    setReceipts(previous => [...previous, receipt])
    if (receipt.actionId === 'later') setState('quiet')
    if (receipt.actionId === 'close') setState('hidden')
    if (receipt.actionId === 'reopen') setState('showing')
  }
  return <main className="guidance-preview">
    <header><h1>IP 教学引导展示</h1><p>切换展示内容与位置，查看真实操作回执。</p></header>
    <div className="guidance-preview-controls">
      <button onClick={() => { setKind('text'); setVersion(v => v + 1); setState('showing') }}>文字提示</button>
      <button onClick={() => { setKind('card'); setVersion(v => v + 1); setState('showing') }}>交互卡片</button>
      <button onClick={() => setVersion(v => v + 1)}>替换展示项</button>
      <button onClick={() => setRenderCount(v => v + 1)}>重复渲染 {renderCount}</button>
      <label>展示状态<select aria-label="展示状态" value={state} onChange={event => setState(event.target.value as GuidancePresentationProps['state'])}>
        <option value="showing">显示</option><option value="busy">忙碌</option><option value="waiting">等待</option><option value="quiet">安静</option><option value="hidden">隐藏</option>
      </select></label>
      <label>目标类型<select aria-label="目标类型" value={targetMode} onChange={event => setTargetMode(event.target.value)}>
        <option value="element">元素</option><option value="position">位置</option><option value="none">无目标</option><option value="invalid">无效目标</option>
      </select></label>
      <button onClick={() => setHiddenTarget(v => !v)}>切换目标可见性</button>
      <button onClick={() => setRemovedTarget(v => !v)}>移除或恢复目标</button>
      <button onClick={() => setMoved(v => !v)}>移动目标</button>
      <button onClick={() => { setLong(v => !v); setVersion(v => v + 1) }}>切换长内容</button>
      <button onClick={() => setMounted(v => !v)}>{mounted ? '卸载组件' : '挂载组件'}</button>
      <button onClick={() => { setLegacy(v => !v); setLegacyIndex(0) }}>{legacy ? '通用展示' : '旧脚本适配'}</button>
      {legacy && <button onClick={() => setLegacyFirst({ ...LEGACY_STEPS[0], text: '同一索引的新提示：请先核对新的观察对象。' })}>替换旧脚本文字</button>}
    </div>
    <div className="guidance-preview-layout">
      <section className="guidance-preview-stage" aria-label="引导展示区域" onClick={() => setClicks(v => v + 1)}>
        <div className="guidance-preview-scroll" data-testid="target-scroll">
          <div className="guidance-preview-work"><label>工作区输入<input aria-label="工作区输入" placeholder="提示出现时继续在这里输入" /></label>
            {!removedTarget && <button ref={anchor} className="guidance-preview-target" style={{ marginLeft: moved ? '55%' : '20%', marginTop: moved ? 200 : 100, visibility: hiddenTarget ? 'hidden' : 'visible' }}>观察对象</button>}
            <p>滚动此区域，观察目标移出后提示安静退回。</p>
          </div>
        </div>
        {mounted && (legacy ? <GuideLayer step={legacyIndex === 0 ? legacyFirst : LEGACY_STEPS[legacyIndex] ?? null} stepIndex={legacyIndex} total={LEGACY_STEPS.length}
          idle={state === 'quiet'} busy={state === 'busy'} milestone={0} docked={false} collected={collected} pinned={[]} collecting={null}
          onPresentationAction={receipt => setReceipts(r => [...r, receipt])} onNext={() => setLegacyIndex(v => v + 1)}
          onCollect={key => setCollected(c => [...c, key])} onIpClick={() => setState(s => s === 'quiet' ? 'showing' : 'quiet')} />
          : <GuidancePresentation item={item} state={state} appearance={{ cue: { key: item.id, motion: 'invite', delay: 500 } }}
            companionAction={{ id: state === 'quiet' ? 'reopen' : 'later', label: state === 'quiet' ? '重新打开引导' : '收起引导' }} onAction={receive} />)}
      </section>
      <aside className="guidance-preview-receipts"><h2>操作回执</h2>
        <p>当前展示：<output data-testid="current-id">{item.id}</output></p>
        <p>工作区点击：<output data-testid="workspace-clicks">{clicks}</output></p>
        <p>回执数：<output data-testid="receipt-count">{receipts.length}</output></p>
        <ol aria-label="操作回执">{receipts.map((receipt, index) => <li key={index}><code>{JSON.stringify(receipt)}</code></li>)}</ol>
      </aside>
    </div>
  </main>
}

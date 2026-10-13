import { useState } from 'react'
import { Link } from 'react-router-dom'
import { SproutMascot } from './SproutMascot'
import type { SproutMotion, SproutTool } from './artwork'
import { MOTION_DURATION } from './motion'
import './brand-board.css'

const TOOLS: { value: SproutTool; label: string }[] = [
  { value: 'none', label: '主形象' }, { value: 'glasses', label: '眼镜' },
  { value: 'pencil', label: '铅笔' }, { value: 'pointer', label: '教鞭' }, { value: 'chalk', label: '粉笔与小板' },
]
const MOTIONS: { value: SproutMotion; label: string; note: string }[] = [
  { value: 'none', label: '静止站姿', note: '核对轮廓、神情、配色与道具握持。' },
  { value: 'idle', label: '待命 · 呼吸与眨眼', note: '脚底站稳，身体轻呼吸，偶尔眨眼和抖一抖叶子。' },
  { value: 'think', label: '倾听 · 抬叶侧听', note: '眼神先看向问题，右叶随后抬起，小手轻轻回应。' },
  { value: 'invite', label: '邀请 · 招手摇芽', note: '抬手招呼，两片叶子先后展开、回摆，再收回待命。' },
  { value: 'celebrate', label: '完成 · 蓄力跃起', note: '先蹲一点再跃起，落地轻压缩，叶片最后回弹。' },
]
const BASE = `${import.meta.env.BASE_URL}brand/sprout/`

function ApprovedOriginal() {
  return <svg viewBox="0 0 1000 1200" className="sprout-mascot" role="img" aria-label="已确认的原版"><image href={BASE + 'master.png'} x="-148" y="-45" width="1254" height="1254" /></svg>
}

export default function BrandBoard() {
  const [tool, setTool] = useState<SproutTool>('none')
  const [motion, setMotion] = useState<SproutMotion>('idle')
  const [size, setSize] = useState(300)
  const [dark, setDark] = useState(false)
  const [replay, setReplay] = useState(0)
  const [split, setSplit] = useState(50)
  const [mode, setMode] = useState<'live' | 'frame'>('live')
  const [frameTime, setFrameTime] = useState(0)
  const [speed, setSpeed] = useState(1)
  const duration = MOTION_DURATION[motion] || 1600
  const chooseMotion = (next: SproutMotion) => { setMotion(next); setFrameTime(0); setMode('live'); setReplay(v => v + 1) }
  return (
    <main className="brand-review">
      <header className="br-header">
        <div><p className="br-eyebrow">循阶 · 双叶芽 / 站姿与动作精修</p><h1>这次，让它活起来</h1><p>站姿轻微回正；眼神、双叶、手脚各自回应，拿道具时也保持自然。</p></div>
        <Link to="/">回到产品首页 <span aria-hidden="true">↗</span></Link>
      </header>
      <section className="br-section br-live">
        <div className={`br-stage${dark ? ' br-stage-dark' : ''}`}>
          <div className="br-mascot-frame" style={{ width: size * 5 / 6, height: size }}><SproutMascot tool={tool} motion={motion} replay={replay} speed={speed} previewTime={mode === 'frame' ? frameTime : undefined} label="双叶芽互动预览" /></div>
          <span className="br-stage-note">{size}px 高 · {dark ? '深色' : '浅色'}背景</span>
        </div>
        <div className="br-controls"><span className="br-eyebrow">形象与动作</span><h2>保持原来的神情</h2><p>{MOTIONS.find((item) => item.value === motion)?.note}</p>
          <label>姿态<select value={tool} onChange={(e) => setTool(e.target.value as SproutTool)}>{TOOLS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
          <label>动作<select value={motion} onChange={(e) => chooseMotion(e.target.value as SproutMotion)}>{MOTIONS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
          <label>尺寸<select value={size} onChange={e => setSize(Number(e.target.value))}>{[48,54,64,96,160,300,480].map(v => <option key={v} value={v}>{v}px 高</option>)}</select></label>
          <label>播放方式<select value={mode} onChange={e => setMode(e.target.value as 'live' | 'frame')}><option value="live">实时播放</option><option value="frame">逐帧检查</option></select></label>
          <label>播放速度<select value={speed} onChange={e => setSpeed(Number(e.target.value))}>{[.5,1,1.5].map(v => <option key={v} value={v}>{v}×</option>)}</select></label>
          {mode === 'frame' && <label className="br-frame-seek">画面进度 <span>{frameTime} ms</span><input aria-label="画面进度" type="range" min="0" max={duration} step="10" value={frameTime} onChange={e => setFrameTime(Number(e.target.value))} /></label>}
          <div className="br-control-actions"><button type="button" onClick={() => setDark(v => !v)}>{dark ? '切换浅色' : '切换深色'}</button><button type="button" onClick={() => { setReplay(v => v + 1); setMode('live'); setFrameTime(0) }}>重播动作</button></div>
          <p className="br-small">减少动效时保留静态手势；短反馈到期回待命，离屏停止播放。</p>
        </div>
      </section>
      <section className="br-section"><div className="br-section-heading"><div><span className="br-eyebrow">四种表演</span><h2>每个动作都有自己的节奏</h2></div><p>点击卡片，在上方观看；逐帧模式检查动作细节。</p></div>
        <div className="br-motion-grid">{MOTIONS.filter(item => item.value !== 'none').map(item => <button className={motion === item.value ? 'is-selected' : ''} type="button" key={item.value} onClick={() => { chooseMotion(item.value); document.querySelector('.br-live')?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }) }}><span className="br-motion-art"><SproutMascot motion={item.value} previewTime={item.value === 'idle' ? 1500 : item.value === 'think' ? 1600 : item.value === 'invite' ? 450 : 420} tool={tool} /></span><strong>{item.label}</strong><span>{item.note}</span></button>)}</div>
      </section>
      <section className="br-section">
        <div className="br-section-heading"><div><span className="br-eyebrow">站姿对照</span><h2>微调重心，保留它的神情</h2></div><p>左：原稿。右：回正站姿、平齐浅弧与协调后的脚底。</p></div>
        <div className={`br-compare${dark ? ' br-stage-dark' : ''}`}>
          <div className="br-compare-art"><SproutMascot /><div className="br-compare-original" style={{clipPath:`inset(0 ${100 - split}% 0 0)`}}><ApprovedOriginal /></div><span className="br-compare-line" style={{left:`${split}%`}} /></div>
          <div className="br-compare-labels"><span>原稿站姿</span><span>微调站姿</span></div>
          <label className="br-split-label">原版对照分界<input type="range" min="0" max="100" value={split} onChange={e => setSplit(Number(e.target.value))} /></label>
        </div>
        <p className="br-small">原稿继续保留。叶片、五官与四肢拆成独立层；补全关节后方的身体，并用原稿紫色调整交界浅弧。</p>
      </section>
      <section className="br-section"><div className="br-section-heading"><div><span className="br-eyebrow">道具姿态</span><h2>粉笔清楚，握持自然</h2></div><p>粉笔靠紫色身体衬托；所有道具随握持它的小手动作。</p></div><div className="br-tool-grid">{TOOLS.filter(item => item.value !== 'none').map(item => <figure key={item.value}><div><SproutMascot tool={item.value} /></div><figcaption>{item.label}</figcaption></figure>)}</div></section>
      <section className="br-section"><div className="br-section-heading"><div><span className="br-eyebrow">真实入口尺寸</span><h2>缩小以后，还是它</h2></div><p>两种背景同时检查轮廓、五官与透明边缘。</p></div><div className="br-size-grid">{[48,64,96,128].map(height => <figure key={height}><div className="br-size-pair">{[false,true].map(isDark => <div className={isDark ? 'br-size-dark' : ''} key={String(isDark)}><span style={{display:'block',width:height*5/6,height}}><SproutMascot tool={tool} /></span></div>)}</div><figcaption>{height}px 高</figcaption></figure>)}</div></section>
      <footer className="br-footer"><p>本轮微调站姿并重做动作，保留原来的角色身份。独立 Logo 仍留在设计档案中。</p></footer>
    </main>
  )
}

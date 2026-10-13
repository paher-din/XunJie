import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Icon } from '../../icons'
import { correctPortrait, formatDay, useSettings, type PortraitCorrection } from '../../lib/settings'
import { RadarChart } from './RadarChart'
import { Section } from './controls'
import type { TabProps } from '../../pages/SettingsPage'

/**
 * 学生画像 = 「Agent 眼中的我」（CONTEXT.md）：Agent 维护、学生可纠正。
 * 纠正真实生效并记入最近变更列表（docs/settings-design.md 已确认）。
 */
export function PortraitTab({ toast }: TabProps) {
  const { portrait } = useSettings()
  /** 待二次确认的纠正项（就地确认，与会话删除同款模式）。 */
  const [confirming, setConfirming] = useState<string | null>(null)

  const correct = (c: PortraitCorrection, label: string) => {
    correctPortrait(c)
    setConfirming(null)
    toast(`已校准画像数据：${label}`)
  }

  /** 可纠正条目：悬停出校准入口，点击后就地二次确认。 */
  const correctable = (kind: PortraitCorrection['kind'], value: string, node: React.ReactNode, className: string) => {
    const key = `${kind}:${value}`
    if (confirming === key) {
      return (
        <span className={className + ' confirming'} key={value}>
          <span className="st-cf-text">确认移除？</span>
          <button type="button" className="st-cf-yes" onClick={() => correct({ kind, value }, value)}>移除</button>
          <button type="button" className="st-cf-no" onClick={() => setConfirming(null)}>保留</button>
        </span>
      )
    }
    return (
      <span className={className + ' correctable'} key={value}>
        {node}
        <button
          type="button"
          className="st-correct"
          title="校准此项"
          aria-label={`校准画像条目「${value}」`}
          onClick={() => setConfirming(key)}
        >
          <Icon name="dislike" size={13} />
        </button>
      </span>
    )
  }

  return (
    <>
      <Section
        title="学生画像"
        desc="基于学习过程动态评估的能力特征，支持手动校准。"
      >
        <p className="st-maint">
          <Icon name="assistant-mark" size={14} />
          由教学 Agent 动态维护
          <span className="st-sep" aria-hidden="true">·</span>
          <time dateTime={portrait.updatedAt}>{formatDay(portrait.updatedAt)} 更新</time>
        </p>

        <div className="st-portrait-hero">
          <RadarChart dims={portrait.radar} />
          <div className="st-portrait-side">
            <h3 className="st-subtitle">特征标签</h3>
            <div className="st-tags">
              {portrait.tags.map((t) => correctable('tag', t, <span>{t}</span>, 'st-tag'))}
              {portrait.tags.length === 0 && <p className="st-empty">暂无特征标签。随着项目学习深入，Agent 将自动提炼能力特征。</p>}
            </div>
            <div className="st-abilities">
              <div className="st-ability st-strong">
                <h4><Icon name="star" size={15} tone="neutral" />擅长</h4>
                {portrait.strengths.map((s) => correctable('strength', s, <span>{s}</span>, 'st-pill'))}
                {portrait.strengths.length === 0 && <p className="st-empty">暂无评估数据</p>}
              </div>
              <div className="st-ability st-growth">
                <h4><Icon name="graph-up" size={15} tone="neutral" />待加强</h4>
                {portrait.growths.map((g) => correctable('growth', g, <span>{g}</span>, 'st-pill'))}
                {portrait.growths.length === 0 && <p className="st-empty">暂无评估数据</p>}
              </div>
            </div>
          </div>
        </div>

        <div className="st-panel">
          <div className="st-subhead">引导偏好</div>
          <div className="st-tags">
            {portrait.prefs.map((p) => correctable('pref', p, <span>{p}</span>, 'st-pref'))}
            {portrait.prefs.length === 0 && <p className="st-empty">暂无推断偏好</p>}
          </div>
          <p className="st-mini-note">
            自定义辅导风格请前往
            <Link to="/settings/agent" className="st-link"> Agent 个性化 </Link>
            。
          </p>
        </div>
      </Section>

      <Section title="最近变更">
        {portrait.changelog.length > 0 ? (
          <ul className="st-changelog">
            {portrait.changelog.map((c, i) => (
              <li key={`${c.at}-${i}`}>
                <Icon name="clock-circle" size={14} tone="neutral" />
                <span className="st-cl-text">{c.text}</span>
                <time className="st-mono" dateTime={c.at}>{formatDay(c.at)}</time>
              </li>
            ))}
          </ul>
        ) : (
          <div className="st-empty st-empty-box">
            <p className="st-empty-head"><Icon name="clock-circle" size={15} />暂无校准记录</p>
            <p className="st-empty-desc">移除不准确的画像标签后将在此记录。</p>
          </div>
        )}
      </Section>
    </>
  )
}

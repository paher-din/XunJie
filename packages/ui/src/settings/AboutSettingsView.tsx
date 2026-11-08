import { Icon } from '../icons'
import { XunjieLogo } from '../brand/XunjieLogo'
import { Section, Row } from './controls'

export interface AboutSettingsViewProps {
  version: string
  credits: readonly { name: string; role: string; license: string }[]
  checking: 'idle' | 'busy' | 'done'
  checkUpdate: () => void
}
/** Legacy presentation includes demonstration update and local-workspace copy; the caller owns its meaning. */
export function AboutSettingsView({ version, credits, checking, checkUpdate }: AboutSettingsViewProps) {
  return (
    <>
      <div className="st-brand">
        <XunjieLogo format="stacked" className="st-brand-logo" label="循阶" />
        <p className="st-brand-slogan">面向高校项目制教学的个性化智能引导平台</p>
      </div>

      <Section title="版本">
        <div className="st-panel">
          <Row label="当前版本">
            <span className="st-mono">v{version} · 本地工作区</span>
          </Row>
          <Row label="检查更新">
            <span className="st-bound">
              <button className="outline st-xs" disabled={checking === 'busy'} onClick={checkUpdate}>
                {checking === 'busy' ? <span className="st-spinner" aria-hidden="true" /> : <Icon name="refresh" size={13} />}
                {checking === 'busy' ? '正在检查…' : '检查更新'}
              </button>
              {checking === 'done' && (
                <span className="st-test-result inline ok" role="status">
                  <Icon name="check-circle" size={13} />当前已是最新版本
                </span>
              )}
            </span>
          </Row>
        </div>
      </Section>

      <Section title="开源致谢">
        <div className="st-panel st-credits">
          {credits.map((c) => (
            <div className="st-credit" key={c.name}>
              <span className="st-credit-name">{c.name}</span>
              <span className="st-credit-role">{c.role}</span>
              <span className="st-mono st-credit-license">{c.license}</span>
            </div>
          ))}
        </div>
      </Section>

      <footer className="st-event">AI+教育创新技能大赛参赛作品</footer>
    </>
  )
}

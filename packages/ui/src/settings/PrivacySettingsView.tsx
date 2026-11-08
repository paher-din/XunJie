import { Icon } from '../icons'
import { Section, Row } from './controls'
import { ConfirmAction } from './ConfirmAction'

export interface PrivacySettingsViewProps {
  usage: string
  exporting: boolean
  exportData: () => void | Promise<void>
  onClearCache: () => void
  onResetLayouts: () => void
}

export function PrivacySettingsView({ usage, exporting, exportData, onClearCache, onResetLayouts }: PrivacySettingsViewProps) {
  return (
    <>
      <Section title="学习过程记录">
        <div className="st-panel st-records-note">
          <Icon name="clipboard-text" size={18} tone="neutral" />
          <p>
            学习过程记录由教学团队统一归档管理。为保障学情分析与教学评价的完整性，个人无法直接清除历史过程数据；如有勘误需求请联系任课教师。你可随时导出个人数据副本。
          </p>
        </div>
        <div className="st-panel">
          <Row label="导出我的数据" hint="包含画像、配置与对话摘要（敏感凭据已脱敏）">
            <button className="outline st-xs" disabled={exporting} onClick={exportData}>
              <Icon name="download-minimalistic" size={14} />
              {exporting ? '正在导出…' : '导出 JSON'}
            </button>
          </Row>
        </div>
      </Section>

      <Section title="本地数据">
        <div className="st-panel">
          <Row label="本地存储占用">
            <span className="st-mono">{usage}</span>
          </Row>
          <Row label="清除缓存" hint="不影响个人设置与模型配置">
            <ConfirmAction
              label="清除缓存"
              icon={<Icon name="trash-bin-trash" size={13} />}
              confirmText="确认清除？"
              onRun={onClearCache}
            />
          </Row>
          <Row label="重置看板与工作区布局" hint="恢复为系统默认排布">
            <ConfirmAction
              label="重置布局"
              icon={<Icon name="restart" size={13} />}
              confirmText="确认重置？"
              danger
              onRun={onResetLayouts}
            />
          </Row>
        </div>
      </Section>
    </>
  )
}

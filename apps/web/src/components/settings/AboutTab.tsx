import { useState } from 'react'
import { AboutSettingsView } from '@xunjie/ui/settings'
import type { TabProps } from '../../pages/SettingsPage'

export const APP_VERSION = '0.9.0'

const CREDITS: Array<{ name: string; role: string; license: string }> = [
  { name: '霞鹜文楷', role: '标题衬线字体', license: 'SIL OFL 1.1' },
  { name: 'Solar Icon Set', role: '界面图标', license: 'CC BY 4.0' },
  { name: 'OpenMoji', role: '成就徽章与贴纸', license: 'CC BY-SA 4.0' },
  { name: 'React', role: '界面框架', license: 'MIT' },
]

/** 关于：品牌卡 + 版本 + 检查更新（展示）+ 开源致谢 + 赛事署名（footer 克制一行）。 */
export function AboutTab({ toast: _toast }: TabProps) {
  const [checking, setChecking] = useState<'idle' | 'busy' | 'done'>('idle')

  const checkUpdate = () => {
    setChecking('busy')
    window.setTimeout(() => setChecking('done'), 1200)
  }

  return <AboutSettingsView version={APP_VERSION} credits={CREDITS} checking={checking} checkUpdate={checkUpdate} />
}

import { Suspense, lazy } from 'react'
import { Link, Navigate, NavLink, Route, Routes } from 'react-router-dom'
import { Icon, IconText } from '../icons'
import { setThemePreference, useTheme } from '../lib/theme'
import { useTeacher } from './context'
import { TeacherBadge, TeacherButton, TeacherEmpty } from './ui'
import './teacher-settings.css'

const ModelTab = lazy(() => import('../components/settings/ModelTab').then(module => ({ default: module.ModelTab })))

export default function TeacherSettingsPage() {
  const { base, preview, notify } = useTeacher()
  return <>
    <div className="t-heading"><div><div className="t-eyebrow">WORKSPACE PREFERENCES</div><h1>工作台设置</h1><p>管理工作台外观与当前教师账号的模型供应商。</p></div></div>
    <div className="t-settings-layout">
      <nav className="t-settings-nav" aria-label="教师设置导航">
        <NavLink end to={`${base}/settings`} className={({ isActive }) => `st-nav-item${isActive ? ' active' : ''}`}><IconText name="settings" size={17}>通用</IconText></NavLink>
        <NavLink to={`${base}/settings/model`} className={({ isActive }) => `st-nav-item${isActive ? ' active' : ''}`}><IconText name="model" size={17}>模型</IconText></NavLink>
      </nav>
      <div className="t-settings-content st-body-in">
        <Routes>
          <Route index element={<GeneralSettings />} />
          <Route path="model" element={preview
            ? <TeacherEmpty title="模型配置使用真实账号"><p>交互预览不读取或保存模型供应商与密钥。</p><Link className="t-settings-open" to="/teacher/settings/model">进入教师模型配置<Icon name="arrow-right" size={14} /></Link></TeacherEmpty>
            : <Suspense fallback={<p role="status">正在打开模型配置…</p>}><ModelTab toast={notify} /></Suspense>} />
          <Route path="*" element={<Navigate to={`${base}/settings`} replace />} />
        </Routes>
      </div>
    </div>
  </>
}
function GeneralSettings() {
  const { preview, data, notify } = useTeacher()
  const { preference } = useTheme()
  function exportPreview() {
    const file = new Blob([JSON.stringify({ source: 'isolated-teacher-ui-preview', exportedAt: new Date().toISOString(), data }, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(file)
    const link = document.createElement('a')
    link.href = url; link.download = 'xunjie-teacher-preview.json'; link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    notify('已导出本机预览，不包含真实教学记录。')
  }
  return <div className="t-settings-stack">
    <section className="t-panel"><div className="t-section-heading"><h2>外观</h2><Icon name="sun" size={20} /></div><div className="t-settings-row"><div><strong>显示主题</strong><p>与学生空间共享外观偏好，刷新后仍保留。</p></div><select aria-label="显示主题" value={preference} onChange={event => setThemePreference(event.target.value as 'light' | 'dark' | 'system')}><option value="light">浅色</option><option value="dark">深色</option><option value="system">跟随系统</option></select></div></section>
    <section className="t-panel"><div className="t-section-heading"><h2>数据与使用范围</h2><Icon name="shield-check" size={20} /></div><div className="t-settings-row"><div><strong>{preview ? '当前为隔离交互预览' : '当前为真实教学入口'}</strong><p>{preview ? '示例学生、作品、材料和判断均为合成数据。修改保存在当前标签页的预览存储中，不写入课程。' : '仅使用服务端会话授予的教师课程。数据读取失败会明确提示，不切换为示例数据。'}</p></div><TeacherBadge tone={preview ? 'pending' : 'progress'}>{preview ? '合成预览' : '真实课程'}</TeacherBadge></div>{preview && <div className="t-settings-row"><div><strong>导出预览内容</strong><p>保留你调整的项目蓝图、示例材料与审阅内容，便于讨论设计。</p></div><TeacherButton icon="download-minimalistic" onClick={exportPreview}>导出 JSON</TeacherButton></div>}</section>
    <section className="t-panel"><div className="t-section-heading"><h2>教学判断与证据</h2><Icon name="book-2" size={20} /></div><p className="t-settings-copy">作品表现、学科知识、项目能力、AI 协作与实际帮助分别呈现。教师正式评价需要理由与引用；没有观察时保留未知。过程空窗、系统外帮助和模型建议均不转换为独立掌握证明。</p></section>
  </div>
}

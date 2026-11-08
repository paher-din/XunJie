import { Suspense, lazy } from 'react'
import { Link, Navigate, NavLink, Route, Routes } from 'react-router-dom'
import { setThemePreference, useTheme } from '../lib/theme'
import { useTeacher } from './context'
import { TeacherGeneralSettings, TeacherSettingsHeading, TeacherSettingsNavigation, TeacherSettingsModelNotice, TeacherSettingsModelLoading } from '@xunjie/ui/teacher-review'
import './teacher-settings.css'

const ModelTab = lazy(() => import('../components/settings/LegacyModelTab').then(module => ({ default: module.LegacyModelTab })))

export default function TeacherSettingsPage() {
  const { base, preview, notify } = useTeacher()
  return <>
    <TeacherSettingsHeading />
    <div className="t-settings-layout">
      <TeacherSettingsNavigation base={base} LinkComponent={NavLink} />
      <div className="t-settings-content st-body-in">
        <Routes>
          <Route index element={<GeneralSettings />} />
          <Route path="model" element={preview
            ? <TeacherSettingsModelNotice LinkComponent={Link} />
            : <Suspense fallback={<TeacherSettingsModelLoading />}><ModelTab toast={notify} /></Suspense>} />
          <Route path="*" element={<Navigate to={`${base}/settings`} replace />} />
        </Routes>
      </div>
    </div>
  </>
}
export function GeneralSettings() {
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
  return <TeacherGeneralSettings preview={preview} preference={preference} onPreferenceChange={setThemePreference} onExportPreview={exportPreview} />
}

import { createRoot } from 'react-dom/client'
import { LearningApp } from '../product/LearningApp'
import '../styles/app.css'

const root = createRoot(document.getElementById('root')!)
if (new URLSearchParams(location.search).has('diagnostics')) {
  void import('./DiagnosticsPage').then(({ default: DiagnosticsPage }) => root.render(<DiagnosticsPage />))
} else if (new URLSearchParams(location.search).has('teacher') && !new URLSearchParams(location.search).has('authorize')) {
  void import('../teacher-space/TeacherSpace').then(({ TeacherSpace }) => root.render(<TeacherSpace />))
} else root.render(<LearningApp />)

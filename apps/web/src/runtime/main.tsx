import { createRoot } from 'react-dom/client'
import { LearningApp } from '../product/LearningApp'
import '../styles/tokens.css'
import '../styles/fonts.css'
import '../styles/app.css'
import '../icons/icons.css'

const root = createRoot(document.getElementById('root')!)
if (new URLSearchParams(location.search).has('diagnostics')) {
  void import('./DiagnosticsPage').then(({ default: DiagnosticsPage }) => root.render(<DiagnosticsPage />))
} else root.render(<LearningApp />)

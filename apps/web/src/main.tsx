import { lazy, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { LearningApp } from './product/LearningApp'
import { PREP_BUILD } from './workspace/mode'
import './styles/tokens.css'
import './styles/fonts.css'
import './styles/app.css'
import './icons/icons.css'

const LegacyApp = lazy(() => import('./LegacyApp'))
// Legacy execution and teacher consumers retain their own business entry until their WP replaces it.
// Preparation is an explicit UI reference; it is never the production fallback.
const legacy = PREP_BUILD || /^#\/(teacher|task|settings|icons|brand|dev)(?:\/|$)/.test(location.hash)
createRoot(document.getElementById('root')!).render(legacy
  ? <Suspense fallback={<p>正在打开…</p>}><LegacyApp /></Suspense> : <LearningApp />)

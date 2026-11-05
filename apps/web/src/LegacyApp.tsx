import { lazy, Suspense, useEffect } from 'react'
import { createHashRouter, Navigate, RouterProvider } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import AppShell from './components/AppShell'
import SessionEntry from './components/SessionEntry'
import HomePage from './pages/HomePage'
import SettingsPage from './pages/SettingsPage'
import TaskRoute from './pages/TaskRoute'
import './styles/tokens.css'
import './styles/fonts.css'
import './styles/app.css'
import './icons/icons.css'
import { PREP_BUILD } from './workspace/mode'

const AgentPage = PREP_BUILD ? lazy(() => import('./pages/AgentPage')) : null
const IconBoardPage = lazy(() => import('./icons/IconBoard'))
const BrandBoardPage = lazy(() => import('./brand/BrandBoard'))
const TeacherApp = lazy(() => import('./teacher/TeacherApp'))
const TeacherPreview = import.meta.env.DEV ? lazy(() => import('./teacher/TeacherPreview')) : null
const WorkspaceReferencesPreview = import.meta.env.DEV ? lazy(() => import('./pages/previews/WorkspaceReferencesPreview')) : null
const GuidancePreview = import.meta.env.DEV ? lazy(() => import('./pages/previews/GuidancePreview')) : null

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
})

// hash 路由：桌面宿主直接加载静态资源，无需服务端路由回退。
const router = createHashRouter([
  // Leave the legacy router before mounting LearningApp's browser router and activity workspace.
  ...(!PREP_BUILD ? [{ path: 'agent/*', element: <LearningAppEntry /> }] : []),
  ...(WorkspaceReferencesPreview ? [{ path: 'dev/workspace-references', element: <Suspense fallback={<div>加载选区引用验收页…</div>}><WorkspaceReferencesPreview /></Suspense> }] : []),
  ...(GuidancePreview ? [{ path: 'dev/guidance', element: <Suspense fallback={<div>加载引导展示验收页…</div>}><GuidancePreview /></Suspense> }] : []),
  ...(TeacherPreview ? [{ path: 'teacher/preview/*', element: <Suspense fallback={<div>加载教师预览…</div>}><TeacherPreview /></Suspense> }] : []),
  { path: 'teacher/*', element: <SessionEntry><Suspense fallback={<div>加载教师工作台…</div>}><TeacherApp /></Suspense></SessionEntry> },
  { path: 'icons', element: <Suspense fallback={<div>加载图标看板…</div>}><IconBoardPage /></Suspense> },
  { path: 'brand', element: <Suspense fallback={<div>加载品牌看板…</div>}><BrandBoardPage /></Suspense> },
  {
    path: '/',
    element: <SessionEntry><AppShell /></SessionEntry>,
    children: [
      { index: true, element: PREP_BUILD ? <HomePage /> : <LearningAppEntry /> },
      ...(AgentPage ? [
        { path: 'agent', element: <Suspense fallback={<p>正在打开…</p>}><AgentPage /></Suspense> },
        { path: 'agent/:conversationId', element: <Suspense fallback={<p>正在打开…</p>}><AgentPage /></Suspense> },
      ] : []),
      { path: 'settings', element: <Navigate to="/settings/account" replace /> },
      { path: 'settings/:tab', element: <SettingsPage /> },
      { path: 'task/:taskId', element: <TaskRoute /> },
    ],
  },
])

function LearningAppEntry() {
  useEffect(() => {
    const url = new URL(location.href)
    url.hash = ''
    location.replace(url)
  }, [])
  return <p>正在返回学习空间…</p>
}

export default function LegacyApp() {
  return <QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>
}

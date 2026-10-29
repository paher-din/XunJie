import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { createHashRouter, Navigate, RouterProvider } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import AppShell from './components/AppShell'
import SessionEntry from './components/SessionEntry'
import AgentPage from './pages/AgentPage'
import HomePage from './pages/HomePage'
import SettingsPage from './pages/SettingsPage'
import TaskRoute from './pages/TaskRoute'
import './styles/tokens.css'
import './styles/fonts.css'
import './styles/app.css'
import './icons/icons.css'

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
      { index: true, element: <HomePage /> },
      { path: 'agent', element: <AgentPage /> },
      { path: 'agent/:conversationId', element: <AgentPage /> },
      { path: 'settings', element: <Navigate to="/settings/account" replace /> },
      { path: 'settings/:tab', element: <SettingsPage /> },
      { path: 'task/:taskId', element: <TaskRoute /> },
    ],
  },
])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)

import { createContext, useContext } from 'react'
import type { TeacherWorkspace } from './types'

export const TeacherContext = createContext<TeacherWorkspace | null>(null)
export function useTeacher(): TeacherWorkspace {
  const context = useContext(TeacherContext)
  if (!context) throw new Error('Teacher workspace is not mounted')
  return context
}

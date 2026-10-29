/** 展示名称来自已授权的后端投影；缺省时保留原身份或活动标题。 */
export const displayAccountName = (userId: string, displayName?: string) => displayName?.trim() || userId
export const displayCourseName = (courseId: string, name?: string) => name?.trim() || `课程 ${courseId}`
export const displayProjectName = (title: string, displayTitle?: string) => displayTitle?.trim() || title

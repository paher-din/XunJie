/** 本机展示别名；认证、请求、路由和存储身份始终使用原 ID。 */
const accountNames = new Map([
  ['synthetic-robert-student-a', 'Robert'],
  ['synthetic-robert-student-b', '小林'],
])

const courseNames = new Map([
  ['synthetic-robert-course-c', '程序设计基础'],
  ['synthetic-robert-course-hdl', '数字逻辑与部件设计'],
])

export const displayAccountName = (userId: string) => accountNames.get(userId) ?? userId
export const displayCourseName = (courseId: string) => courseNames.get(courseId) ?? `课程 ${courseId}`

export const displayProjectName = (title: string) =>
  title === 'TextScope Core 本机合成工程验证' ? '文本分析工具' : title

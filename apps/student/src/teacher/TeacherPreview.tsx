import TeacherApp from './TeacherApp'
import { createPreviewData } from './demo'

export default function TeacherPreview() {
  return <TeacherApp preview initialData={createPreviewData} />
}

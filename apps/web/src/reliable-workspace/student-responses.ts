import type { TeachingStudentResponseInput, TeachingStudentResponseReceipt } from '@xunjie/contracts/teaching-agent'
import { ReliableRecordStore } from './record-store'

export interface LocalStudentResponse {
  key: string; scope: string; presentationId: string
  mode: 'choice' | 'text'; optionId: string; text: string
  input?: TeachingStudentResponseInput; receipt?: TeachingStudentResponseReceipt
}

/** The fixed response identity and its input commit together before any business POST. */
export class StudentResponseStore extends ReliableRecordStore<LocalStudentResponse> {
  constructor() { super('studentResponses') }
}

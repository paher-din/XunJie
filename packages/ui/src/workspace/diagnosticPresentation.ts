import type { CodeRange } from './codeSelection'
/** Public display data only; checking and snapshot validation stay in the application. */
export interface EditorDiagnostic {
  fileId?: string; path?: string; contentHash?: string
  severity: 'error' | 'warning' | 'info'; message: string; line?: number; range?: CodeRange
}
export interface EditorDiagnosticMarkers { fileId: string; originalText: string; diagnostics: EditorDiagnostic[] }
export type DiagnosticStatus = 'ready' | 'unsupported' | 'paused' | 'busy' | 'stale' | 'timeout' | 'unavailable'
export interface EditorDiagnosticsDisplay {
  status: DiagnosticStatus | 'pending' | 'unconfirmed'
  result: { status: DiagnosticStatus; diagnostics: EditorDiagnostic[] } | null
  markers?: EditorDiagnosticMarkers
}
export const diagnosticStatusText: Record<DiagnosticStatus | 'pending' | 'unconfirmed', string> = {
  ready: '检查完成，未发现问题', unsupported: '此文件类型暂不支持编辑检查', paused: '编辑检查已暂停',
  busy: '等待执行资源', stale: '等待最新版本', timeout: '编辑检查超时', unavailable: '编辑检查暂不可用',
  pending: '正在检查代码', unconfirmed: '新文件或文件变更请先确认保存，再检查草稿',
}

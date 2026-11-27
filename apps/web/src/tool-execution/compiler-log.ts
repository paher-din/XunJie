import type { EditorDiagnostic } from '@xunjie/ui/workspace'
import type { ExecutionRecord } from './ledger'

export const compileFailureHeading = '编译未完成'

export function isCompileFailure(record: ExecutionRecord) {
  return record.query.state === 'failed' && record.query.reason?.detail.split('\n', 1)[0] === compileFailureHeading
}

export function parseCompilerLog(text: string): EditorDiagnostic[] {
  return text.split(/\r?\n/).filter(line => line.trim()).map(text => {
    const match = /^(?:\.\/|\/)?([^:]+):([1-9]\d*)(?::([1-9]\d*))?:\s*(.+)$/.exec(text)
    const message = match?.[4] ?? text
    const severity = /^warning\b/i.test(message) ? 'warning'
      : /^note\b/i.test(message) || !match && !/^(?:error|fatal)\b/i.test(message) ? 'info' : 'error'
    if (!match) return { severity, message }
    const line = Number(match[2]), column = Number(match[3])
    return { severity, message, path: match[1], line,
      ...(column ? { range: { startLine: line, startColumn: column, endLine: line, endColumn: column } } : {}) }
  })
}

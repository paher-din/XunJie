import { manifestRows, record, textHash } from './confirmation'
import type { SnapshotFile } from './workspaceContracts'
import type { CodeRange } from './tutoringObject'
import { codeRangeModelOffsets } from './tutoringObject'
import type { ExecutionNodesState } from './executionNodes'
import type { CommandContext } from './frozenCommand'

/** Diagnostics use the current browser choice; readiness does not imply the optional compiler extension exists. */
export function diagnosticNodeTarget(context: Pick<CommandContext, 'mode' | 'userId'> | null | undefined, path: string | undefined, nodes: ExecutionNodesState): { ready: boolean; nodeId?: string } {
  if (context?.mode === 'preparation') return { ready: true }
  if (!context?.userId || nodes.userId !== context.userId) return { ready: false }
  if (nodes.status === 'unsupported') return { ready: true }
  if (nodes.status !== 'ready') return { ready: false }
  const node = nodes.nodes.find(node => node.nodeId === nodes.selectedNodeId)
  return { ready: !!node && (/\.(v|vh|sv|svh)$/i.test(path ?? '') ? node.hdlReady : node.cReady), ...(node ? { nodeId: node.nodeId } : {}) }
}

export interface EditorDiagnostic {
  fileId?: string; path?: string; contentHash?: string
  severity: 'error' | 'warning' | 'info'; message: string; line?: number; range?: CodeRange
}
export type DiagnosticStatus = 'ready' | 'unsupported' | 'paused' | 'busy' | 'stale' | 'timeout' | 'unavailable'
export interface EditorDiagnosticsResult {
  status: DiagnosticStatus; sourceHash: string; provider?: 'gcc' | 'iverilog'; diagnostics: EditorDiagnostic[]
}
export interface EditorDiagnosticMarkers { fileId: string; originalText: string; diagnostics: EditorDiagnostic[] }
const statuses = ['ready', 'unsupported', 'paused', 'busy', 'stale', 'timeout', 'unavailable']
export async function diagnosticSources(files: SnapshotFile[]) {
  const sources = await Promise.all(files.map(async file => ({ ...file, contentHash: await textHash(file.text) })))
  return { sources, hash: await textHash(JSON.stringify(manifestRows(sources))) }
}
export function verifyEditorDiagnostics(value: unknown, hash: string, files: SnapshotFile[]): EditorDiagnosticsResult {
  const result = record(value)
  if (!statuses.includes(String(result.status)) || !/^[a-f0-9]{64}$/.test(String(result.sourceHash)) ||
    result.status === 'ready' && result.sourceHash !== hash ||
    result.provider !== undefined && !['gcc', 'iverilog'].includes(String(result.provider)) ||
    !Array.isArray(result.diagnostics) || result.diagnostics.length > 100 || JSON.stringify(result).length > 65536)
    throw new Error('诊断响应不可用')
  if (result.status !== 'ready' && result.diagnostics.length) throw new Error('未完成的检查包含代码诊断')
  for (const raw of result.diagnostics) {
    const item = record(raw)
    if (!['error', 'warning', 'info'].includes(String(item.severity)) || typeof item.message !== 'string' ||
      !item.message || item.message.length > 4000) throw new Error('诊断消息不可用')
    const file = files.find(file => file.fileId === item.fileId)
    if (item.fileId !== undefined && (!file || file.path !== item.path || file.contentHash !== item.contentHash)) throw new Error('诊断来源已变化')
    if (item.line !== undefined && (!file || !Number.isSafeInteger(item.line) || Number(item.line) < 1 ||
      Number(item.line) > file.text.split('\n').length)) throw new Error('诊断行不可用')
    if (item.range && (!file || !codeRangeModelOffsets(file.text, item.range as CodeRange))) throw new Error('诊断位置不可用')
  }
  return result as unknown as EditorDiagnosticsResult
}

export const diagnosticStatusText: Record<DiagnosticStatus | 'pending' | 'unconfirmed', string> = {
  ready: '检查完成，未发现问题', unsupported: '此文件类型暂不支持编辑检查', paused: '编辑检查已暂停',
  busy: '等待执行资源', stale: '等待最新版本', timeout: '编辑检查超时', unavailable: '编辑检查暂不可用',
  pending: '正在检查代码', unconfirmed: '新文件或文件变更请先确认保存，再检查草稿',
}

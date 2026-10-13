import { record, requiredId, revision, textHash } from './confirmation'
import { pathProblem, utf8Bytes } from '../lib/projectFiles'
import type { RunView, ResultFile, RunFiles } from './runContracts'
export type { ResultFile, RunFiles } from './runContracts'
const hashPattern = /^[a-f0-9]{64}$/

/** 只接纳固定 Run 的公开文件；完整文本才进入查看/下载边界。 */
export async function verifyRunFiles(value: unknown, run: RunView): Promise<RunFiles> {
  const response = record(value)
  if (run.mode === 'check') {
    if (response.status !== 'redacted') throw new Error('检查产物未裁剪')
    return { status: 'redacted' }
  }
  if (response.status === 'redacted' || response.status === 'unavailable') return { status: response.status }
  if (response.status !== 'available' || !Array.isArray(response.files)) throw new Error('产物清单不可用')
  const files: ResultFile[] = [], ids = new Set<string>()
  let bytes = 0
  for (const value of response.files) {
    const f = record(value)
    if (f.runId !== run.runId || f.snapshotId !== run.snapshotId || f.source !== 'runner_result_file' ||
      typeof f.relativeName !== 'string' || pathProblem(f.relativeName, []) ||
      !['complete', 'incomplete', 'missing'].includes(String(f.status))) throw new Error('产物来源不符')
    const resultFileId = requiredId(f.resultFileId), caseIndex = revision(f.caseIndex)
    if (!hashPattern.test(resultFileId) || ids.has(resultFileId)) throw new Error('产物 ID 不符')
    ids.add(resultFileId)
    if (f.contentHash !== undefined && (typeof f.contentHash !== 'string' || !hashPattern.test(f.contentHash))) throw new Error('产物摘要不符')
    if (f.bytes !== undefined && (revision(f.bytes) > 65536)) throw new Error('产物超过限额')
    if (resultFileId !== await textHash(JSON.stringify([run.runId, run.snapshotId, caseIndex, f.relativeName, f.contentHash]))) throw new Error('产物稳定 ID 不符')
    if (f.status === 'complete' && typeof f.text !== 'string') throw new Error('完整产物缺正文')
    if (f.text !== undefined) {
      if (typeof f.text !== 'string' || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(f.text) ||
        utf8Bytes(f.text) !== f.bytes || await textHash(f.text) !== f.contentHash) throw new Error('产物文本校验失败')
      bytes += utf8Bytes(f.text)
    }
    files.push({ relativeName: f.relativeName, status: f.status as ResultFile['status'], runId: run.runId,
      snapshotId: run.snapshotId, resultFileId, source: 'runner_result_file', caseIndex,
      ...(f.contentHash !== undefined ? { contentHash: f.contentHash as string } : {}),
      ...(f.bytes !== undefined ? { bytes: f.bytes as number } : {}),
      ...(f.status === 'complete' ? { text: f.text as string } : {}) })
  }
  const d = run.diagnostics
  if (bytes + (d.status === 'available' ? utf8Bytes(`${d.stdout ?? ''}${d.stderr ?? ''}`) : 0) > 65536) throw new Error('输出与产物合计超过限额')
  return { status: 'available', files }
}

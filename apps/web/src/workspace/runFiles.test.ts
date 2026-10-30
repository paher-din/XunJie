import { expect, it } from 'vitest'
import { textHash } from './confirmation'
import { verifyRunFiles } from './runFiles'
import type { RunView } from './runContracts'

const run: RunView = { runId: 'run', jobId: 'job', snapshotId: 'snapshot', snapshotHash: 'a'.repeat(64),
  mode: 'run', runtimeProfileVersion: 'profile', imageDigest: `sha256:${'b'.repeat(64)}`,
  diagnostics: { runId: 'run', snapshotId: 'snapshot', snapshotHash: 'a'.repeat(64), source: 'runner_diagnostics', status: 'unavailable' } }
async function file(status = 'complete') {
  const text = '\ufeff结果\r\n<script>bad()</script>\n', contentHash = await textHash(text)
  return { relativeName: 'reports/result.txt', status, text, contentHash, bytes: new TextEncoder().encode(text).length,
    runId: 'run', snapshotId: 'snapshot', source: 'runner_result_file', caseIndex: 0,
    resultFileId: await textHash(JSON.stringify(['run', 'snapshot', 0, 'reports/result.txt', contentHash])) }
}
it('只有完整且来源、稳定 ID、UTF-8 字节数与 hash 均匹配的公开产物可取文本', async () => {
  const original = await file()
  expect(await verifyRunFiles({ status: 'available', files: [original] }, run)).toEqual({ status: 'available', files: [original] })
  for (const patch of [{ runId: 'other' }, { snapshotId: 'other' }, { resultFileId: 'c'.repeat(64) },
    { bytes: original.text.length }, { text: original.text + 'x' }, { relativeName: '../escape.txt' }]) {
    await expect(verifyRunFiles({ status: 'available', files: [{ ...original, ...patch }] }, run)).rejects.toThrow()
  }
})
it('裁剪/不可用单列，missing/incomplete 不补正文；检查不能用文件或 stdout 泄露私有内容', async () => {
  expect(await verifyRunFiles({ status: 'unavailable', text: 'secret' }, run)).toEqual({ status: 'unavailable' })
  const incomplete = await file('incomplete')
  const result = await verifyRunFiles({ status: 'available', files: [incomplete] }, run)
  expect(result.status === 'available' && result.files[0]!.text).toBeUndefined()
  const missing = { ...await file('missing'), text: undefined, contentHash: undefined, bytes: undefined }
  missing.resultFileId = await textHash(JSON.stringify(['run', 'snapshot', 0, missing.relativeName, undefined]))
  expect((await verifyRunFiles({ status: 'available', files: [missing] }, run)).status).toBe('available')
  const check = { ...run, mode: 'check' as const }
  expect(await verifyRunFiles({ status: 'redacted', files: [incomplete] }, check)).toEqual({ status: 'redacted' })
  await expect(verifyRunFiles({ status: 'available', files: [incomplete] }, check)).rejects.toThrow()
  await expect(verifyRunFiles({ status: 'available', files: [{ ...await file(), text: undefined }] }, run)).rejects.toThrow()
})

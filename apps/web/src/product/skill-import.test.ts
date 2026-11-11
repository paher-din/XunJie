import { expect, it, vi } from 'vitest'
import type { TeachingSkillCatalogEntry, TeachingSkillImport } from '@xunjie/contracts/agent-skills'
import { discoverLocalSkills, LocalSkillImportBatch } from './skill-import'

function sourceFile(path: string, content: string) {
  const file = new File([content], path.split('/').at(-1)!)
  Object.defineProperty(file, 'webkitRelativePath', { value: path })
  return file
}
const skillFile = (name: string) => sourceFile(`collection/${name}/SKILL.md`, `---\nname: ${name}\ndescription: 说明\n---\n${name} 原文`)
const nameOf = (input: TeachingSkillImport) => /^name: (.+)$/m.exec(input.files.find(file => file.path === 'SKILL.md')!.content)![1]!
const ids = new Map<string, string>()
function entry(name: string): TeachingSkillCatalogEntry {
  const skillId = ids.get(name) ?? crypto.randomUUID(); ids.set(name, skillId)
  return { skillId, version: 1, name, description: '说明', metadata: { name, description: '说明', dependencies: [], conflicts: [], 'allowed-tools': [] },
    source: '本地文件', packageVersion: '1', digest: 'a'.repeat(64), attachments: [], origin: 'personal', selected: true, disabled: false, required: false }
}
const rejected = (reason = 'name') => Object.assign(new Error('invalid-skill'), { code: 'invalid-skill', reason })
const options = (request: (input: TeachingSkillImport) => Promise<unknown>) => ({ request, isActive: () => true, onProgress: vi.fn() })

it('discovers independent skill roots at different depths and keeps nested documents with their owner', () => {
  const alpha = skillFile('alpha'), nested = sourceFile('collection/alpha/references/SKILL.md', '# 参考'),
    beta = sourceFile('collection/wrapped/beta/SKILL.md', '---\nname: beta\ndescription: 说明\n---\n正文'),
    binary = sourceFile('collection/wrapped/beta/assets/data.bin', 'bytes')
  const groups = discoverLocalSkills([sourceFile('collection/README.md', '合集说明'), alpha, nested, beta, binary,
    sourceFile('collection/.git/example/SKILL.md', '仓库历史')])
  expect(groups.map(group => group.path)).toEqual(['alpha', 'wrapped/beta'])
  expect(groups.map(group => group.files)).toEqual([[alpha, nested], [beta, binary]])
})

it('keeps a selected root skill as one package and rejects folders without a document', () => {
  const root = sourceFile('bundle/SKILL.md', 'root'), nested = sourceFile('bundle/child/SKILL.md', 'child')
  expect(discoverLocalSkills([nested, root])).toEqual([{ path: 'bundle', files: [nested, root] }])
  expect(() => discoverLocalSkills([sourceFile('folder/README.md', '说明')])).toThrow('没有找到 SKILL.md')
})

it('applies file limits per package rather than to the collection total', async () => {
  const files = ['large-a', 'large-b'].flatMap(name => [skillFile(name), ...[1, 2].map(index => {
    const file = sourceFile(`collection/${name}/assets/${index}.bin`, 'fixed bytes')
    Object.defineProperty(file, 'size', { value: 20 * 1024 * 1024 })
    return file
  })])
  const request = vi.fn(async (input: TeachingSkillImport) => entry(nameOf(input)))
  const progress = await new LocalSkillImportBatch(files, []).run(options(request))
  expect(progress.completed).toBe(2)
  expect(request).toHaveBeenCalledTimes(2)
})

it('continues past definite failures and retries only unfinished packages with a fresh request', async () => {
  const writes: TeachingSkillImport[] = []
  let failed = false
  const request = vi.fn(async (input: TeachingSkillImport) => {
    writes.push(input)
    if (nameOf(input) === 'beta' && !failed) { failed = true; throw rejected() }
    return entry(nameOf(input))
  })
  const batch = new LocalSkillImportBatch(['alpha', 'beta', 'gamma'].map(skillFile), [])
  const first = await batch.run(options(request))
  expect(writes.map(nameOf)).toEqual(['alpha', 'beta', 'gamma'])
  expect(first).toMatchObject({ imported: 2, remaining: 1, uncertain: false, pauseReason: null, running: false, current: null })
  expect(first.failures[0]?.path).toBe('beta')
  const final = await batch.run(options(request))
  expect(writes.map(nameOf)).toEqual(['alpha', 'beta', 'gamma', 'beta'])
  expect(writes[3]!.requestId).not.toBe(writes[1]!.requestId)
  expect(final).toMatchObject({ imported: 3, remaining: 0, failures: [] })
})

it.each(['network', 'malformed-response'])('pauses on %s and resumes the exact input without rereading it', async failure => {
  const files = ['alpha', 'beta', 'gamma'].map(skillFile)
  const readBeta = vi.spyOn(files[1]!, 'arrayBuffer')
  const writes: TeachingSkillImport[] = []
  let failed = false
  const request = async (input: TeachingSkillImport) => {
    writes.push(input)
    if (nameOf(input) === 'beta' && !failed) {
      failed = true
      if (failure === 'network') throw new TypeError('lost ACK')
      return { unexpected: true }
    }
    return entry(nameOf(input))
  }
  const batch = new LocalSkillImportBatch(files, [])
  expect(await batch.run(options(request))).toMatchObject({ imported: 1, remaining: 2, uncertain: true, pauseReason: 'unconfirmed' })
  expect(writes.map(nameOf)).toEqual(['alpha', 'beta'])
  readBeta.mockRejectedValue(new Error('The original files must not be reread'))
  expect(await batch.run(options(request))).toMatchObject({ imported: 3, remaining: 0, uncertain: false })
  expect(writes.map(nameOf)).toEqual(['alpha', 'beta', 'beta', 'gamma'])
  expect(writes[2]).toBe(writes[1])
  expect(readBeta).toHaveBeenCalledOnce()
})

it('confirms an uncertain request before retrying earlier definite failures', async () => {
  const writes: TeachingSkillImport[] = []
  let firstRun = true
  const request = async (input: TeachingSkillImport) => {
    writes.push(input)
    if (firstRun && nameOf(input) === 'alpha') throw rejected()
    if (firstRun && nameOf(input) === 'beta') throw new TypeError('lost ACK')
    return entry(nameOf(input))
  }
  const batch = new LocalSkillImportBatch(['alpha', 'beta', 'gamma'].map(skillFile), [])
  expect(await batch.run(options(request))).toMatchObject({ completed: 0, remaining: 3, uncertain: true })
  firstRun = false
  expect(await batch.run(options(request))).toMatchObject({ imported: 3, remaining: 0, uncertain: false })
  expect(writes.map(nameOf)).toEqual(['alpha', 'beta', 'beta', 'alpha', 'gamma'])
  expect(writes[2]).toBe(writes[1])
  expect(writes[3]!.requestId).not.toBe(writes[0]!.requestId)
})

it('pauses at capacity and retries that package with a new ID before continuing', async () => {
  const writes: TeachingSkillImport[] = []
  let full = true
  const request = async (input: TeachingSkillImport) => {
    writes.push(input)
    if (nameOf(input) === 'beta' && full) throw rejected('skill-limit')
    return entry(nameOf(input))
  }
  const batch = new LocalSkillImportBatch(['alpha', 'beta', 'gamma'].map(skillFile), [])
  const paused = await batch.run(options(request))
  expect(paused).toMatchObject({ remaining: 2, uncertain: false, pauseReason: 'capacity' })
  expect(paused.failures[0]?.message).toContain('32')
  expect(writes.map(nameOf)).toEqual(['alpha', 'beta'])
  full = false
  expect(await batch.run(options(request))).toMatchObject({ remaining: 0, imported: 3 })
  expect(writes.map(nameOf)).toEqual(['alpha', 'beta', 'beta', 'gamma'])
  expect(writes[2]!.requestId).not.toBe(writes[1]!.requestId)
})

it.each(['stop', 'inactive'])('sends no subsequent requests after %s and can resume later', async mode => {
  const batch = new LocalSkillImportBatch(['alpha', 'beta', 'gamma'].map(skillFile), [])
  let complete!: () => void, started!: () => void, active = true
  const start = new Promise<void>(resolve => { started = resolve })
  const pending = new Promise<void>(resolve => { complete = resolve })
  const writes: TeachingSkillImport[] = []
  const request = async (input: TeachingSkillImport) => {
    writes.push(input)
    if (writes.length === 1) { started(); await pending }
    return entry(nameOf(input))
  }
  const runOptions = { ...options(request), isActive: () => active }
  const first = batch.run(runOptions)
  await start
  if (mode === 'stop') batch.stop(); else active = false
  complete()
  expect(await first).toMatchObject({ completed: 1, remaining: 2, pauseReason: 'stopped' })
  expect(writes).toHaveLength(1)
  active = true
  expect(await batch.run(runOptions)).toMatchObject({ completed: 3, remaining: 0 })
  expect(writes.map(nameOf)).toEqual(['alpha', 'beta', 'gamma'])
})

it('coalesces overlapping runs and counts existing IDs without creating another import', async () => {
  const known = entry('known')
  const request = vi.fn(async (_input: TeachingSkillImport) => known)
  const batch = new LocalSkillImportBatch([skillFile('alpha'), skillFile('beta')], [known.skillId])
  const first = batch.run(options(request)), second = batch.run(options(request))
  expect(second).toBe(first)
  const result = await first
  expect(result).toMatchObject({ completed: 2, imported: 0, existing: 2, remaining: 0, confirmedIds: [known.skillId] })
  await batch.run(options(request))
  expect(request).toHaveBeenCalledTimes(2)
})

it('keeps unreadable documents as individual failures rather than blocking other skills', async () => {
  const broken = new File([new Uint8Array([255])], 'SKILL.md')
  Object.defineProperty(broken, 'webkitRelativePath', { value: 'collection/alpha/SKILL.md' })
  const request = vi.fn(async (input: TeachingSkillImport) => entry(nameOf(input)))
  const result = await new LocalSkillImportBatch([broken, skillFile('beta')], []).run(options(request))
  expect(result).toMatchObject({ imported: 1, remaining: 1, uncertain: false })
  expect(result.failures[0]).toMatchObject({ path: 'alpha', message: expect.stringContaining('UTF-8') })
  expect(request).toHaveBeenCalledOnce()
})

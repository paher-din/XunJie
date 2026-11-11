import { teachingSkillCatalogEntrySchema, type TeachingSkillImport } from '@xunjie/contracts/agent-skills'
import { readSkillPackage, skillImportErrorMessage, skillImportInput } from './skills'

export type LocalSkillImportGroup = { path: string; files: File[] }
export type LocalSkillImportProgress = {
  total: number; completed: number; imported: number; existing: number; remaining: number
  running: boolean; uncertain: boolean; pauseReason: 'stopped' | 'unconfirmed' | 'capacity' | null
  current: { index: number; total: number; path: string } | null
  failures: { path: string; message: string }[]; confirmedIds: string[]
}

const filePath = (file: File) => file.webkitRelativePath || file.name

/** Root documents own their entire subtree, including nested skill examples. */
export function discoverLocalSkills(selectedFiles: readonly File[]): LocalSkillImportGroup[] {
  const files = selectedFiles.filter(file => !filePath(file).split('/').some(part => part.toLowerCase() === '.git'))
  const roots = [...new Set(files.map(filePath)
    .filter(path => path === 'SKILL.md' || path.endsWith('/SKILL.md'))
    .map(path => path.slice(0, -'SKILL.md'.length)))].sort()
  const independent: string[] = []
  for (const root of roots) if (!independent.some(parent => root.startsWith(parent))) independent.push(root)
  if (!independent.length) throw new Error('所选文件夹中没有找到 SKILL.md，请选择技能文件夹。')
  const first = filePath(files[0]!).split('/')[0]!
  const selectedPrefix = files.every(file => filePath(file).startsWith(first + '/')) ? first + '/' : ''
  return independent.map(root => ({
    path: root.slice(selectedPrefix.length).replace(/\/$/, '') || root.replace(/\/$/, '') || '所选技能',
    files: files.filter(file => filePath(file).startsWith(root)),
  }))
}

type ImportItem = LocalSkillImportGroup & {
  state: 'waiting' | 'failed' | 'uncertain' | 'done'
  input: TeachingSkillImport | undefined; message: string | undefined
}
type RunOptions = {
  request(input: TeachingSkillImport): Promise<unknown>
  isActive(): boolean
  onProgress(progress: LocalSkillImportProgress): void
}
const definiteFailures = new Set(['invalid', 'invalid-skill', 'conflict', 'identity-conflict', 'forbidden', 'missing'])

function failureMessage(cause: unknown, requestStarted: boolean) {
  const specific = skillImportErrorMessage(cause)
  if (specific) return specific
  const code = (cause as { code?: string } | null)?.code
  if (code === 'forbidden') return '没有导入此技能的权限，请检查当前账号。'
  if (code === 'conflict' || code === 'identity-conflict') return '技能已在其他位置更新，请重新选择文件夹。'
  if (code === 'missing') return '暂时无法找到这个技能，请重新选择文件夹。'
  if (code === 'invalid' || code === 'invalid-skill') return '无法导入这个技能，请检查文件内容，或重新选择技能文件夹。'
  if (!requestStarted) return cause instanceof Error && /[\u3400-\u9fff]/.test(cause.message)
    ? cause.message : '无法读取技能文件夹，请重新选择。'
  return '暂时无法确认导入结果，请重试。'
}

/** Keep at most one uncertain request and resume it without changing its bytes or ID. */
export class LocalSkillImportBatch {
  private readonly items: ImportItem[]
  private readonly knownIds: Set<string>
  private readonly confirmedIds = new Set<string>()
  private imported = 0
  private existing = 0
  private running = false
  private stopRequested = false
  private pauseReason: LocalSkillImportProgress['pauseReason'] = null
  private current: LocalSkillImportProgress['current'] = null
  private execution: Promise<LocalSkillImportProgress> | null = null

  constructor(selectedFiles: readonly File[], knownSkillIds: readonly string[]) {
    this.items = discoverLocalSkills(selectedFiles).map(group => ({ ...group, state: 'waiting', input: undefined, message: undefined }))
    this.knownIds = new Set(knownSkillIds)
  }

  get progress(): LocalSkillImportProgress {
    const completed = this.items.filter(item => item.state === 'done').length
    return { total: this.items.length, completed, imported: this.imported, existing: this.existing,
      remaining: this.items.length - completed, running: this.running,
      uncertain: this.items.some(item => item.state === 'uncertain'), pauseReason: this.pauseReason,
      current: this.current ? { ...this.current } : null,
      failures: this.items.flatMap(item => item.state !== 'done' && item.message ? [{ path: item.path, message: item.message }] : []),
      confirmedIds: [...this.confirmedIds] }
  }

  stop() {
    if (this.running) { this.stopRequested = true; this.pauseReason = 'stopped' }
  }

  run(options: RunOptions): Promise<LocalSkillImportProgress> {
    if (this.execution) return this.execution
    this.running = true; this.stopRequested = false; this.pauseReason = null
    const execution = Promise.resolve().then(() => this.execute(options)).finally(() => {
      if (this.execution === execution) this.execution = null
    })
    this.execution = execution
    return execution
  }

  private async execute(options: RunOptions): Promise<LocalSkillImportProgress> {
    const pending = [
      ...this.items.filter(item => item.state === 'uncertain'),
      ...this.items.filter(item => item.state === 'waiting' || item.state === 'failed'),
    ]
    try {
      for (const [index, item] of pending.entries()) {
        if (this.stopRequested || !options.isActive()) { this.pauseReason = 'stopped'; break }
        this.current = { index: index + 1, total: pending.length, path: item.path }
        item.message = undefined
        options.onProgress(this.progress)
        let requestStarted = false
        try {
          if (!item.input) {
            const files = await readSkillPackage(item.files)
            if (this.stopRequested || !options.isActive()) { this.pauseReason = 'stopped'; break }
            item.input = skillImportInput({ requestId: crypto.randomUUID(), source: '本地文件',
              packageVersion: new Date().toISOString(), files })
          }
          if (this.stopRequested || !options.isActive()) { this.pauseReason = 'stopped'; break }
          requestStarted = true
          const entry = teachingSkillCatalogEntrySchema.parse(await options.request(item.input))
          if (this.knownIds.has(entry.skillId)) this.existing++
          else { this.imported++; this.knownIds.add(entry.skillId) }
          this.confirmedIds.add(entry.skillId)
          item.state = 'done'; item.input = undefined; item.files = []; item.message = undefined
        } catch (cause) {
          const error = cause as { code?: string; reason?: string } | null
          item.message = failureMessage(cause, requestStarted)
          if (!requestStarted || definiteFailures.has(error?.code ?? '')) {
            item.state = 'failed'; item.input = undefined
            if (error?.code === 'invalid-skill' && error.reason === 'skill-limit') { this.pauseReason = 'capacity'; break }
          } else {
            item.state = 'uncertain'; this.pauseReason = 'unconfirmed'; break
          }
        }
        options.onProgress(this.progress)
      }
    } finally {
      this.running = false; this.current = null
      options.onProgress(this.progress)
    }
    return this.progress
  }
}

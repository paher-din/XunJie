/**
 * 项目文件的领域规则：路径合法性、UTF-8 字节限额、语言识别与换行概览。
 *
 * 规则来源（只读核对，不导入服务端模块）：
 * - 路径：主仓库 `apps/server/runner/snapshot.ts:30-35` 的 `validatePath`
 * - active 路径占用：`apps/server/server/workspace/files.ts:40`
 * - 限额：`files.ts:44`（active 50 个文件 / 1 MiB，按 `Buffer.byteLength` 的 UTF-8 字节计）
 * - 非法 Unicode：`files.ts:5-7` 的 `validateText`（拒绝未配对代理项）
 *
 * 前端只用于即时提示与本地草稿边界；服务端才是最终判定，限额也不因本地通过而放宽。
 * 有一处比服务端更严：纯空白路径按 `empty` 拒绝（服务端会当成合法文件名）。
 */

/** 工作区限额；与服务端同值，最终由服务校验。 */
export const WORKSPACE_LIMITS = {
  maxActiveFiles: 50,
  maxActiveBytes: 1048576,
} as const

export type PathProblem = 'empty' | 'separator' | 'drive' | 'segment' | 'duplicate'

/** 路径不可用的原因；可用时返回 null。`existing` 是当前 active 文件的路径。 */
export function pathProblem(path: string, existing: readonly string[]): PathProblem | null {
  if (path.trim() === '') return 'empty'
  // 盘符先于反斜杠判定：两者服务端同样拒绝（同一个 INVALID_REFERENCE），
  // 分开只是为了给学生更准确的提示——`C:\main.c` 读作「Windows 绝对路径」比「非法分隔符」更有用。
  if (/^[a-z]:/i.test(path)) return 'drive'
  if (/[\\\0]/.test(path)) return 'separator'
  if (path.split('/').some((part) => part === '' || part === '.' || part === '..')) return 'segment'
  if (existing.includes(path)) return 'duplicate'
  return null
}

const encoder = new TextEncoder()

/** 正文的 UTF-8 字节数；限额按它计，不按字符数或 UTF-16 码元数。 */
export function utf8Bytes(text: string): number {
  return encoder.encode(text).byteLength
}

/** 未配对代理项不是有效 Unicode（服务端 `validateText` 同样拒绝）。 */
function hasUnpairedSurrogate(text: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)
}

export interface WorkspaceUsage {
  /** 当前 active 文件数（不含已回收实例）。 */
  activeFiles: number
  /** 当前 active 文件正文的 UTF-8 字节总量。 */
  activeBytes: number
}

export type LimitProblem = 'file-count' | 'total-bytes' | 'invalid-unicode'

/** 新建一个正文为 `text` 的 active 文件是否越界；可用时返回 null。 */
export function createLimitProblem(text: string, usage: WorkspaceUsage): LimitProblem | null {
  if (hasUnpairedSurrogate(text)) return 'invalid-unicode'
  if (usage.activeFiles + 1 > WORKSPACE_LIMITS.maxActiveFiles) return 'file-count'
  if (usage.activeBytes + utf8Bytes(text) > WORKSPACE_LIMITS.maxActiveBytes) return 'total-bytes'
  return null
}

/** 字节数读数：B / KiB / MiB 三档，与限额的 MiB 口径一致。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`
}

/**
 * 扩展名 → Monaco 语言 id。只列实际会注册的语言（`monacoSetup.ts` 按需加载对应
 * `languages/definitions/*`），其余一律 `plaintext`，不返回没注册过的 id。
 * id 名与 monaco-editor 0.57 一致：`.c` / `.h` 注册为 `c`，与 C++ 分开——
 * 语法高亮不是 C17 编译检查，编译与诊断属课程运行时。
 */
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  v: 'verilog',
  vh: 'verilog',
  sv: 'systemverilog',
  svh: 'systemverilog',
  py: 'python',
  md: 'markdown',
  markdown: 'markdown',
}

export function languageOf(path: string): string {
  const slash = path.lastIndexOf('/')
  const dot = path.lastIndexOf('.')
  if (dot <= slash || dot === path.length - 1) return 'plaintext'
  return LANGUAGE_BY_EXTENSION[path.slice(dot + 1).toLowerCase()] ?? 'plaintext'
}

export type EolKind = 'lf' | 'crlf' | 'cr' | 'mixed' | 'none'

/**
 * 正文里实际出现的换行分隔符概览。只描述、不规范化：混合换行是原文件的事实，
 * 界面如实显示，编辑器投影与保存都不借此统一换行。
 */
export function eolOf(text: string): EolKind {
  const kinds = new Set<EolKind>()
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '\r' && text[i] !== '\n') continue
    if (text[i] === '\r') {
      kinds.add(text[i + 1] === '\n' ? 'crlf' : 'cr')
      if (text[i + 1] === '\n') i++
    } else {
      kinds.add('lf')
    }
  }
  if (kinds.size === 0) return 'none'
  return kinds.size === 1 ? [...kinds][0] : 'mixed'
}

export function eolLabel(kind: EolKind): string {
  if (kind === 'lf') return 'LF'
  if (kind === 'crlf') return 'CRLF'
  if (kind === 'cr') return 'CR'
  return kind === 'mixed' ? '混合换行' : '无换行'
}

/** 正文开头是否带 BOM（U+FEFF）。BOM 属原文，不是可编辑的首字符。 */
export function hasBom(text: string): boolean {
  return text.charCodeAt(0) === 0xfeff
}

/** 语言 id 的界面读数。 */
export function languageLabel(language: string): string {
  if (language === 'c') return 'C'
  if (language === 'cpp') return 'C++'
  if (language === 'verilog') return 'Verilog'
  if (language === 'systemverilog') return 'SystemVerilog'
  if (language === 'python') return 'Python'
  if (language === 'markdown') return 'Markdown'
  return '纯文本'
}

/** 新建一个文件可能被拒的全部原因：路径、限额、无效 Unicode，或当前状态不允许。 */
export type CreateProblem = PathProblem | LimitProblem | 'not-allowed'

export type CreateOutcome = { ok: true; fileId: string } | { ok: false; problem: CreateProblem }

/**
 * 新建文件被拒时给学生的说明。文案说清「为什么不行、怎样才行」，
 * 不只报错误码；服务端仍是最终判定，本地通过也不代表服务端一定接受。
 */
export function problemMessage(problem: PathProblem | LimitProblem | 'not-allowed'): string {
  switch (problem) {
    case 'empty':
      return '填写项目内相对路径，例如 src/words.c'
    case 'drive':
      return '不能是磁盘绝对路径；路径从项目根目录写起'
    case 'separator':
      return '路径用 / 分隔目录，不能包含反斜杠或空字符'
    case 'segment':
      return '路径不能以 / 开头，也不能有空段、. 或 ..'
    case 'duplicate':
      return '已有文件占用这个路径；换个路径，或打开已有的那个'
    case 'file-count':
      return `active 文件已达 ${WORKSPACE_LIMITS.maxActiveFiles} 个上限；先回收不用的实例再新建`
    case 'total-bytes':
      return `超出 ${formatBytes(WORKSPACE_LIMITS.maxActiveBytes)} 的正文总量上限`
    case 'invalid-unicode':
      return '正文包含无效的 Unicode 字符（未配对的代理项）'
    case 'not-allowed':
      return '当前作品状态不允许新建文件'
  }
}

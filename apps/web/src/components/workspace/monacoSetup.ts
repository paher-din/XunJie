import type { editor } from 'monaco-editor/editor/editor.api'

/**
 * Monaco 的按需加载与主题接线。
 *
 * 只加载编辑器核心 + 已登记的功能 + 项目实际用到的语言（C / C++ / HDL / Python / Markdown），
 * 不导入 `monaco-editor` 根入口——它会把八十多种语言与 LSP 客户端一起拉进来。
 * 语言 id 与 `lib/projectFiles.ts` 的 `languageOf` 一致：`.c` / `.h` 走 monaco 的 `c`，
 * 语法高亮不等于 C17 编译检查，编译与诊断属课程运行时。
 *
 * 主题不写死色值：全部从 `styles/tokens.css` 的语义令牌运行时取值，浅深两套主题各定义一次，
 * 跟随 `<html data-theme>` 切换（DESIGN.md「实现约定」：颜色只从 tokens.css 取）。
 */

type MonacoModule = typeof import('monaco-editor/editor/editor.api')

export type MonacoEditor = editor.IStandaloneCodeEditor
export type MonacoModel = editor.ITextModel
export type MonacoViewState = editor.ICodeEditorViewState | null

const THEME_LIGHT = 'xunjie-light'
const THEME_DARK = 'xunjie-dark'

let pending: Promise<MonacoModule> | null = null

export function loadMonaco(): Promise<MonacoModule> {
  if (!pending) {
    pending = bootstrap().catch((error) => {
      // 加载失败不缓存：下一次进入工作区可以重试，而不是一直停在坏掉的 promise 上
      pending = null
      throw error
    })
  }
  return pending
}

async function bootstrap(): Promise<MonacoModule> {
  const monaco = await import('monaco-editor/editor/editor.api')
  const EditorWorker = (await import('monaco-editor/editor/editor.worker?worker')).default
  // 本地 worker，不走 CDN：编辑能力与运行工具链分开，离线也能编辑
  self.MonacoEnvironment = { getWorker: () => new EditorWorker() }
  await Promise.all([...EDITOR_FEATURES, ...LANGUAGE_DEFINITIONS].map((path) => path()))
  syncTheme(monaco)
  return monaco
}

/**
 * 按需加载的编辑器功能：编辑、查找、折叠、缩进、多光标与只读提示这些实际会用到的部分。
 * 不整包引入 `monaco-editor/features/register.all`——它会把补全、重命名、格式化、代码动作、
 * diff 编辑器等语言服务一起拉进来（多约 2 MB），而这个产品里没有 LSP，也不在浏览器里编译。
 * 只读版本比较所需的 diff 编辑器等到真的做比较界面时再加。
 */
const EDITOR_FEATURES: Array<() => Promise<unknown>> = [
  () => import('monaco-editor/features/codeEditor/register'),
  () => import('monaco-editor/features/codicon/register'),
  () => import('monaco-editor/features/find/register'),
  () => import('monaco-editor/features/hover/register'),
  () => import('monaco-editor/features/gotoError/register'),
  () => import('monaco-editor/features/folding/register'),
  () => import('monaco-editor/features/comment/register'),
  () => import('monaco-editor/features/linesOperations/register'),
  () => import('monaco-editor/features/multicursor/register'),
  () => import('monaco-editor/features/clipboard/register'),
  () => import('monaco-editor/features/contextmenu/register'),
  () => import('monaco-editor/features/cursorUndo/register'),
  () => import('monaco-editor/features/wordOperations/register'),
  () => import('monaco-editor/features/smartSelect/register'),
  () => import('monaco-editor/features/bracketMatching/register'),
  () => import('monaco-editor/features/gotoLine/register'),
  () => import('monaco-editor/features/indentation/register'),
  () => import('monaco-editor/features/tokenization/register'),
  () => import('monaco-editor/features/readOnlyMessage/register'),
  () => import('monaco-editor/features/toggleTabFocusMode/register'),
  () => import('monaco-editor/features/unicodeHighlighter/register'),
  () => import('monaco-editor/features/unusualLineTerminators/register'),
]

/** 项目文件实际会用到的语言；`.c` / `.h` 由 cpp 定义注册成语言 id `c`。 */
const LANGUAGE_DEFINITIONS: Array<() => Promise<unknown>> = [
  () => import('monaco-editor/languages/definitions/cpp/register'),
  () => import('monaco-editor/languages/definitions/systemverilog/register'),
  () => import('monaco-editor/languages/definitions/python/register'),
  () => import('monaco-editor/languages/definitions/markdown/register'),
]

/** 从 CSS 自定义属性取色；缺失时回退到传入的兜底值，不让编辑器变成全黑或全白。 */
function token(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value === '' ? fallback : value
}

/** Monaco 只吃 hex：把 tokens.css 里的 rgba() 转成 #rrggbbaa。 */
function toHex(value: string): string {
  if (value.startsWith('#')) return value
  const parts = value.match(/[\d.]+/g)
  if (!parts || parts.length < 3) return '#00000000'
  const [r, g, b, a] = parts as [string, string, string, string | undefined]
  const hex = (n: string) => Number.parseInt(n, 10).toString(16).padStart(2, '0')
  const alpha = a === undefined ? 'ff' : Math.round(Number.parseFloat(a) * 255).toString(16).padStart(2, '0')
  return `#${hex(r)}${hex(g)}${hex(b)}${alpha}`
}

/** 给 hex 色附加透明度（0–1），用于选区与查找高亮这类需要透底的着色。 */
function withAlpha(hex: string, alpha: number): string {
  const base = toHex(hex).slice(0, 7)
  return base + Math.round(alpha * 255).toString(16).padStart(2, '0')
}

/** 按当前 `<html data-theme>` 定义并激活主题；主题切换时重新调用即可。 */
export function syncTheme(monaco: MonacoModule): void {
  const dark = document.documentElement.dataset.theme === 'dark'
  const name = dark ? THEME_DARK : THEME_LIGHT

  const ink = token('--ink', dark ? '#ededed' : '#1f2328')
  const accent = token('--accent', dark ? '#409cff' : '#007aff')
  const pendingBg = token('--status-pending-bg', dark ? '#3b3215' : '#fef9c3')

  monaco.editor.defineTheme(name, {
    base: dark ? 'vs-dark' : 'vs',
    inherit: true,
    // 代码令牌色取 tokens.css 的 --tok-*（「代码与 markdown」一组），关键字加粗到 600 档
    rules: [
      { token: '', foreground: toHex(ink).slice(1) },
      { token: 'comment', foreground: toHex(token('--tok-c', '#9aa3b2')).slice(1) },
      { token: 'string', foreground: toHex(token('--tok-s', '#6f8565')).slice(1) },
      { token: 'number', foreground: toHex(token('--tok-n', '#a06a4a')).slice(1) },
      { token: 'keyword', foreground: toHex(token('--tok-k', '#587cb8')).slice(1), fontStyle: 'bold' },
      { token: 'type', foreground: toHex(token('--tok-f', '#8a6d9b')).slice(1) },
      { token: 'identifier.function', foreground: toHex(token('--tok-f', '#8a6d9b')).slice(1) },
      { token: 'delimiter', foreground: toHex(token('--muted', '#656d76')).slice(1) },
      { token: 'tag', foreground: toHex(token('--tok-k', '#587cb8')).slice(1) },
    ],
    colors: {
      'editor.background': toHex(token('--paper', dark ? '#1f1f1f' : '#ffffff')),
      'editor.foreground': toHex(ink),
      'editorLineNumber.foreground': toHex(token('--faint', '#9ca0a6')),
      'editorLineNumber.activeForeground': toHex(token('--ink-soft', '#42474d')),
      'editorCursor.foreground': toHex(ink),
      'editor.selectionBackground': withAlpha(accent, 0.18),
      'editor.inactiveSelectionBackground': withAlpha(accent, 0.1),
      'editor.lineHighlightBackground': toHex(token('--sunken', dark ? '#262626' : '#f7f8fa')),
      'editor.lineHighlightBorder': '#00000000',
      'editorIndentGuide.background1': toHex(token('--line', '#e8e8e6')),
      'editorWhitespace.foreground': toHex(token('--line-faint', '#c9cac8')),
      'editorWidget.background': toHex(token('--raised', dark ? '#2b2b2b' : '#ffffff')),
      'editorWidget.border': toHex(token('--line-strong', '#e0e0de')),
      'editor.findMatchBackground': toHex(pendingBg),
      'editor.findMatchHighlightBackground': withAlpha(pendingBg, 0.55),
      'scrollbarSlider.background': toHex(token('--scroll-thumb', 'rgba(37,39,44,0.16)')),
      'scrollbarSlider.hoverBackground': toHex(token('--scroll-thumb-hover', 'rgba(37,39,44,0.24)')),
    },
  })
  monaco.editor.setTheme(name)
}

/** 编辑器创建选项：字号与行高走设计阶梯（13px / 1.5 档），不做小地图，中文正文不触发 Unicode 警告。 */
export function editorOptions(readOnly: boolean, readOnlyReason: string | null): editor.IStandaloneEditorConstructionOptions {
  return {
    automaticLayout: true,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 13,
    lineHeight: 20,
    fontLigatures: false,
    tabSize: 4,
    insertSpaces: true,
    minimap: { enabled: false },
    glyphMargin: false,
    scrollBeyondLastLine: false,
    smoothScrolling: true,
    renderLineHighlight: 'line',
    folding: true,
    padding: { top: 12, bottom: 12 },
    fixedOverflowWidgets: true,
    // 走 Monaco 经典的 textarea 输入路径，不用浏览器原生 EditContext：
    // EditContext 下合成键事件（自动化验收的键入方式）进不了编辑器，而经典路径对中文
    // 组合输入的支持是 Monaco 长期验证过的。等验收不再依赖合成键入时可以重新评估。
    editContext: false,
    readOnly,
    readOnlyMessage: readOnly && readOnlyReason ? { value: readOnlyReason } : undefined,
    // 中文与课程材料里的全角标点是正常正文，不是「可疑字符」
    unicodeHighlight: { ambiguousCharacters: false, nonBasicASCII: false },
    unusualLineTerminators: 'off',
  }
}

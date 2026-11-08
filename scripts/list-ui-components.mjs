import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageRoot = join(root, 'packages/ui')
const require = createRequire(join(packageRoot, 'package.json'))
const ts = require('typescript')
const config = ts.readConfigFile(join(packageRoot, 'tsconfig.json'), ts.sys.readFile)
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, packageRoot)
const program = ts.createProgram(parsed.fileNames, parsed.options)
const checker = program.getTypeChecker()
const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
const groups = ['foundation', 'icons', 'brand', 'home', 'dashboard', 'chat', 'settings', 'workspace', 'teacher', 'teacher-shell', 'teacher-design', 'teacher-review']

function hasJsx(node) {
  if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) return true
  return ts.forEachChild(node, hasJsx) === true
}

const result = []
for (const group of groups) {
  const target = manifest.exports[`./${group}`]
  if (typeof target !== 'string') continue
  const source = program.getSourceFile(join(packageRoot, target))
  if (!source) continue
  const module = checker.getSymbolAtLocation(source)
  if (!module) continue
  for (const symbol of checker.getExportsOfModule(module)) {
    if (!/^[A-Z]/.test(symbol.name)) continue
    const actual = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
    const declaration = actual.declarations?.find(node => hasJsx(node))
    if (!declaration) continue
    result.push({ group, name: symbol.name, importPath: `@xunjie/ui/${group}`,
      source: relative(root, declaration.getSourceFile().fileName).replaceAll('\\', '/') })
  }
}
result.sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name))
if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2))
else for (const item of result) console.log(`${item.importPath}\t${item.name}\t${item.source}`)

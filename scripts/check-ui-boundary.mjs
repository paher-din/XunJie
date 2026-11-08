import { readdir, readFile } from 'node:fs/promises'
import { existsSync, globSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(repository, 'packages/ui/package.json'))
const ts = require('typescript')

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  return (await Promise.all(entries.map(entry => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? files(path) : [path]
  }))).flat()
}

/** Verify that a UI package can be compiled without application source files. */
export async function checkUiBoundary(packageRoot = join(repository, 'packages/ui')) {
  packageRoot = resolve(packageRoot)
  const sourceRoot = join(packageRoot, 'src')
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  const declared = new Set(Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies }))
  const errors = []
  const label = file => relative(packageRoot, file)

  function inspect(file, specifier) {
    const name = specifier.split('?')[0]
    if (!name || name.startsWith('#') || name.startsWith('data:')) return
    if (name.startsWith('.') || isAbsolute(name)) {
      const target = resolve(dirname(file), name)
      const path = relative(sourceRoot, target)
      if (path.startsWith('..') || isAbsolute(path)) {
        errors.push(`${label(file)}: ${specifier} escapes UI source`)
        return
      }
      if (/[*?{}[\]]/.test(name)) {
        if (!globSync(name, { cwd: dirname(file) }).length) errors.push(`${label(file)}: ${specifier} matches no package assets`)
        return
      }
      const candidates = [target, ...['.ts', '.tsx', '.js', '.jsx', '.json', '.css'].map(ext => target + ext),
        ...['index.ts', 'index.tsx', 'index.js'].map(index => join(target, index))]
      if (target.endsWith('.js')) candidates.push(target.slice(0, -3) + '.ts', target.slice(0, -3) + '.tsx')
      if (!candidates.some(existsSync)) errors.push(`${label(file)}: ${specifier} was not found in the UI package`)
      return
    }
    const parts = name.split('/')
    const dependency = name.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
    if (!declared.has(dependency)) errors.push(`${label(file)}: ${specifier} is not a declared UI dependency`)
  }

  for (const [name, target] of Object.entries(manifest.exports ?? {})) {
    if (typeof target === 'string' && !target.includes('*') && !existsSync(resolve(packageRoot, target))) {
      errors.push(`package.json: export ${name} points to a missing file ${target}`)
    }
  }
  for (const file of await files(sourceRoot)) {
    const extension = extname(file)
    if (extension === '.css') {
      const content = await readFile(file, 'utf8')
      for (const match of content.matchAll(/@import\s+(?:url\()?['"]([^'"]+)['"]/g)) inspect(file, match[1])
      for (const match of content.matchAll(/url\(\s*['"]?([^'"\s)]+)['"]?\s*\)/g)) inspect(file, match[1])
      continue
    }
    if (!['.ts', '.tsx', '.js', '.jsx'].includes(extension) || /\.test\.[^.]+$/.test(file)) continue
    const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true,
      extension === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    function visit(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        inspect(file, node.moduleSpecifier.text)
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
        inspect(file, node.argument.literal.text)
      } else if (ts.isCallExpression(node) && node.arguments.length
        && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require'
          || ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'glob')) {
        const argument = node.arguments[0]
        if (ts.isStringLiteral(argument)) inspect(file, argument.text)
        else if (ts.isArrayLiteralExpression(argument)) {
          for (const element of argument.elements) if (ts.isStringLiteral(element)) inspect(file, element.text)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return errors
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = await checkUiBoundary()
  if (errors.length) {
    for (const error of errors) console.error(error)
    process.exitCode = 1
  } else console.log('UI boundary: imports, assets and exports stay in the package or declared dependencies.')
}

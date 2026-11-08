import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(root, 'packages/ui/package.json'))
const ts = require('typescript')
const inventory = JSON.parse(execFileSync(process.execPath, [join(root, 'scripts/list-ui-components.mjs'), '--json'], { encoding: 'utf8' }))
const registryFile = join(root, 'apps/web/src/ui-catalog/registry.ts')
const registry = ts.createSourceFile(registryFile, readFileSync(registryFile, 'utf8'), ts.ScriptTarget.Latest, true)
const entries = []
const errors = []
const registered = new Set()
for (const statement of registry.statements) if (ts.isVariableStatement(statement)) {
  for (const declaration of statement.declarationList.declarations) {
    if (!ts.isIdentifier(declaration.name) || declaration.name.text !== 'catalog'
      || !declaration.initializer || !ts.isArrayLiteralExpression(declaration.initializer)) continue
    for (const group of declaration.initializer.elements) if (ts.isObjectLiteralExpression(group)) {
      const prop = group.properties.find(item => ts.isPropertyAssignment(item) && item.name.getText(registry) === 'entries')
      if (prop && ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.initializer)) registered.add(prop.initializer.text)
      else errors.push('registry.ts: each catalog group needs a registered entries array')
    }
  }
}
if (!registered.size) errors.push('registry.ts: no catalog groups were registered')

for (const statement of registry.statements) {
  if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
    || !statement.moduleSpecifier.text.startsWith('./examples/')) continue
  const bindings = statement.importClause?.namedBindings
  const names = bindings && ts.isNamedImports(bindings) ? bindings.elements.map(item => item.name.text) : []
  if (!names.length || names.some(name => !registered.has(name))) {
    errors.push(`registry.ts: ${statement.moduleSpecifier.text} is imported but not registered`)
    continue
  }
  const path = resolve(dirname(registryFile), statement.moduleSpecifier.text + '.tsx')
  if (!existsSync(path)) { errors.push(`Missing catalog examples: ${path}`); continue }
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const strings = new Map()
  for (const node of source.statements) if (ts.isVariableStatement(node)) {
    for (const declaration of node.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer && ts.isStringLiteral(declaration.initializer)) {
        strings.set(declaration.name.text, declaration.initializer.text)
      }
    }
  }
  const value = node => ts.isStringLiteral(node) ? node.text : ts.isIdentifier(node) ? strings.get(node.text) : undefined
  function readEntry(node) {
    if (ts.isSpreadElement(node)) {
      // A few related components share one example factory via a literal
      // names array. Resolve those names against the formal export inventory;
      // the browser test checks the resulting live entries and states.
      const call = node.expression
      const callee = ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression) ? call.expression : undefined
      let names = callee?.expression
      while (names && (ts.isParenthesizedExpression(names) || ts.isAsExpression(names))) names = names.expression
      const callback = ts.isCallExpression(call) ? call.arguments[0] : undefined
      const importPath = strings.get('importPath')
      let usesEntry = false
      function findEntry(child) {
        const parameter = callback && ts.isArrowFunction(callback) ? callback.parameters[0]?.name : undefined
        if (ts.isCallExpression(child) && ts.isIdentifier(child.expression) && child.expression.text === 'entry'
          && parameter && ts.isIdentifier(parameter) && child.arguments[0]
          && ts.isIdentifier(child.arguments[0]) && child.arguments[0].text === parameter.text) usesEntry = true
        ts.forEachChild(child, findEntry)
      }
      if (callback) findEntry(callback)
      if (!callee || callee.name.text !== 'map' || !names || !ts.isArrayLiteralExpression(names)
        || !callback || !ts.isArrowFunction(callback) || !usesEntry || !importPath
        || !names.elements.length || names.elements.some(name => !ts.isStringLiteral(name))) {
        errors.push(`${path}: spread entries need a literal component-name array and a map callback`)
      } else {
        for (const literal of names.elements) {
          const name = literal.text
          const item = inventory.find(candidate => candidate.name === name && candidate.importPath === importPath)
          if (!item) errors.push(`${path}: ${importPath} does not export ${name}`)
          else entries.push({ name, importPath, source: item.source })
        }
      }
    } else if (ts.isObjectLiteralExpression(node)) {
      const props = new Map(node.properties.flatMap(prop => {
        if (ts.isPropertyAssignment(prop)) return [[prop.name.getText(source), prop.initializer]]
        if (ts.isShorthandPropertyAssignment(prop)) return [[prop.name.text, prop.name]]
        return []
      }))
      if (props.has('name') && props.has('importPath') && props.has('states')) {
        const name = value(props.get('name')), importPath = value(props.get('importPath'))
        const componentSource = props.has('source') ? value(props.get('source')) : undefined
        const states = props.get('states')
        if (!name || !importPath || !ts.isArrayLiteralExpression(states) || states.elements.length === 0) {
          errors.push(`${path}: catalog entries need a component name, import path and explicit states`)
        } else {
          entries.push({ name, importPath, source: componentSource })
          if (!componentSource || !existsSync(join(root, componentSource))) errors.push(`${path}: ${name} has no existing component source`)
        }
      } else errors.push(`${path}: catalog entry is missing required metadata`)
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'entry') {
      // Some large groups use a local entry(name, sourceFile, ..., states)
      // helper. The registry validates the resulting state arrays at runtime.
      const [nameArg, fileArg] = node.arguments
      const name = nameArg && value(nameArg)
      const file = fileArg && value(fileArg)
      const importPath = strings.get('importPath')
      const group = importPath?.match(/^@xunjie\/ui\/([a-z-]+)$/)?.[1]
      const states = node.arguments.at(-1)
      if (!name || !file || !group || !/^[\w/-]+$/.test(file) || file.split('/').includes('..')
        || !states || ts.isArrayLiteralExpression(states) && states.elements.length === 0) {
        errors.push(`${path}: entry() needs a component name, source file and states`)
      } else {
        const componentSource = `packages/ui/src/${group}/${file}.tsx`
        entries.push({ name, importPath, source: componentSource })
        if (!existsSync(join(root, componentSource))) errors.push(`${path}: ${name} has no existing component source`)
      }
    } else {
      errors.push(`${path}: catalog entries must be explicit objects or entry() calls`)
    }
  }
  for (const statement of source.statements) if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.name.text.endsWith('Entries')) continue
      if (!declaration.initializer || !ts.isArrayLiteralExpression(declaration.initializer)) {
        errors.push(`${path}: ${declaration.name.text} must be an explicit array`)
        continue
      }
      for (const entry of declaration.initializer.elements) readEntry(entry)
    }
  }
}

const byKey = new Map()
for (const entry of entries) {
  const key = `${entry.importPath}#${entry.name}`
  byKey.set(key, (byKey.get(key) ?? 0) + 1)
}
for (const [key, count] of byKey) if (count > 1) errors.push(`Duplicate catalog entry: ${key}`)
for (const item of inventory) if (!byKey.has(`${item.importPath}#${item.name}`)) {
  errors.push(`No real-screen example: ${item.importPath} ${item.name} (${item.source})`)
}

if (process.argv.includes('--json')) console.log(JSON.stringify({ components: inventory.length, entries: entries.length, errors }, null, 2))
else if (errors.length) {
  for (const error of errors) console.error(error)
  console.error(`${errors.length} catalog issues; ${entries.length} entries for ${inventory.length} exported components.`)
} else console.log(`UI catalog: ${entries.length} entries cover ${inventory.length} exported components.`)
if (errors.length) process.exitCode = 1

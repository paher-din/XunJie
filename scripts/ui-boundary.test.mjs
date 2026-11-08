import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { checkUiBoundary } from './check-ui-boundary.mjs'

test('formal UI imports and assets remain independent of the old application', async () => {
  assert.deepEqual(await checkUiBoundary(), [])
})

test('UI boundary detects escaped imports, undeclared dependencies, missing assets and broken exports', async t => {
  const root = await mkdtemp(join(tmpdir(), 'xunjie-ui-boundary-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'package.json'), JSON.stringify({
    dependencies: { react: '^19.1.0' }, exports: { '.': './src/index.ts' },
  }))
  await writeFile(join(root, 'src/index.ts'), "import 'react'\nexport const value = 1\n")
  assert.deepEqual(await checkUiBoundary(root), [])
  await writeFile(join(root, 'src/index.ts'), "export * from '../../old-page'\nimport 'unlisted-package'\n")
  await writeFile(join(root, 'src/styles.css'), "@font-face { src: url('./missing.woff2') }\n")
  const errors = await checkUiBoundary(root)
  assert(errors.some(error => error.includes('../../old-page') && error.includes('escapes')))
  assert(errors.some(error => error.includes('unlisted-package') && error.includes('not a declared')))
  assert(errors.some(error => error.includes('missing.woff2') && error.includes('not found')))
  await writeFile(join(root, 'package.json'), JSON.stringify({ exports: { '.': './src/missing.ts' } }))
  assert((await checkUiBoundary(root)).some(error => error.includes('export .') && error.includes('missing file')))
})

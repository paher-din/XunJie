import { expect, it } from 'vitest'
import { readSkillPackage } from './skills'
import { teachingSkillLimits } from '@xunjie/contracts/agent-skills'

function file(path: string, value: BlobPart, mediaType = '') {
  const result = new File([value], path.split('/').at(-1)!, { type: mediaType })
  Object.defineProperty(result, 'webkitRelativePath', { value: path })
  return result
}

it('imports the root document and nested skill examples with lossless relative paths and bytes', async () => {
  const markdown = '\ufeff---\r\nname: 中文技能\r\ndescription: 描述\r\n---\r\n正文\r\n'
  const result = await readSkillPackage([
    file('my-skill/SKILL.md', markdown, 'text/markdown'),
    file('my-skill/references/lesson.md', '引用\r\n'),
    file('my-skill/assets/example.bin', new Uint8Array([0, 255, 128, 13, 10])),
    file('my-skill/references/example/SKILL.md', '# 作为参考的技能文件'),
  ])
  expect(result.map(item => item.path)).toEqual(['SKILL.md', 'references/lesson.md', 'assets/example.bin', 'references/example/SKILL.md'])
  expect(result[0]).toMatchObject({ encoding: 'utf8', content: markdown })
  expect(result[1]).toMatchObject({ encoding: 'utf8', content: '引用\r\n' })
  expect(result[2]).toMatchObject({ encoding: 'base64', content: 'AP+ADQo=' })
  expect(result[3]).toMatchObject({ encoding: 'utf8', content: '# 作为参考的技能文件' })
})

it('rejects multiple packages, files outside the selected root and noncanonical attachment paths', async () => {
  await expect(readSkillPackage([file('one/SKILL.md', ''), file('two/SKILL.md', '')])).rejects.toThrow('其中应直接包含 SKILL.md')
  await expect(readSkillPackage([file('one/SKILL.md', ''), file('two/assets/a.bin', '')])).rejects.toThrow('同一个')
  await expect(readSkillPackage([file('one/SKILL.md', ''), file('one/assets/../a.bin', '')])).rejects.toThrow('文件结构不完整')
})

it('reads packages beyond the former file, file-size, body and total-size ceilings', async () => {
  const body = '---\nname: larger\ndescription: A larger skill\n---\n' + '说明\n'.repeat(40000)
  const binary = new Uint8Array(3 * 1024 * 1024).fill(255)
  const files = [file('larger/SKILL.md', body), file('larger/assets/sample.bin', binary),
    ...Array.from({ length: 100 }, (_, index) => file(`larger/references/${index}.md`, ''))]
  const packed = await readSkillPackage(files)
  expect(packed).toHaveLength(102)
  expect(packed[0]).toMatchObject({ encoding: 'utf8', content: body })
  expect(packed[1].content).toHaveLength(Math.ceil(binary.length / 3) * 4)
  expect(atob(packed[1].content).charCodeAt(0)).toBe(255)
})

it('rejects packages beyond the enlarged limits before reading any bytes', async () => {
  function declared(path: string, size: number) {
    return { name: path.split('/').at(-1)!, webkitRelativePath: path, size,
      arrayBuffer() { throw new Error('must not read'); } } as unknown as File
  }
  const root = declared('SKILL.md', 1)
  await expect(readSkillPackage([root, declared('large.bin', teachingSkillLimits.fileBytes + 1)])).rejects.toThrow('大小限制')
  await expect(readSkillPackage([root, ...Array.from({ length: 3 }, (_, index) => declared(`${index}.bin`, teachingSkillLimits.fileBytes))])).rejects.toThrow('大小限制')
  await expect(readSkillPackage([declared('SKILL.md', teachingSkillLimits.bodyBytes + 1)])).rejects.toThrow('SKILL.md 最多')
  await expect(readSkillPackage([root, ...Array.from({ length: teachingSkillLimits.files }, (_, index) => declared(`${index}.txt`, 0))])).rejects.toThrow(String(teachingSkillLimits.files))
})

it('excludes repository history before package size checks and never reads its bytes', async () => {
  const content = '---\nname: repository-skill\ndescription: 原始技能\n---\n正文'
  const history = { name: 'history.pack', webkitRelativePath: 'repository-skill/.git/objects/pack/history.pack',
    size: 71 * 1024 * 1024, arrayBuffer() { throw new Error('must not read repository history') } } as unknown as File
  const packed = await readSkillPackage([file('repository-skill/SKILL.md', content), history,
    file('repository-skill/.gitignore', '.cache/\n')])
  expect(packed.map(item => item.path)).toEqual(['SKILL.md', '.gitignore'])
  expect(packed[0].content).toBe(content)
})

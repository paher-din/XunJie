import { expect, it } from 'vitest'
import { readSkillPackage } from './skills'

function file(path: string, value: BlobPart, mediaType = '') {
  const result = new File([value], path.split('/').at(-1)!, { type: mediaType })
  Object.defineProperty(result, 'webkitRelativePath', { value: path })
  return result
}

it('imports actual package files with stable relative paths and lossless UTF-8/binary bytes', async () => {
  const markdown = '\ufeff---\r\nname: 中文技能\r\ndescription: 描述\r\n---\r\n正文\r\n'
  const result = await readSkillPackage([
    file('my-skill/SKILL.md', markdown, 'text/markdown'),
    file('my-skill/references/lesson.md', '引用\r\n'),
    file('my-skill/assets/example.bin', new Uint8Array([0, 255, 128, 13, 10])),
  ])
  expect(result.map(item => item.path)).toEqual(['SKILL.md', 'references/lesson.md', 'assets/example.bin'])
  expect(result[0]).toMatchObject({ encoding: 'utf8', content: markdown })
  expect(result[1]).toMatchObject({ encoding: 'utf8', content: '引用\r\n' })
  expect(result[2]).toMatchObject({ encoding: 'base64', content: 'AP+ADQo=' })
})

it('rejects multiple packages, files outside the selected root and noncanonical attachment paths', async () => {
  await expect(readSkillPackage([file('one/SKILL.md', ''), file('two/SKILL.md', '')])).rejects.toThrow('唯一')
  await expect(readSkillPackage([file('one/SKILL.md', ''), file('two/assets/a.bin', '')])).rejects.toThrow('同一个')
  await expect(readSkillPackage([file('one/SKILL.md', ''), file('one/assets/../a.bin', '')])).rejects.toThrow('相对路径')
})

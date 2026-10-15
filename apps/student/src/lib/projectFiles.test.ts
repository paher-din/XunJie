import { describe, expect, it } from 'vitest'
import {
  WORKSPACE_LIMITS,
  createLimitProblem,
  eolLabel,
  eolOf,
  formatBytes,
  hasBom,
  languageOf,
  pathProblem,
  utf8Bytes,
} from './projectFiles'

/**
 * 规则来源（独立于本实现）：主仓库 `apps/teaching/runner/snapshot.ts:30-35` 的 `validatePath`
 * 与 `apps/teaching/server/workspace/files.ts:40` 的 active 路径占用检查。前端只做即时提示，
 * 最终判定仍在服务端。
 */
describe('pathProblem', () => {
  it('项目内相对路径通过', () => {
    expect(pathProblem('main.c', [])).toBeNull()
    expect(pathProblem('src/words.c', ['main.c'])).toBeNull()
    expect(pathProblem('测试数据/样本 1.txt', [])).toBeNull()
  })

  it('拒绝空路径、反斜杠、NUL 与 Windows 盘符前缀', () => {
    expect(pathProblem('', [])).toBe('empty')
    expect(pathProblem('   ', [])).toBe('empty')
    expect(pathProblem('src\\words.c', [])).toBe('separator')
    expect(pathProblem('a\0b.c', [])).toBe('separator')
    expect(pathProblem('c:/main.c', [])).toBe('drive')
    expect(pathProblem('C:\\main.c', [])).toBe('drive')
  })

  it('拒绝空段与 . / .. 段', () => {
    expect(pathProblem('/main.c', [])).toBe('segment')
    expect(pathProblem('main.c/', [])).toBe('segment')
    expect(pathProblem('src//words.c', [])).toBe('segment')
    expect(pathProblem('./main.c', [])).toBe('segment')
    expect(pathProblem('src/../main.c', [])).toBe('segment')
    expect(pathProblem('..', [])).toBe('segment')
  })

  it('拒绝与已有 active 文件同路径', () => {
    expect(pathProblem('main.c', ['main.c', 'src/words.c'])).toBe('duplicate')
    expect(pathProblem('src/words.c', ['main.c'])).toBeNull()
  })
})

/** 字节数按 UTF-8 编码计（服务端用 `Buffer.byteLength`），不是字符数或 UTF-16 码元数。 */
describe('utf8Bytes', () => {
  it('中文 3 字节、非 BMP 4 字节、BOM 3 字节、CRLF 2 字节', () => {
    expect(utf8Bytes('')).toBe(0)
    expect(utf8Bytes('abc')).toBe(3)
    expect(utf8Bytes('中')).toBe(3)
    expect(utf8Bytes('🙂')).toBe(4)
    expect(utf8Bytes('\uFEFF')).toBe(3)
    expect(utf8Bytes('a\r\nb\n')).toBe(5)
  })
})

describe('createLimitProblem', () => {
  it('限额内通过，含刚好等于上限的边界', () => {
    expect(createLimitProblem('', { activeFiles: 0, activeBytes: 0 })).toBeNull()
    // 第 50 个 active 文件仍合法（服务端是 count > 50 才拒）
    expect(createLimitProblem('abc', { activeFiles: 49, activeBytes: 0 })).toBeNull()
    // 总量刚好 1 MiB 仍合法（服务端是 bytes > 1048576 才拒）
    expect(
      createLimitProblem('abc', { activeFiles: 0, activeBytes: WORKSPACE_LIMITS.maxActiveBytes - 3 }),
    ).toBeNull()
  })

  it('超出文件数或总字节数时给出对应原因', () => {
    expect(createLimitProblem('', { activeFiles: 50, activeBytes: 0 })).toBe('file-count')
    expect(
      createLimitProblem('abcd', { activeFiles: 0, activeBytes: WORKSPACE_LIMITS.maxActiveBytes - 3 }),
    ).toBe('total-bytes')
  })

  it('拒绝含未配对代理项的正文，成对代理项合法', () => {
    const usage = { activeFiles: 0, activeBytes: 0 }
    expect(createLimitProblem('\uD800', usage)).toBe('invalid-unicode')
    expect(createLimitProblem('a\uDC00b', usage)).toBe('invalid-unicode')
    expect(createLimitProblem('🙂 中文', usage)).toBeNull()
  })
})

describe('formatBytes', () => {
  it('按 B / KiB / MiB 分档，MiB 对应限额口径', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1023)).toBe('1023 B')
    expect(formatBytes(1024)).toBe('1.0 KiB')
    expect(formatBytes(1536)).toBe('1.5 KiB')
    expect(formatBytes(WORKSPACE_LIMITS.maxActiveBytes)).toBe('1.00 MiB')
  })
})

/** 语言 id 取 Monaco 0.57 实际注册的名字（`languages/definitions/cpp/register.js` 把 .c/.h 注册成 `c`）。 */
describe('languageOf', () => {
  it('C 与 C++ 分开，不认识的扩展名落 plaintext', () => {
    expect(languageOf('main.c')).toBe('c')
    expect(languageOf('include/textscope.h')).toBe('c')
    expect(languageOf('solver.cpp')).toBe('cpp')
    expect(languageOf('top.v')).toBe('verilog')
    expect(languageOf('include/ports.vh')).toBe('verilog')
    expect(languageOf('rtl/TOP.SV')).toBe('systemverilog')
    expect(languageOf('include/ports.svh')).toBe('systemverilog')
    expect(languageOf('app.py')).toBe('python')
    expect(languageOf('说明.md')).toBe('markdown')
    expect(languageOf('sample.txt')).toBe('plaintext')
    expect(languageOf('notes')).toBe('plaintext')
  })
})

/** 换行概览只描述正文里实际出现的分隔符，不做规范化。 */
describe('eolOf', () => {
  it('区分 LF / CRLF / 裸 CR / 混合 / 无换行', () => {
    expect(eolOf('')).toBe('none')
    expect(eolOf('int main(void) { }')).toBe('none')
    expect(eolOf('a\nb')).toBe('lf')
    expect(eolOf('a\n')).toBe('lf')
    expect(eolOf('a\r\nb')).toBe('crlf')
    expect(eolOf('a\r\nb\r\n')).toBe('crlf')
    expect(eolOf('a\rb')).toBe('cr')
    expect(eolOf('a\nb\r\nc')).toBe('mixed')
    expect(eolOf('a\r\nb\rc')).toBe('mixed')
  })

  it('读数用短标签，混合与无换行都有明确文案', () => {
    expect(eolLabel('lf')).toBe('LF')
    expect(eolLabel('crlf')).toBe('CRLF')
    expect(eolLabel('cr')).toBe('CR')
    expect(eolLabel('mixed')).toBe('混合换行')
    expect(eolLabel('none')).toBe('无换行')
  })
})

describe('hasBom', () => {
  it('只看开头的 U+FEFF', () => {
    expect(hasBom('\uFEFFint main')).toBe(true)
    expect(hasBom('int main')).toBe(false)
    expect(hasBom('a\uFEFFb')).toBe(false)
  })
})

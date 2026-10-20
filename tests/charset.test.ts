/**
 * 字符集乱码修复 / 文件名清洗 / 长路径处理的单元测试。
 */
import { describe, expect, it } from 'vitest'
import iconv from 'iconv-lite'
import {
  isLongPath,
  isMojibake,
  repairMojibake,
  sanitizeFilename,
  scoreText,
  toExtendedPath
} from '@main/core/charset'

/** 把中文按 GBK 编码后再按 latin1 解码，模拟「GBK 字节被当成 latin1」的乱码。 */
function toLatin1Mojibake(s: string): string {
  return iconv.encode(s, 'gbk').toString('latin1')
}

describe('scoreText', () => {
  it('CJK 文本得分高于纯 ASCII', () => {
    expect(scoreText('中文')).toBeGreaterThan(scoreText('abcd'))
  })

  it('纯 ASCII 每个字符记 0.5 分', () => {
    expect(scoreText('abcd')).toBe(2)
  })

  it('出现 U+FFFD 替换字符时得分显著下降', () => {
    expect(scoreText('中文\uFFFD')).toBeLessThan(scoreText('中文'))
  })

  it('控制字符同样会扣分', () => {
    expect(scoreText('中文\u0001')).toBeLessThan(scoreText('中文'))
  })
})

describe('isMojibake', () => {
  it('识别 GBK 字节被按 latin1 解读的乱码', () => {
    expect(isMojibake(toLatin1Mojibake('音乐'))).toBe(true)
  })

  it('正常中文不算乱码', () => {
    expect(isMojibake('中文测试')).toBe(false)
  })

  it('正常日文不算乱码', () => {
    expect(isMojibake('吾輩は猫である')).toBe(false)
  })

  it('纯 ASCII 不算乱码', () => {
    expect(isMojibake('Hello World 123')).toBe(false)
  })
})

describe('repairMojibake', () => {
  it('可还原 GBK→latin1 造成的乱码', () => {
    const source = '音乐'
    const r = repairMojibake(toLatin1Mojibake(source))
    expect(r.changed).toBe(true)
    expect(r.text).toBe(source)
    expect(r.strategy).toBeTruthy()
  })

  it('可还原多字中文乱码', () => {
    const source = '米津玄師'
    const r = repairMojibake(toLatin1Mojibake(source))
    expect(r.changed).toBe(true)
    expect(r.text).toBe(source)
  })

  it('干净文本原样返回且 changed 为 false', () => {
    const r = repairMojibake('中文测试')
    expect(r.changed).toBe(false)
    expect(r.text).toBe('中文测试')
  })

  it('空串直接返回', () => {
    const r = repairMojibake('')
    expect(r.changed).toBe(false)
    expect(r.text).toBe('')
  })

  it('不会把半角片假名当成正常日文（Shift_JIS 误判已修复）', () => {
    // '中文' 的 GBK 字节为 d6d0cec4；按 shift_jis 解码得到 4 个半角片假名，
    // 半角片假名几乎只出现在乱码里，不能当作 CJK 给高分。
    const r = repairMojibake(toLatin1Mojibake('中文'))
    expect(r.changed).toBe(true)
    expect(r.text).toBe('中文')
    expect(r.strategy).not.toContain('shift_jis')
  })

  it('可还原 UTF-8 字节被按 GBK 解读造成的乱码', () => {
    // '中文乱码测试' 的 UTF-8 字节按 GBK 解读 -> 9 个汉字状的假字符
    const source = '中文乱码测试'
    const broken = iconv.decode(Buffer.from(source, 'utf8'), 'gbk')
    expect(broken).not.toBe(source)
    const r = repairMojibake(broken)
    expect(r.changed).toBe(true)
    expect(r.text).toBe(source)
  })

  it('可还原 UTF-8 字节被按 Latin-1 解读造成的乱码', () => {
    const source = '中文乱码测试'
    const broken = Buffer.from(source, 'utf8').toString('latin1')
    const r = repairMojibake(broken)
    expect(r.changed).toBe(true)
    expect(r.text).toBe(source)
  })

  it('不会把正常中文误判成乱码', () => {
    const r = repairMojibake('中文乱码测试')
    expect(r.changed).toBe(false)
    expect(r.text).toBe('中文乱码测试')
  })

  it('不会把正常日文误判成乱码', () => {
    const r = repairMojibake('吾輩は猫である')
    expect(r.changed).toBe(false)
    expect(r.text).toBe('吾輩は猫である')
  })

  it('证据不足时保持原样（宁缺毋滥）', () => {
    // '路路' 的 GBK 字节碰巧能构成合法 UTF-8，但解出来没有中日文字，
    // 因此不应该被「修复」。
    const r = repairMojibake('路路')
    expect(r.text).toBe('路路')
  })

  it('混合文本只修乱码片段，保留正常片段', () => {
    const broken = `Lemon ${iconv.decode(Buffer.from('乱码', 'utf8'), 'gbk')}`
    const r = repairMojibake(broken)
    expect(r.changed).toBe(true)
    expect(r.text).toBe('Lemon 乱码')
  })
})

describe('sanitizeFilename', () => {
  it('替换 Windows 非法字符', () => {
    const out = sanitizeFilename('a<>:"/\\|?*b')
    expect(out).toBe('a_________b')
    expect(out).not.toMatch(/[<>:"/\\|?*]/)
  })

  it('替换控制字符', () => {
    expect(sanitizeFilename('a\u0001b')).toBe('a_b')
  })

  it('去掉结尾的点和空格', () => {
    expect(sanitizeFilename('name...')).toBe('name')
    expect(sanitizeFilename('name. ')).toBe('name')
  })

  it('规避 Windows 保留设备名', () => {
    expect(sanitizeFilename('CON')).toBe('_CON')
    expect(sanitizeFilename('LPT1')).toBe('_LPT1')
    expect(sanitizeFilename('CON.txt')).toBe('_CON.txt')
  })

  it('普通文件名保持不变', () => {
    expect(sanitizeFilename('Lemon.mp3')).toBe('Lemon.mp3')
  })

  it('空白名回退为 unnamed', () => {
    expect(sanitizeFilename('   ')).toBe('unnamed')
  })
})

describe('isLongPath', () => {
  it('短路径不算超长', () => {
    expect(isLongPath('C:\\Music\\Lemon.flac')).toBe(false)
  })

  it('长度超过 240 视为超长', () => {
    const long = `C:\\Music\\${'a'.repeat(240)}\\Lemon.flac`
    expect(long.length).toBeGreaterThan(240)
    expect(isLongPath(long)).toBe(true)
  })
})

describe('toExtendedPath', () => {
  it('为盘符路径加上 \\\\?\\ 前缀', () => {
    const p = `C:\\Music\\${'b'.repeat(240)}\\Lemon.flac`
    const out = toExtendedPath(p)
    expect(out.startsWith('\\\\?\\')).toBe(true)
    expect(out).toBe(`\\\\?\\${p}`)
  })

  it('已经是扩展路径时原样返回', () => {
    const p = '\\\\?\\C:\\Music\\Lemon.flac'
    expect(toExtendedPath(p)).toBe(p)
  })

  it('非盘符路径原样返回', () => {
    const p = '\\\\server\\share\\Lemon.flac'
    expect(toExtendedPath(p)).toBe(p)
  })
})

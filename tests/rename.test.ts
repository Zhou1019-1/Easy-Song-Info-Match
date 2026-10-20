/**
 * 重命名 / 归档的模板渲染与同名消解（提示词「永不静默覆盖」的核心）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildFileName,
  commonAncestor,
  renderTemplate,
  sanitizeRelativePath,
  uniqueFileName
} from '@main/core/rename'

const TAGS = {
  title: ['Lemon'],
  artist: ['米津玄師'],
  album: ['BOOTLEG'],
  albumartist: ['米津玄師'],
  track: ['1'],
  totaltracks: ['12'],
  disc: ['1'],
  year: ['2018'],
  genre: ['J-Pop']
}

const CTX = { tags: TAGS, filename: '01 - 米津玄師 - Lemon.mp3', ext: '.mp3' }

let workDir = ''

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'songmatch-rename-'))
})

afterAll(() => {
  try {
    fs.rmSync(workDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

describe('renderTemplate — 模板渲染', () => {
  it('渲染常用占位符', () => {
    expect(renderTemplate('{artist} - {title}', CTX)).toBe('米津玄師 - Lemon')
    expect(renderTemplate('{track} {title}', CTX)).toBe('1 Lemon')
    expect(renderTemplate('{ext}', CTX)).toBe('mp3')
  })

  it('缺少的字段渲染为空串，不编造内容', () => {
    const ctx = { ...CTX, tags: { title: ['OnlyTitle'] } }
    expect(renderTemplate('{artist} - {title}', ctx)).toBe(' - OnlyTitle')
  })

  it('未知占位符原样保留', () => {
    expect(renderTemplate('{unknown} - {title}', CTX)).toBe('{unknown} - Lemon')
  })

  it('year 取不到时回退到 date', () => {
    const ctx = { ...CTX, tags: { date: ['2020-01-01'] } }
    expect(renderTemplate('{year}', ctx)).toBe('2020-01-01')
  })
})

describe('sanitizeRelativePath — 非法字符清理', () => {
  it('替换 Windows 非法字符', () => {
    expect(sanitizeRelativePath('a<b>c:d"e/f\\g|h?i*j')).toBe(
      path.join('a_b_c_d_e', 'f', 'g_h_i_j')
    )
  })

  it('去掉空片段与相对路径标记', () => {
    expect(sanitizeRelativePath('a//./b/../c')).toBe(path.join('a', 'b', 'c'))
  })
})

describe('commonAncestor — 公共祖先目录', () => {
  it('取多个目录的公共祖先', () => {
    const root = path.resolve(path.sep === '\\' ? 'C:\\' : '/')
    const a = path.join(root, 'Music', 'A')
    const b = path.join(root, 'Music', 'B')
    expect(commonAncestor([a, b])).toBe(path.join(root, 'Music'))
  })

  it('空数组返回空串', () => {
    expect(commonAncestor([])).toBe('')
  })
})

describe('uniqueFileName — 同名加序号', () => {
  it('目录里没有同名文件时用原名', () => {
    const reserved = new Set<string>()
    expect(uniqueFileName(workDir, 'Lemon', 'mp3', reserved)).toBe('Lemon.mp3')
  })

  it('目录里已有同名文件时追加 (2)', () => {
    fs.writeFileSync(path.join(workDir, 'dup.mp3'), 'x')
    const reserved = new Set<string>()
    expect(uniqueFileName(workDir, 'dup', 'mp3', reserved)).toBe('dup (2).mp3')
  })

  it('同一批次内两个文件映射到同名时各自拿到不同序号', () => {
    const dir = fs.mkdtempSync(path.join(workDir, 'batch-'))
    const reserved = new Set<string>()
    expect(uniqueFileName(dir, 'Song', 'mp3', reserved)).toBe('Song.mp3')
    expect(uniqueFileName(dir, 'Song', 'mp3', reserved)).toBe('Song (2).mp3')
    expect(uniqueFileName(dir, 'Song', 'mp3', reserved)).toBe('Song (3).mp3')
  })

  it('已存在 (2) 时继续往后找', () => {
    const dir = fs.mkdtempSync(path.join(workDir, 'batch2-'))
    fs.writeFileSync(path.join(dir, 'Song.mp3'), 'x')
    fs.writeFileSync(path.join(dir, 'Song (2).mp3'), 'x')
    const reserved = new Set<string>()
    expect(uniqueFileName(dir, 'Song', 'mp3', reserved)).toBe('Song (3).mp3')
  })
})

describe('buildFileName — 目标文件名', () => {
  it('渲染并清洗模板', () => {
    const r = buildFileName('{artist} - {title}', CTX, 'fallback.mp3')
    expect(r.name).toBe('米津玄師 - Lemon')
    expect(r.warnings).toHaveLength(0)
  })

  it('模板里有非法字符时替换掉', () => {
    const ctx = { ...CTX, tags: { title: ['a/b:c'] } }
    const r = buildFileName('{title}', ctx, 'fallback.mp3')
    expect(r.name).toBe('a_b_c')
  })

  it('未知占位符给出警告但不静默', () => {
    const r = buildFileName('{nope}', CTX, 'fallback.mp3')
    expect(r.warnings.join()).toContain('nope')
  })

  it('渲染为空时回退到原文件名并给警告', () => {
    const ctx = { ...CTX, tags: {} }
    const r = buildFileName('{title}', ctx, '原始名.mp3')
    expect(r.name).toBe('原始名.mp3')
    expect(r.warnings.length).toBeGreaterThan(0)
  })
})

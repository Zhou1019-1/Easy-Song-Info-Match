/**
 * 歌词处理的单元测试：LRC 解析、覆盖率、偏移、正文提取、.lrc 路径。
 */
import { describe, expect, it } from 'vitest'
import {
  applyLrcOffset,
  countLyricLines,
  formatLrcTime,
  lrcCoverage,
  lrcPathFor,
  lyricBody,
  parseLrc,
  plainTextToLrc
} from '@main/core/lyrics'

const TIMED = ['[ti:Lemon]', '[ar:米津玄師]', '[00:00.00]Lemon', '[00:10.00]夢堵塞', '[01:05.50]最後'].join(
  '\n'
)

describe('parseLrc — 解析 LRC', () => {
  it('解析出带时间轴的行并按时间排序', () => {
    const r = parseLrc(TIMED)
    expect(r.timed).toBe(true)
    expect(r.lines).toHaveLength(3)
    expect(r.lines[0]).toEqual({ time: 0, text: 'Lemon' })
    expect(r.lines[1].time).toBeCloseTo(10)
    expect(r.lines[2].time).toBeCloseTo(65.5)
  })

  it('同一行多个时间标签会拆成多行', () => {
    const r = parseLrc('[00:01.00][00:31.00]重复的副歌')
    expect(r.lines).toHaveLength(2)
    expect(r.lines[0].text).toBe('重复的副歌')
    expect(r.lines[1].time).toBeCloseTo(31)
  })

  it('纯文本歌词没有时间轴', () => {
    const r = parseLrc('第一行\n第二行')
    expect(r.timed).toBe(false)
    expect(r.lines).toHaveLength(0)
  })

  it('支持 [mm:ss] 与 [mm:ss:ms] 两种小数分隔符', () => {
    expect(parseLrc('[01:02]x').lines[0].time).toBeCloseTo(62)
    expect(parseLrc('[01:02:500]x').lines[0].time).toBeCloseTo(62.5)
    expect(parseLrc('[01:02.75]x').lines[0].time).toBeCloseTo(62.75)
  })
})

describe('countLyricLines / lrcCoverage — 行数与覆盖率', () => {
  it('纯文本按非空行计数', () => {
    expect(countLyricLines('a\n\n b \n\n')).toBe(2)
  })

  it('带时间轴的歌词覆盖率为 1', () => {
    expect(lrcCoverage(TIMED)).toBe(1)
  })

  it('纯文本歌词覆盖率为 0（提示需手工对齐）', () => {
    expect(lrcCoverage('第一行\n第二行')).toBe(0)
  })
})

describe('applyLrcOffset — 时间轴偏移', () => {
  it('正偏移整体后移', () => {
    const out = applyLrcOffset('[00:10.00]第二行', 500)
    expect(out).toContain('[00:10.500]第二行')
  })

  it('负偏移整体前移', () => {
    const out = applyLrcOffset('[00:10.00]第二行', -500)
    expect(out).toContain('[00:09.500]第二行')
  })

  it('偏移后不越过 0', () => {
    const out = applyLrcOffset('[00:01.00]早', -2000)
    expect(out).toContain('[00:00.000]早')
  })

  it('保留 [ti:] 等元信息行', () => {
    const out = applyLrcOffset(TIMED, 100)
    expect(out).toContain('[ti:Lemon]')
    expect(out).toContain('[ar:米津玄師]')
  })

  it('纯文本歌词不参与偏移，原样返回', () => {
    const plain = '第一行\n第二行'
    expect(applyLrcOffset(plain, 500)).toBe(plain)
  })

  it('偏移 0 时原样返回', () => {
    expect(applyLrcOffset(TIMED, 0)).toBe(TIMED)
  })
})

describe('formatLrcTime — 时间格式', () => {
  it('秒转 mm:ss.mmm', () => {
    expect(formatLrcTime(0)).toBe('00:00.000')
    expect(formatLrcTime(65.5)).toBe('01:05.500')
    expect(formatLrcTime(3599.999)).toBe('59:59.999')
  })

  it('负数夹到 0', () => {
    expect(formatLrcTime(-3)).toBe('00:00.000')
  })
})

describe('plainTextToLrc / lyricBody — 纯文本转换与正文提取', () => {
  it('纯文本转 LRC 占位（每行 0 起点）', () => {
    expect(plainTextToLrc('a\n\nb')).toBe('[00:00.00]a\n[00:00.00]b')
  })

  it('正文提取去掉时间标签与元信息行', () => {
    expect(lyricBody(TIMED)).toBe('Lemon\n夢堵塞\n最後')
  })
})

describe('lrcPathFor — 同名 .lrc 路径', () => {
  it('与音频同目录同名', () => {
    expect(lrcPathFor('D:\\Music\\Lemon.mp3')).toBe('D:\\Music\\Lemon.lrc')
  })

  it('没有扩展名时原样追加', () => {
    expect(lrcPathFor('D:\\Music\\Lemon')).toBe('D:\\Music\\Lemon.lrc')
  })
})

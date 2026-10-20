/**
 * 标签读写（tagIo）的单元测试：直接跑在 8 个音频样本上。
 *
 * 覆盖：各格式读取、ID3 分数型字段、MP4 trkn/disk、歌词帧、
 *       写入与清空、写入失败明确报错、写入前后音频数据区哈希不变。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildWritePlan, readTags, writeTags } from '@main/core/tagIo'
import { computeAudioHash } from '@main/core/hash'

const SAMPLES = path.join(__dirname, 'fixtures', 'samples')

function sample(name: string): string {
  return path.join(SAMPLES, name)
}

let workDir = ''

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'songmatch-tagio-'))
})

afterAll(() => {
  try {
    fs.rmSync(workDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

/** 把样本复制到临时目录，避免污染仓库里的固定样本。 */
function copySample(name: string, as?: string): string {
  const dest = path.join(workDir, as ?? name)
  fs.copyFileSync(sample(name), dest)
  return dest
}

describe('readTags — 读取各格式', () => {
  it('读取 ID3v2.3 的 MP3', () => {
    const r = readTags(sample('01 - 米津玄師 - Lemon.mp3'))
    expect(r.error).toBeUndefined()
    expect(r.format).toBe('id3v2')
    expect(r.tags.title).toEqual(['Lemon'])
    expect(r.tags.artist).toEqual(['米津玄師'])
    expect(r.tags.album).toEqual(['BOOTLEG'])
    expect(r.tags.genre).toEqual(['J-Pop'])
    expect(r.tags.copyright).toEqual(['2018 Sony Music'])
    expect(r.tags.upc).toEqual(['4548736598321'])
    expect(r.tags.itunesadvisory).toEqual(['2'])
  })

  it('ID3 的 TRCK/TPOS 按分子分母拆成音轨号与总音轨数', () => {
    const r = readTags(sample('01 - 米津玄師 - Lemon.mp3'))
    expect(r.tags.track).toEqual(['1'])
    expect(r.tags.totaltracks).toEqual(['12'])
    expect(r.tags.disc).toEqual(['1'])
    expect(r.tags.totaldiscs).toEqual(['1'])
  })

  it('读取 ID3 的 USLT 歌词帧', () => {
    const r = readTags(sample('01 - 米津玄師 - Lemon.mp3'))
    expect(r.tags.lyrics?.[0]).toContain('[00:00.00]Lemon')
  })

  it('读取没有任何标签的 MP3', () => {
    const r = readTags(sample('02 - 无标签 - 未知曲目.mp3'))
    expect(r.error).toBeUndefined()
    expect(r.format).toBe('id3v2')
    expect(Object.keys(r.tags)).toHaveLength(0)
  })

  it('读取 FLAC 的 Vorbis Comment', () => {
    const r = readTags(sample('03 - YOASOBI - あの夢をなぞって.flac'))
    expect(r.error).toBeUndefined()
    expect(r.format).toBe('vorbis')
    expect(r.tags.title).toEqual(['あの夢をなぞって'])
    expect(r.tags.artist).toEqual(['YOASOBI'])
    expect(r.tags.track).toEqual(['1'])
    expect(r.tags.totaltracks).toEqual(['12'])
    expect(r.tags.totaldiscs).toEqual(['1'])
    expect(r.tags.lyrics?.[0]).toContain('あの夢をなぞって')
  })

  it('乱码标签原样读出（修复只在扫描展示层做，不改盘）', () => {
    const r = readTags(sample('04 - 米津玄師 - 乱码.mp3'))
    expect(r.tags.title?.[0]).toContain('æ')
    expect(r.tags.artist).toEqual(['米津玄師'])
  })

  it('艺名里的斜杠不会被拆开（AC/DC）', () => {
    const r = readTags(sample('05 - ACDC & 张三 - 非法字符测试.mp3'))
    expect(r.tags.artist).toEqual(['AC/DC'])
    expect(r.tags.albumartist).toEqual(['张三'])
  })

  it('读取 WAV 的 RIFF INFO 标签', () => {
    const r = readTags(sample('06 - Various - wave.wav'))
    expect(r.error).toBeUndefined()
    expect(r.format).toBe('riff')
    expect(r.tags.title).toEqual(['Wave Sample'])
    expect(r.tags.artist).toEqual(['Various'])
    expect(r.tags.album).toEqual(['Compilation'])
    expect(r.tags.genre).toEqual(['Test'])
    expect(r.tags.year).toEqual(['2020'])
    // WAV 能力弱，必须给出提示
    expect(r.warnings.join()).toContain('RIFF INFO')
  })

  it('读取 MP4/M4A，包括 trkn / disk 二进制对与 freeform 厂牌', () => {
    const r = readTags(sample('07 - Taylor Swift - Love Story.m4a'))
    expect(r.error).toBeUndefined()
    expect(r.format).toBe('mp4')
    expect(r.tags.title).toEqual(['Love Story'])
    expect(r.tags.artist).toEqual(['Taylor Swift'])
    expect(r.tags.track).toEqual(['5'])
    expect(r.tags.totaltracks).toEqual(['12'])
    expect(r.tags.disc).toEqual(['1'])
    expect(r.tags.totaldiscs).toEqual(['2'])
    expect(r.tags.label).toEqual(['Big Machine'])
  })

  it('损坏文件明确报错', () => {
    const r = readTags(sample('08 - 损坏文件 - broken.flac'))
    expect(r.error).toBeTruthy()
    expect(r.error).toContain('FLAC')
    expect(r.corrupt).toBe(true)
  })
})

describe('buildWritePlan — 物理键冲突消解', () => {
  it('ID3 的音轨号与总音轨数合并进同一个 TRCK 帧', () => {
    const { plan, conflicts } = buildWritePlan('id3v2', { track: ['3'], totaltracks: ['12'] })
    expect(conflicts).toHaveLength(0)
    const entry = plan.get('TRCK')
    expect(entry?.values).toEqual(['3/12'])
    expect(entry?.pair).toEqual({ numerator: '3', denominator: '12' })
  })

  it('只有总音轨数没有音轨号时明确记冲突，不静默丢弃', () => {
    const { plan, conflicts } = buildWritePlan('id3v2', { totaltracks: ['12'] })
    expect(conflicts.length).toBeGreaterThan(0)
    expect(conflicts[0]).toContain('totaltracks')
    expect(plan.has('TRCK')).toBe(false)
  })

  it('MP4 的音轨号与总音轨数合并进 trkn，并记录分子分母', () => {
    const { plan } = buildWritePlan('mp4', { track: ['7'], totaltracks: ['20'] })
    const entry = plan.get('trkn')
    expect(entry?.pair).toEqual({ numerator: '7', denominator: '20' })
  })

  it('两个语义字段命中同一物理键时记冲突而不是双写', () => {
    const { conflicts } = buildWritePlan('id3v2', { label: ['A'], organization: ['B'] })
    expect(conflicts.length).toBeGreaterThan(0)
  })

  it('格式不支持的字段进入 unsupported', () => {
    const { unsupported } = buildWritePlan('riff', { label: ['X'] })
    expect(unsupported).toContain('label')
  })
})

describe('writeTags — 写入', () => {
  it('写入 ID3 标签后可原样读回', () => {
    const p = copySample('01 - 米津玄師 - Lemon.mp3')
    const res = writeTags(p, { title: ['Lemon Remastered'], album: ['NEW ALBUM'] })
    expect(res.ok).toBe(true)
    expect(res.failed).toHaveLength(0)

    const after = readTags(p)
    expect(after.tags.title).toEqual(['Lemon Remastered'])
    expect(after.tags.album).toEqual(['NEW ALBUM'])
  })

  it('写入音轨号与总音轨数后能分别读回分子与分母', () => {
    const p = copySample('01 - 米津玄師 - Lemon.mp3')
    const res = writeTags(p, { track: ['3'], totaltracks: ['12'] })
    expect(res.ok).toBe(true)
    const after = readTags(p)
    expect(after.tags.track).toEqual(['3'])
    expect(after.tags.totaltracks).toEqual(['12'])
  })

  it('写入 MP4 的音轨号与总音轨数不会串到碟号上', () => {
    const p = copySample('07 - Taylor Swift - Love Story.m4a')
    const res = writeTags(p, { track: ['7'], totaltracks: ['20'] })
    expect(res.ok).toBe(true)
    const after = readTags(p)
    expect(after.tags.track).toEqual(['7'])
    expect(after.tags.totaltracks).toEqual(['20'])
    // 碟号不应被音轨号污染
    expect(after.tags.disc).toEqual(['1'])
    expect(after.tags.totaldiscs).toEqual(['2'])
  })

  it('写入 ID3 歌词（USLT）后可读回', () => {
    const p = copySample('02 - 无标签 - 未知曲目.mp3')
    const res = writeTags(p, { lyrics: ['[00:00.00]第一行\n[00:05.00]第二行'] })
    expect(res.ok).toBe(true)
    const after = readTags(p)
    expect(after.tags.lyrics?.[0]).toContain('第一行')
  })

  it('写入带斜杠的艺名不会被拆开', () => {
    const p = copySample('02 - 无标签 - 未知曲目.mp3')
    const res = writeTags(p, { artist: ['AC/DC'] })
    expect(res.ok).toBe(true)
    const after = readTags(p)
    expect(after.tags.artist).toEqual(['AC/DC'])
  })

  it('清空字段（空数组）后该字段消失', () => {
    const p = copySample('01 - 米津玄師 - Lemon.mp3')
    const res = writeTags(p, { title: [], album: [] })
    expect(res.ok).toBe(true)
    const after = readTags(p)
    expect(after.tags.title).toBeUndefined()
    expect(after.tags.album).toBeUndefined()
  })

  it('MusicBrainz Recording ID 通过 TXXX 写入并可读回', () => {
    const p = copySample('01 - 米津玄師 - Lemon.mp3')
    const res = writeTags(p, { mb_recording_id: ['abc-123'] })
    expect(res.ok).toBe(true)
    const after = readTags(p)
    expect(after.tags.mb_recording_id).toEqual(['abc-123'])
  })

  it('WAV 写入基础字段成功，不支持字段明确失败', () => {
    const p = copySample('06 - Various - wave.wav')
    const res = writeTags(p, { title: ['New Title'], artist: ['New Artist'] })
    expect(res.ok).toBe(true)
    expect(res.failed).toHaveLength(0)

    const after = readTags(p)
    expect(after.format).toBe('riff')
    expect(after.tags.title).toEqual(['New Title'])
    expect(after.tags.artist).toEqual(['New Artist'])
  })

  it('WAV 不支持的字段（歌词）明确失败并给出原因', () => {
    const p = copySample('06 - Various - wave.wav')
    const res = writeTags(p, { lyrics: ['[00:00.00]x'] })
    expect(res.ok).toBe(false)
    expect(res.failed.some((f) => f.field === 'lyrics' && /不支持/.test(f.reason ?? ''))).toBe(true)
  })

  it('写入前后音频数据区哈希不变（只改元数据不动音频流）', () => {
    const p = copySample('01 - 米津玄師 - Lemon.mp3')
    const before = computeAudioHash(p, 'id3v2')
    const res = writeTags(p, { title: ['Hash Check'], lyrics: ['[00:00.00]x'] })
    expect(res.ok).toBe(true)
    const after = computeAudioHash(p, 'id3v2')
    expect(before).toBeTruthy()
    expect(after).toBe(before)
  })
})

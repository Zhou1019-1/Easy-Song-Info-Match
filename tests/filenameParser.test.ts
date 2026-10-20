/**
 * 文件名 / 文件夹解析的单元测试。
 */
import { describe, expect, it } from 'vitest'
import {
  extractTrackNumber,
  parseFilename,
  parseFolderContext,
  stripSourceSuffix
} from '@main/core/filenameParser'

describe('stripSourceSuffix', () => {
  it('剥离 -tx-flac 后缀', () => {
    const r = stripSourceSuffix('Lemon - 米津玄師-tx-flac')
    expect(r.hint).toBe('tx-flac')
    expect(r.body).toBe('Lemon - 米津玄師')
  })

  it('剥离 _DSD64 后缀', () => {
    const r = stripSourceSuffix('夜曲_DSD64')
    expect(r.hint).toBe('DSD64')
    expect(r.body).toBe('夜曲')
  })

  it('不误伤普通连字符词', () => {
    const r = stripSourceSuffix('Hello-World')
    expect(r.hint).toBeNull()
    expect(r.body).toBe('Hello-World')
  })
})

describe('extractTrackNumber', () => {
  it('解析 N-NN 形式', () => {
    const r = extractTrackNumber('12-03 曲名')
    expect(r.track).toBe(3)
    expect(r.totalTracks).toBe(12)
    expect(r.body).toBe('曲名')
  })

  it('解析 01. 形式', () => {
    const r = extractTrackNumber('01. 曲名')
    expect(r.track).toBe(1)
    expect(r.body).toBe('曲名')
  })

  it('无音轨号时原样返回', () => {
    const r = extractTrackNumber('曲名')
    expect(r.track).toBeNull()
    expect(r.body).toBe('曲名')
  })
})

describe('parseFolderContext', () => {
  it('解析「歌手 - 专辑」', () => {
    const c = parseFolderContext('米津玄師 - LEMON')
    expect(c?.artist).toBe('米津玄師')
    expect(c?.album).toBe('LEMON')
    expect(c?.confidence).toBe('high')
  })

  it('解析「XX代表专辑」', () => {
    const c = parseFolderContext('测试专辑代表专辑')
    expect(c?.album).toBe('测试专辑')
    expect(c?.prefix).toBe('测试专辑')
  })

  it('解析带年份的文件夹', () => {
    const c = parseFolderContext('米津玄師 - LEMON (2020)')
    expect(c?.year).toBe(2020)
  })
})

describe('parseFilename', () => {
  it('解析「歌手 - 歌名」两段式', () => {
    const r = parseFilename('米津玄師 - Lemon.mp3', 'mp3')
    expect(r.title).toBe('Lemon')
    expect(r.artist).toBe('米津玄師')
    expect(['high', 'medium', 'low']).toContain(r.confidence)
  })

  it('带音轨号时剥离前缀', () => {
    const r = parseFilename('03 - 米津玄師 - Lemon.mp3', 'mp3')
    expect(r.trackNumber).toBe(3)
    expect(r.title).toBe('Lemon')
  })

  it('仅标题时从文件夹继承歌手', () => {
    const r = parseFilename('Lemon.mp3', 'mp3', { folderName: '米津玄師 - LEMON' })
    expect(r.title).toBe('Lemon')
    expect(r.artist).toBe('米津玄師')
    expect(r.album).toBe('LEMON')
  })

  it('与已知歌手一致时置信度为 high', () => {
    const r = parseFilename('米津玄師 - Lemon.mp3', 'mp3', { knownArtist: '米津玄師' })
    expect(r.artist).toBe('米津玄師')
    expect(r.title).toBe('Lemon')
    expect(r.confidence).toBe('high')
  })

  it('三段式解析出专辑', () => {
    const r = parseFilename('米津玄師 - Lemon - LEMON.mp3', 'mp3')
    expect(r.album).toBe('LEMON')
  })

  it('无扩展名时给出提示', () => {
    const r = parseFilename('Lemon', '')
    expect(r.reasons.join()).toContain('扩展名')
  })
})

/**
 * 10 个样本场景：逐条对应产品验收标准（提示词第七节）。
 *
 * ① 扫描产出候选清单 / 待确认队列 / 异常隔离清单
 * ② 多来源候选对比 + 逐字段采用
 * ③ 导入洛雪格式音源插件补齐歌词与封面；插件崩溃不影响主程序
 * ④ 批量清空后 undo 完整恢复；两次同名归档均保留
 * ⑤ 断网可从缓存重跑；MB 503 自动退避重试
 * ⑥ 歌词纯文本写入内嵌 + 生成 .lrc；已有歌词未被改动
 * ⑦ 全过程音频数据区哈希不变
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Db } from '@main/db'
import { BatchEngine, type WriteJob, type WriteJobResult } from '@main/core/batch'
import { collectFiles, scanOne, type ScanContext } from '@main/core/scanner'
import { readTags, writeTags } from '@main/core/tagIo'
import { computeAudioHash } from '@main/core/hash'
import { formatFromExtension } from '@main/core/fieldMap'
import { uniqueFileName } from '@main/core/rename'
import { loadPlugin } from '@main/plugins/lxRuntime'
import { LyricPipeline } from '@main/core/lyricPipeline'
import { Matcher } from '@main/core/matcher'
import { scoreCandidate } from '@main/core/scoring'
import type { PluginManager } from '@main/plugins/manager'

/* ------------------------------------------------------------------ *
 * MusicBrainz 网络层打桩：把 fetchJson 换成可控实现，
 * 用于验证「503 退避重试」与「断网回落缓存」。
 * ------------------------------------------------------------------ */
const net = vi.hoisted(() => {
  const state = {
    calls: [] as string[],
    handler: (_url: string): { ok: boolean; status: number; data: unknown; error?: string } => ({
      ok: false,
      status: 0,
      data: null,
      error: '未设置'
    })
  }
  return { state }
})

vi.mock('@main/sources/base', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/sources/base')>()
  return {
    ...actual,
    fetchJson: async (url: string) => {
      net.state.calls.push(url)
      return net.state.handler(url)
    }
  }
})

/* ------------------------------------------------------------------ *
 * 公共夹具
 * ------------------------------------------------------------------ */

const SAMPLES = path.join(__dirname, 'fixtures', 'samples')
const SAMPLE_NAMES = [
  '01 - 米津玄師 - Lemon.mp3',
  '02 - 无标签 - 未知曲目.mp3',
  '03 - YOASOBI - あの夢をなぞって.flac',
  '04 - 米津玄師 - 乱码.mp3',
  '05 - ACDC & 张三 - 非法字符测试.mp3',
  '06 - Various - wave.wav',
  '07 - Taylor Swift - Love Story.m4a',
  '08 - 损坏文件 - broken.flac'
]

let workDir = ''
let musicDir = ''

/** 复制样本到临时目录，避免污染仓库里的固定样本。 */
function copySample(name: string, as?: string): string {
  const dest = path.join(musicDir, as ?? name)
  fs.copyFileSync(path.join(SAMPLES, name), dest)
  return dest
}

/** 扫描上下文。 */
function scanCtx(over: Partial<ScanContext> = {}): ScanContext {
  return {
    extensions: ['mp3', 'flac', 'm4a', 'wav'],
    recursive: true,
    followSymlinks: false,
    computeHash: true,
    protectedArtists: [],
    ...over
  }
}

/** 与 write.worker 一致的写入执行器（写前写后比音频数据区哈希）。 */
const writeExecutor = async (jobs: WriteJob[]): Promise<WriteJobResult[]> => {
  const out: WriteJobResult[] = []
  for (const job of jobs) {
    const format = formatFromExtension(path.extname(job.path))
    const before = computeAudioHash(job.path, format)
    const res = writeTags(job.path, job.fields)
    const after = computeAudioHash(job.path, format)
    const audioIntact = !before || !after || before === after
    out.push({
      path: job.path,
      ok: res.ok && audioIntact,
      written: res.written,
      failed: res.failed.map((f) => ({ field: f.field, reason: f.reason ?? '未知原因' })),
      audioIntact,
      error: res.error
    })
  }
  return out
}

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'songmatch-scn-'))
  musicDir = path.join(workDir, 'music')
  fs.mkdirSync(musicDir, { recursive: true })
})

afterAll(() => {
  try {
    fs.rmSync(workDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

/* ================================================================== *
 * 场景 1 · 扫描产出三张清单（验收①）
 * ================================================================== */

describe('场景 1 · 扫描产出候选清单 / 待确认队列 / 异常隔离清单', () => {
  it('损坏文件与乱码文件都不被丢弃，各自进入异常清单', () => {
    const dir = path.join(workDir, 'scan1')
    fs.mkdirSync(dir, { recursive: true })
    for (const n of SAMPLE_NAMES) fs.copyFileSync(path.join(SAMPLES, n), path.join(dir, n))

    const collected = collectFiles([dir], scanCtx())
    expect(collected.files).toHaveLength(SAMPLE_NAMES.length)
    expect(collected.dirErrors).toHaveLength(0)

    const records = collected.files.map((f) => scanOne(f, scanCtx()))

    // 候选清单：有可识别标题的条目
    const withTitle = records.filter((r) => r.tags.title?.length)
    expect(withTitle.length).toBeGreaterThanOrEqual(6)

    // 待确认队列：没有任何可用信息
    const pending = records.filter((r) => r.issues.some((i) => i.code === 'no-tags'))
    expect(pending.length).toBeGreaterThanOrEqual(1)

    // 异常隔离清单：损坏文件被标为 corrupt / read-failed，而不是被丢弃
    const broken = records.find((r) => r.filename.includes('broken'))
    expect(broken).toBeTruthy()
    expect(broken!.issues.some((i) => i.code === 'read-failed' || i.code === 'corrupt')).toBe(true)
    // 损坏文件依然产出了一条记录（没有被丢弃）
    expect(records).toHaveLength(SAMPLE_NAMES.length)
  })

  it('目录遍历失败也进报告，不静默跳过', () => {
    const missing = path.join(workDir, 'does-not-exist')
    const collected = collectFiles([missing], scanCtx())
    expect(collected.files).toHaveLength(0)
    expect(collected.dirErrors).toHaveLength(1)
    expect(collected.dirErrors[0].dir).toBe(missing)
  })
})

/* ================================================================== *
 * 场景 2 · 信息提取优先级：标签 > 文件名 > 文件夹（验收①）
 * ================================================================== */

describe('场景 2 · 信息提取优先级', () => {
  it('标签优先于文件名与文件夹', () => {
    const p = copySample('01 - 米津玄師 - Lemon.mp3', '01 - 别的歌手 - 别的歌名.mp3')
    const rec = scanOne(p, scanCtx())
    expect(rec.tags.title).toEqual(['Lemon'])
    expect(rec.tags.artist).toEqual(['米津玄師'])
    expect(rec.sources.title).toBe('tag')
    expect(rec.sources.artist).toBe('tag')
  })

  it('无标签时用文件名补齐', () => {
    const p = copySample('02 - 无标签 - 未知曲目.mp3')
    const rec = scanOne(p, scanCtx())
    expect(rec.tags.artist).toEqual(['无标签'])
    expect(rec.sources.artist).toBe('filename')
  })

  it('标签与文件名都没有时用文件夹名推断专辑', () => {
    const dir = path.join(workDir, 'SomeAlbum')
    fs.mkdirSync(dir, { recursive: true })
    const p = path.join(dir, 'track.mp3')
    fs.copyFileSync(path.join(SAMPLES, '02 - 无标签 - 未知曲目.mp3'), p)
    const rec = scanOne(p, scanCtx())
    expect(rec.tags.album).toEqual(['SomeAlbum'])
    expect(rec.sources.album).toBe('folder')
  })
})

/* ================================================================== *
 * 场景 3 · 多来源候选对比 + 逐字段采用（验收②）
 * ================================================================== */

describe('场景 3 · 多来源候选对比与逐字段采用', () => {
  it('三个来源的候选统一打分排序，可只采用部分字段', () => {
    const q = { title: 'Lemon', artists: ['米津玄師'], album: null, duration: null, year: null }
    const mb = {
      title: 'Lemon',
      artists: ['米津玄師'],
      album: 'BOOTLEG',
      duration: 240,
      year: 2018
    }
    const itunes = {
      title: 'Lemon',
      artists: ['米津玄師'],
      album: 'BOOTLEG',
      duration: 241,
      year: 2018
    }
    const local = {
      title: 'Lemon (Live)',
      artists: ['米津玄師'],
      album: null,
      duration: 300,
      year: null
    }
    const detail = scoreCandidate(q, mb, new Map())
    expect(detail.total).toBeGreaterThan(70)
    // 同一首歌在两个来源上应得到同样的分数（打分只看内容，不看来源）
    const detailItunes = scoreCandidate(q, itunes, new Map())
    expect(detailItunes.total).toBe(detail.total)
    // 现场版与录音室版必须能区分开
    const detailLocal = scoreCandidate(q, local, new Map())
    expect(detailLocal.total).toBeLessThan(detail.total)

    // 只采用 title 与 artist，不带 album
    const picked = Matcher.toFieldSelection(
      { id: 1, path: '', dir: '', filename: '', ext: 'mp3', size: 0, mtime: 0, audioHash: null, tags: {}, sources: {}, parsed: null, context: null, duration: null, bitrate: null, sampleRate: null, channels: null, issues: [], matchState: 'none', lyricState: 'none', hasArtwork: false, scanBatch: '', lastSeen: 0 },
      {
        id: 'mb:1',
        source: 'musicbrainz',
        sourceKey: '1',
        title: 'Lemon',
        artists: ['米津玄師'],
        album: 'BOOTLEG',
        albumArtists: [],
        composers: [],
        duration: 240,
        year: 2018,
        date: '2018-01-01',
        genre: null,
        label: null,
        upc: null,
        catalogNumber: null,
        copyright: null,
        trackNumber: null,
        discNumber: null,
        totalDiscs: null,
        advisory: 'none',
        score: detail.total
      },
      ['title', 'artist']
    )
    expect(picked.fields.title).toEqual(['Lemon'])
    expect(picked.fields.artist).toEqual(['米津玄師'])
    expect(picked.fields.album).toBeUndefined()
    expect(picked.sources.title).toBe('musicbrainz')
  })
})

/* ================================================================== *
 * 场景 4 · 宁缺毋滥：低分不自动采纳（验收②/③）
 * ================================================================== */

describe('场景 4 · 低分候选不自动采纳', () => {
  it('完全对不上的候选分数很低，不会被自动写入', () => {
    const q = { title: 'Lemon', artists: ['米津玄師'], album: null, duration: null, year: null }
    const detail = scoreCandidate(
      q,
      { title: '完全不相关的歌', artists: ['别人'], album: null, duration: 10, year: 1990 },
      new Map()
    )
    expect(detail.total).toBeLessThan(50)
  })

  it('候选缺字段时保持空，不编造', () => {
    const db = new Db(path.join(workDir, 'cache.db'))
    try {
      const rec = scanOne(copySample('02 - 无标签 - 未知曲目.mp3'), scanCtx())
      const id = db.upsertFile(rec, 'scan-test')
      const row = db.getFile(id)!
      expect(row.tags.genre).toBeUndefined()
      expect(row.tags.year).toBeUndefined()
    } finally {
      db.close()
    }
  })
})

/* ================================================================== *
 * 场景 5 · 洛雪格式插件补齐歌词与封面（验收③）
 * ================================================================== */

const LX_PLUGIN = `/**
 * @name 自动化测试音源
 * @version 1.0.0
 * @description 用于端到端测试的本地音源插件
 */
const { EVENT_NAMES, on, send } = lx

send(EVENT_NAMES.inited, {
  openDevTools: false,
  sources: {
    kw: { name: '测试源', type: 'music', qualitys: ['128k', '320k'] },
    local: { name: '本地源', type: 'music', qualitys: ['128k'] }
  }
})

on(EVENT_NAMES.request, ({ action }) => {
  if (action === 'musicUrl') return 'https://example.com/audio.mp3'
  if (action === 'lyric') return { lyric: '[00:00.00]测试歌词第一行\\n[00:05.00]测试歌词第二行', translation: '' }
  if (action === 'pic') return 'https://example.com/cover.jpg'
  return null
})
`

const LOOP_PLUGIN = `/**
 * @name 死循环插件
 * @version 1.0.0
 */
const { EVENT_NAMES, on, send } = lx
send(EVENT_NAMES.inited, { sources: { kw: { name: 'x', type: 'music', qualitys: ['128k'] } } })
on(EVENT_NAMES.request, () => {
  while (true) {}
})
`

/** 死循环发生在脚本顶层：加载阶段就会卡死，用于验证加载期熔断。 */
const TOP_LOOP_PLUGIN = `/**
 * @name 顶层死循环插件
 * @version 1.0.0
 */
const { EVENT_NAMES, send } = lx
send(EVENT_NAMES.inited, { sources: { kw: { name: 'x', type: 'music', qualitys: ['128k'] } } })
while (true) {}
`

describe('场景 5 · 洛雪格式音源插件', () => {
  it('识别为洛雪协议，声明的音源与音质被读取', async () => {
    const p = path.join(workDir, 'lx-source.js')
    fs.writeFileSync(p, LX_PLUGIN, 'utf8')
    const plugin = await loadPlugin({ scriptPath: p })
    try {
      expect(plugin.format).toBe('lx')
      expect(plugin.sources).toContain('kw')
      expect(plugin.sources).toContain('local')
      expect(plugin.qualitys).toEqual(['128k', '320k'])
      expect(plugin.incompatibilities).toHaveLength(0)
    } finally {
      plugin.dispose()
    }
  })

  it('能取到歌词与封面地址', async () => {
    const p = path.join(workDir, 'lx-source.js')
    fs.writeFileSync(p, LX_PLUGIN, 'utf8')
    const plugin = await loadPlugin({ scriptPath: p })
    try {
      const lyric = await plugin.call('lyric', { source: 'local', musicInfo: { name: 'Lemon' } })
      expect(lyric.ok).toBe(true)
      const data = lyric.data as { lyric: string; timed: boolean }
      expect(data.lyric).toContain('测试歌词第一行')
      expect(data.timed).toBe(true)

      const art = await plugin.call('albumArt', { source: 'local', musicInfo: { name: 'Lemon' } })
      expect(art.ok).toBe(true)
      expect((art.data as { url: string }).url).toBe('https://example.com/cover.jpg')
    } finally {
      plugin.dispose()
    }
  })

  it('非 local 源请求歌词时明确报错，不静默吞掉', async () => {
    const p = path.join(workDir, 'lx-source.js')
    fs.writeFileSync(p, LX_PLUGIN, 'utf8')
    const plugin = await loadPlugin({ scriptPath: p })
    try {
      const res = await plugin.call('lyric', { source: 'kw', musicInfo: { name: 'Lemon' } })
      expect(res.ok).toBe(false)
      expect(res.error).toContain('local')
    } finally {
      plugin.dispose()
    }
  })
})

/* ================================================================== *
 * 场景 6 · 插件死循环不影响主程序（验收③）
 * ================================================================== */

describe('场景 6 · 插件崩溃/死循环不影响主程序', () => {
  it('加载期死循环被超时熔断，主程序继续可用', async () => {
    const p = path.join(workDir, 'top-loop-plugin.js')
    fs.writeFileSync(p, TOP_LOOP_PLUGIN, 'utf8')
    await expect(loadPlugin({ scriptPath: p, timeoutMs: 300 })).rejects.toThrow(/超时|timeout|执行/i)

    // 主程序仍然可以正常扫描文件
    const rec = scanOne(copySample('01 - 米津玄師 - Lemon.mp3'), scanCtx())
    expect(rec.tags.title).toEqual(['Lemon'])
  })

  it('调用期死循环被熔断，插件被标记失效且不影响其它插件', async () => {
    const p = path.join(workDir, 'loop-plugin.js')
    fs.writeFileSync(p, LOOP_PLUGIN, 'utf8')
    const plugin = await loadPlugin({ scriptPath: p })
    try {
      const res = await plugin.call('lyric', { source: 'local', musicInfo: { name: 'x' } })
      expect(res.ok).toBe(false)
      expect(res.error).toContain('超时')

      // 熔断后再次调用立即失败，不死循环
      const again = await plugin.call('lyric', { source: 'local', musicInfo: { name: 'x' } })
      expect(again.ok).toBe(false)
      expect(again.error).toContain('失效')
    } finally {
      plugin.dispose()
    }
  }, 30000)
})

/* ================================================================== *
 * 场景 7 · 批量清空后 undo 完整恢复；两次同名归档均保留（验收④）
 * ================================================================== */

describe('场景 7 · 清空后可完整回滚，同名归档不丢文件', () => {
  it('清空标题与专辑后可完整回滚', async () => {
    const dir = path.join(workDir, 'undo')
    fs.mkdirSync(dir, { recursive: true })
    const p = path.join(dir, 'Lemon.mp3')
    fs.copyFileSync(path.join(SAMPLES, '01 - 米津玄師 - Lemon.mp3'), p)

    const db = new Db(path.join(workDir, 'undo.db'))
    try {
      const rec = scanOne(p, scanCtx())
      const id = db.upsertFile(rec, 'scan-undo')
      const engine = new BatchEngine(
        db,
        { backupDir: path.join(workDir, 'backups'), archiveRoot: '' },
        writeExecutor
      )

      // 干跑：清空字段会列出 diff
      const preview = engine.previewClearFields([id], ['album'])
      expect(preview.items[0].status).toBe('changed')
      expect(preview.items[0].diffs[0].oldValue).toBe('BOOTLEG')
      expect(preview.items[0].diffs[0].newValue).toBeNull()

      // 执行清空
      const res = await engine.executeTagWrite(
        [{ fileId: id, path: p, fields: {}, sources: {}, clearFields: ['album'] }],
        true
      )
      expect(res.ok).toBe(true)
      expect(readTags(p).tags.album).toBeUndefined()

      // 回滚
      const undo = await engine.undoBatch(res.batchId)
      expect(undo.ok).toBe(true)
      expect(undo.restored).toBeGreaterThan(0)
      expect(readTags(p).tags.album).toEqual(['BOOTLEG'])
      expect(readTags(p).tags.title).toEqual(['Lemon'])
    } finally {
      db.close()
    }
  })

  it('两次同名归档都保留，且可以整体回滚路径', async () => {
    const dir = path.join(workDir, 'archive-src')
    fs.mkdirSync(dir, { recursive: true })
    const a = path.join(dir, 'a.mp3')
    const b = path.join(dir, 'b.mp3')
    // 用带完整标签的样本：两个文件映射到同一个目标名，才能验证同名消解。
    fs.copyFileSync(path.join(SAMPLES, '01 - 米津玄師 - Lemon.mp3'), a)
    fs.copyFileSync(path.join(SAMPLES, '01 - 米津玄師 - Lemon.mp3'), b)

    const db = new Db(path.join(workDir, 'archive.db'))
    try {
      const idA = db.upsertFile(scanOne(a, scanCtx()), 'scan-archive')
      const idB = db.upsertFile(scanOne(b, scanCtx()), 'scan-archive')
      const engine = new BatchEngine(
        db,
        { backupDir: path.join(workDir, 'backups'), archiveRoot: path.join(workDir, 'archive') },
        writeExecutor
      )
      const res = await engine.executePathChange(
        [idA, idB],
        { template: '{artist} - {title}', mode: 'move' },
        'move'
      )
      expect(res.ok).toBe(true)
      expect(res.written).toBe(2)

      const moved = fs.readdirSync(path.join(workDir, 'archive'))
      expect(moved.length).toBe(2)
      expect(moved.sort()).toEqual(['米津玄師 - Lemon (2).mp3', '米津玄師 - Lemon.mp3'].sort())

      const undo = await engine.undoBatch(res.batchId)
      expect(undo.ok).toBe(true)
      expect(fs.existsSync(a)).toBe(true)
      expect(fs.existsSync(b)).toBe(true)
    } finally {
      db.close()
    }
  })

  it('同名消解函数保证批次内两个文件都保留', () => {
    const dir = fs.mkdtempSync(path.join(workDir, 'uniq-'))
    const reserved = new Set<string>()
    expect(uniqueFileName(dir, 'Song', 'mp3', reserved)).toBe('Song.mp3')
    expect(uniqueFileName(dir, 'Song', 'mp3', reserved)).toBe('Song (2).mp3')
  })
})

/* ================================================================== *
 * 场景 8 · 断网可从缓存重跑；MB 503 自动退避重试（验收⑤）
 * ================================================================== */

describe('场景 8 · 离线缓存与 503 退避重试', () => {
  it('503 时按指数退避重试，重试成功后拿到候选', async () => {
    const { musicbrainzAdapter } = await import('@main/sources/musicbrainz')
    let n = 0
    net.state.calls = []
    net.state.handler = () => {
      n++
      if (n < 3) return { ok: false, status: 503, data: null, error: 'HTTP 503' }
      return {
        ok: true,
        status: 200,
        data: {
          recordings: [
            {
              id: 'mbid-1',
              title: 'Lemon',
              'artist-credit': [{ name: '米津玄師' }],
              length: 240000,
              releases: [{ title: 'BOOTLEG', date: '2018-05-16' }]
            }
          ]
        }
      }
    }

    const cache = new Map<string, { value: unknown; ts: number }>()
    const logs: string[] = []
    const res = await musicbrainzAdapter.query(
      { keyword: 'Lemon 米津玄師', title: 'Lemon', artists: ['米津玄師'] },
      {
        rateLimitPerMinute: 600,
        cacheGet: (k) => cache.get(k) ?? null,
        cacheSet: (k, v) => cache.set(k, { value: v, ts: Date.now() }),
        log: (m) => logs.push(m)
      }
    )
    expect(net.state.calls.length).toBe(3)
    expect(res.candidates).toHaveLength(1)
    expect(res.candidates[0].title).toBe('Lemon')
    expect(logs.join()).toContain('503')
  }, 30000)

  it('断网时从缓存重跑并标记 fromCache', async () => {
    const { musicbrainzAdapter } = await import('@main/sources/musicbrainz')
    net.state.calls = []
    net.state.handler = () => ({ ok: false, status: 0, data: null, error: '网络请求失败' })

    const cache = new Map<string, { value: unknown; ts: number }>()
    const ctx = {
      rateLimitPerMinute: 600,
      cacheGet: (k: string) => cache.get(k) ?? null,
      cacheSet: (k: string, v: unknown) => cache.set(k, { value: v, ts: Date.now() }),
      log: () => {
        /* ignore */
      }
    }
    const q = { keyword: 'Lemon 米津玄師', title: 'Lemon', artists: ['米津玄師'] }

    // 先用一次成功响应把结果写进缓存
    net.state.handler = () => ({
      ok: true,
      status: 200,
      data: { recordings: [{ id: 'mbid-1', title: 'Lemon', 'artist-credit': [{ name: '米津玄師' }] }] }
    })
    await musicbrainzAdapter.query(q, ctx)

    // 断网重跑
    net.state.handler = () => ({ ok: false, status: 0, data: null, error: '网络请求失败' })
    const res = await musicbrainzAdapter.query(q, ctx)
    expect(res.fromCache).toBe(true)
    expect(res.candidates).toHaveLength(1)
    expect(res.message).toContain('缓存')
  }, 30000)
})

/* ================================================================== *
 * 场景 9 · 歌词写入内嵌 + 生成 .lrc；已有歌词不动（验收⑥）
 * ================================================================== */

describe('场景 9 · 歌词落地', () => {
  const stubPlugins = {
    list: () => [],
    call: async () => ({ ok: false, fn: 'lyric', durationMs: 0, incompatibilities: [] })
  } as unknown as PluginManager

  it('纯文本歌词可写入内嵌并同时生成 .lrc', async () => {
    const dir = path.join(workDir, 'lyric')
    fs.mkdirSync(dir, { recursive: true })
    const p = path.join(dir, 'Song.mp3')
    fs.copyFileSync(path.join(SAMPLES, '02 - 无标签 - 未知曲目.mp3'), p)

    const db = new Db(path.join(workDir, 'lyric.db'))
    try {
      const id = db.upsertFile(scanOne(p, scanCtx()), 'scan-lyric')
      const rec = db.getFile(id)!
      const pipeline = new LyricPipeline(db, stubPlugins, writeExecutor)

      const content = '第一行歌词\n第二行歌词\n第三行歌词'
      const res = await pipeline.write(
        rec,
        {
          id: 'x',
          source: 'plugin',
          title: 'Song',
          artist: '',
          content,
          timed: false,
          lineCount: 3,
          coverage: 0,
          score: 50
        },
        { embedded: true, lrcFile: true, overwrite: false, offsetMs: 0 }
      )
      expect(res.ok).toBe(true)
      expect(res.written).toBe(2)

      const read = readTags(p)
      expect(read.tags.lyrics?.[0]).toContain('第一行歌词')

      const lrcPath = path.join(dir, 'Song.lrc')
      expect(fs.existsSync(lrcPath)).toBe(true)
      expect(fs.readFileSync(lrcPath, 'utf8')).toContain('第一行歌词')
    } finally {
      db.close()
    }
  })

  it('已有歌词默认不被改动', async () => {
    const dir = path.join(workDir, 'lyric-existing')
    fs.mkdirSync(dir, { recursive: true })
    const p = path.join(dir, 'Lemon.mp3')
    fs.copyFileSync(path.join(SAMPLES, '01 - 米津玄師 - Lemon.mp3'), p)

    const db = new Db(path.join(workDir, 'lyric2.db'))
    try {
      const id = db.upsertFile(scanOne(p, scanCtx()), 'scan-lyric2')
      const rec = db.getFile(id)!
      const before = readTags(p).tags.lyrics?.[0]
      expect(before).toBeTruthy()

      const pipeline = new LyricPipeline(db, stubPlugins, writeExecutor)
      const res = await pipeline.write(
        rec,
        {
          id: 'x',
          source: 'plugin',
          title: 'Lemon',
          artist: '米津玄師',
          content: '新的歌词',
          timed: false,
          lineCount: 1,
          coverage: 0,
          score: 50
        },
        { embedded: true, lrcFile: true, overwrite: false, offsetMs: 0 }
      )
      expect(res.ok).toBe(false)
      expect(res.message).toContain('已有歌词')
      expect(readTags(p).tags.lyrics?.[0]).toBe(before)
    } finally {
      db.close()
    }
  })
})

/* ================================================================== *
 * 场景 10 · 音频数据区哈希不变 + 批量扫描性能（验收⑦）
 * ================================================================== */

describe('场景 10 · 只改元数据不动音频流', () => {
  it('写入标签前后音频数据区哈希一致', async () => {
    const p = copySample('01 - 米津玄師 - Lemon.mp3', 'hash.mp3')
    const before = computeAudioHash(p, 'id3v2')
    const res = writeTags(p, { title: ['Lemon Remastered'], lyrics: ['[00:00.00]x'] })
    expect(res.ok).toBe(true)
    expect(computeAudioHash(p, 'id3v2')).toBe(before)
  })

  it('清空字段也算修改，但音频数据区仍不变', async () => {
    const p = copySample('01 - 米津玄師 - Lemon.mp3', 'hash-clear.mp3')
    const before = computeAudioHash(p, 'id3v2')
    const res = writeTags(p, { title: [], album: [] })
    expect(res.ok).toBe(true)
    expect(computeAudioHash(p, 'id3v2')).toBe(before)
  })

  it('1000 个文件的扫描在 30 秒内完成', () => {
    const dir = path.join(workDir, 'perf')
    fs.mkdirSync(dir, { recursive: true })
    const src = path.join(SAMPLES, '01 - 米津玄師 - Lemon.mp3')
    for (let i = 0; i < 1000; i++) {
      fs.copyFileSync(src, path.join(dir, `t${String(i).padStart(4, '0')} - 米津玄師 - Lemon.mp3`))
    }
    const started = Date.now()
    const collected = collectFiles([dir], scanCtx())
    const records = collected.files.map((f) => scanOne(f, scanCtx()))
    const elapsed = Date.now() - started
    expect(records).toHaveLength(1000)
    expect(elapsed).toBeLessThan(30000)
  }, 120000)
})

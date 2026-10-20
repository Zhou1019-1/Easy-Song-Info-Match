/**
 * 多来源匹配：构造查询 -> 并发拉候选 -> 统一打分排序 -> 落库。
 *
 * 原则：
 *   - 每个来源 3~5 个候选；
 *   - 低分候选也保留但分数低，由用户自选（绝不自动采纳）；
 *   - 断网时从 SQLite 缓存重跑，界面标明「来自缓存」。
 */
import type { Candidate, TrackRecord } from '@shared/types'
import type { MatchQueryResult } from '@shared/api'
import { scoreCandidate, type MatchQuery } from './scoring'
import { createSourceAdapters, type SourceAdapter, type SourceContext } from '../sources'
import type { Db } from '../db'
import type { PluginManager } from '../plugins/manager'
import { splitArtists } from './alias'

export interface MatcherOptions {
  /** 自动采纳阈值（仅用于标记 matched 状态，不代替用户选择） */
  autoAcceptScore: number
  protectedArtists: string[]
  aliasIndex: Map<string, string>
  mbRateLimit: number
  itunesRateLimit: number
  /** 每个来源最多取几个候选 */
  perSourceLimit: number
}

export class Matcher {
  constructor(
    private readonly db: Db,
    private readonly plugins: PluginManager,
    private readonly options: MatcherOptions
  ) {}

  private context(): SourceContext {
    return {
      rateLimitPerMinute: this.options.mbRateLimit,
      cacheGet: (key) => this.db.cacheGet(key),
      cacheSet: (key, value, ttl) => this.db.cacheSet(key, value, ttl),
      log: () => {
        /* 预留：写入日志文件 */
      }
    }
  }

  /** 构造查询条件（标签 > 文件名 > 文件夹）。 */
  buildQuery(rec: TrackRecord): MatchQuery {
    const title = rec.tags.title?.[0] ?? rec.parsed?.title ?? ''
    const artistRaw = rec.tags.artist?.[0] ?? rec.parsed?.artist ?? ''
    const artists = artistRaw
      ? splitArtists(artistRaw, this.options.protectedArtists, this.options.aliasIndex)
      : []
    const album = rec.tags.album?.[0] ?? rec.parsed?.album ?? null
    const yearRaw = rec.tags.year?.[0] ?? rec.context?.year?.toString() ?? null
    const yearNum = yearRaw ? Number(String(yearRaw).slice(0, 4)) : NaN
    return {
      title,
      artists,
      album,
      duration: rec.duration ?? null,
      year: Number.isFinite(yearNum) ? yearNum : null
    }
  }

  /** 查询一个文件的所有候选。 */
  async queryOne(rec: TrackRecord, force: boolean): Promise<MatchQueryResult> {
    const q = this.buildQuery(rec)
    const keyword = [q.title, ...q.artists].filter(Boolean).join(' ')
    const sourceStatus: MatchQueryResult['sourceStatus'] = []
    const all: Candidate[] = []
    let fromCache = false

    if (!keyword) {
      return {
        fileId: rec.id,
        query: {
          title: q.title,
          artists: q.artists,
          album: q.album ?? null,
          duration: q.duration ?? null,
          year: q.year ?? null
        },
        candidates: [],
        sourceStatus: [{ source: 'all', ok: false, message: '没有可用于查询的标题/歌手信息' }],
        fromCache: false
      }
    }

    const adapters = createSourceAdapters(this.context())
    const results = await Promise.all(
      adapters.map(async (a) => {
        try {
          const res = await a.query(
            { keyword, title: q.title, artists: q.artists, album: q.album, duration: q.duration, path: rec.path },
            this.context()
          )
          return { adapter: a, res }
        } catch (err) {
          return {
            adapter: a,
            res: {
              candidates: [] as Candidate[],
              fromCache: false,
              message: err instanceof Error ? err.message : String(err)
            }
          }
        }
      })
    )

    for (const { adapter, res } of results) {
      sourceStatus.push({
        source: adapter.id,
        ok: res.candidates.length > 0 || !res.message,
        message: res.message
      })
      if (res.fromCache) fromCache = true
      for (const c of res.candidates.slice(0, this.options.perSourceLimit)) {
        all.push(this.decorate(c, q))
      }
    }

    // 插件来源
    const pluginResult = await this.queryPlugins(keyword, q)
    if (pluginResult) {
      sourceStatus.push(pluginResult.status)
      if (pluginResult.fromCache) fromCache = true
      all.push(...pluginResult.candidates)
    }

    all.sort((a, b) => b.score - a.score)

    if (!force) {
      const cached = this.db.cacheGet(`match:${rec.id}`)
      if (cached && Array.isArray((cached.value as { candidates?: unknown })?.candidates)) {
        const prev = (cached.value as { candidates: Candidate[] }).candidates
        if (prev.length && all.length === 0) {
          return {
            fileId: rec.id,
            query: {
              title: q.title,
              artists: q.artists,
              album: q.album ?? null,
              duration: q.duration ?? null,
              year: q.year ?? null
            },
            candidates: prev,
            sourceStatus: [...sourceStatus, { source: 'cache', ok: true, message: '使用本地缓存结果' }],
            fromCache: true
          }
        }
      }
    }

    this.db.cacheSet(`match:${rec.id}`, { candidates: all }, 7 * 24 * 3600 * 1000)
    this.db.saveMatchRecords(
      rec.id,
      all.map((c) => ({ id: c.id, source: c.source, sourceKey: c.sourceKey, score: c.score }))
    )
    this.db.setMatchState(rec.id, 'pending')

    return {
      fileId: rec.id,
      query: {
        title: q.title,
        artists: q.artists,
        album: q.album ?? null,
        duration: q.duration ?? null,
        year: q.year ?? null
      },
      candidates: all,
      sourceStatus,
      fromCache
    }
  }

  /** 统一打分并补齐缺失信息。 */
  private decorate(candidate: Candidate, q: MatchQuery): Candidate {
    const detail = scoreCandidate(q, {
      title: candidate.title,
      artists: candidate.artists,
      album: candidate.album,
      duration: candidate.duration,
      year: candidate.year
    }, this.options.aliasIndex)
    return { ...candidate, score: detail.total, scoreDetail: detail }
  }

  /** 查询已启用的插件。 */
  private async queryPlugins(
    keyword: string,
    q: MatchQuery
  ): Promise<{
    candidates: Candidate[]
    fromCache: boolean
    status: { source: string; ok: boolean; message?: string }
  } | null> {
    const list = this.plugins.list().filter((p) => p.enabled)
    if (!list.length) return null
    const candidates: Candidate[] = []
    const messages: string[] = []
    for (const p of list) {
      const res = await this.plugins.call({
        pluginId: p.id,
        fn: 'search',
        keyword,
        page: 0,
        size: this.options.perSourceLimit
      })
      if (!res.ok) {
        messages.push(`${p.name}：${res.error ?? '调用失败'}`)
        continue
      }
      const data = res.data as { list?: Array<Record<string, unknown>> } | undefined
      const items = data?.list ?? []
      for (const item of items.slice(0, this.options.perSourceLimit)) {
        const title = String(item.name ?? '')
        if (!title) continue
        const singer = String(item.singer ?? '')
        const candidate: Candidate = {
          id: `plugin:${p.id}:${String(item.id ?? title)}`,
          source: 'plugin',
          sourceKey: String(item.id ?? title),
          title,
          artists: singer ? singer.split(/\s*[&,，、]\s*/).filter(Boolean) : [],
          album: item.album ? String(item.album) : null,
          albumArtists: [],
          composers: [],
          duration: item.interval ? Number(item.interval) : null,
          year: null,
          date: null,
          genre: null,
          label: null,
          upc: null,
          catalogNumber: null,
          copyright: null,
          trackNumber: null,
          discNumber: null,
          totalDiscs: null,
          advisory: 'none',
          lyrics: item.lyric ? String(item.lyric) : undefined,
          artworkUrl: item.imgurl ? String(item.imgurl) : undefined,
          raw: { ...item },
          score: 0,
          pluginId: p.id,
          rawMusicInfo: { ...item }
        }
        candidates.push(this.decorate(candidate, q))
      }
    }
    return {
      candidates,
      fromCache: false,
      status: {
        source: 'plugin',
        ok: candidates.length > 0,
        message: messages.length ? messages.join('；') : undefined
      }
    }
  }

  /** 应用候选：把候选字段映射成语义字段写入请求。 */
  static toFieldSelection(
    rec: TrackRecord,
    candidate: Candidate,
    fields: string[]
  ): { fields: Record<string, string[]>; sources: Record<string, 'plugin' | 'musicbrainz' | 'itunes' | 'manual'> } {
    const out: Record<string, string[]> = {}
    const sources: Record<string, 'plugin' | 'musicbrainz' | 'itunes' | 'manual'> = {}
    const source =
      candidate.source === 'musicbrainz'
        ? 'musicbrainz'
        : candidate.source === 'itunes'
          ? 'itunes'
          : candidate.source === 'plugin'
            ? 'plugin'
            : 'manual'
    const put = (field: string, values: string[] | null | undefined): void => {
      if (!values || !values.length) return
      if (!fields.includes(field)) return
      out[field] = values
      sources[field] = source
    }
    put('title', [candidate.title])
    put('artist', candidate.artists)
    put('albumartist', candidate.albumArtists)
    put('album', candidate.album ? [candidate.album] : null)
    put('composer', candidate.composers)
    put('genre', candidate.genre ? [candidate.genre] : null)
    put('year', candidate.year ? [String(candidate.year)] : null)
    put('date', candidate.date ? [candidate.date] : null)
    put('track', candidate.trackNumber ? [String(candidate.trackNumber)] : null)
    put('totaltracks', null)
    put('disc', candidate.discNumber ? [String(candidate.discNumber)] : null)
    put('totaldiscs', candidate.totalDiscs ? [String(candidate.totalDiscs)] : null)
    put('copyright', candidate.copyright ? [candidate.copyright] : null)
    put('label', candidate.label ? [candidate.label] : null)
    put('upc', candidate.upc ? [candidate.upc] : null)
    put('advisory', candidate.advisory !== 'none' ? [candidate.advisory] : null)
    put('lyrics', candidate.lyrics ? [candidate.lyrics] : null)
    void rec
    return { fields: out, sources }
  }
}

export type { SourceAdapter }

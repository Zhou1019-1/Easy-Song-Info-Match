/**
 * MusicBrainz 来源适配器。
 *
 * 官方约束（必须遵守，违反会被封 IP）：
 *   - 必须带 User-Agent，缺失会被直接拒绝（403）；
 *   - 匿名访问 <= 1 请求/秒，这里实现为最小间隔 1100ms + 60 次/分钟；
 *   - 503/429 时必须退避重试（1s / 2s / 4s，带 ±20% 抖动）。
 *
 * 另：每次成功查询都会写缓存，网络失败时回落缓存并标记 fromCache，保证断网可重跑。
 */
import type { Candidate } from '@shared/types'
import type { FetchJsonResult, SourceAdapter, SourceContext, SourceQuery, SourceResult } from './base'
import { fetchJson, isRecord, num, sleep, str, yearOf } from './base'

/** 搜索接口。 */
const MB_ENDPOINT = 'https://musicbrainz.org/ws/2/recording'
/** 必须携带的 UA（官方要求格式：应用名/版本 ( 联系方式或主页 )）。 */
const MB_USER_AGENT = 'SongMatch/1.0 ( https://github.com/Zhou1019-1/Easy-Song-Info-Match )'
/** 每页条数。 */
const PAGE_SIZE = 5
/** 最多返回的候选数（产品规格：每个来源 3~5 条）。 */
const MAX_CANDIDATES = 5
/** 官方要求的最小请求间隔（毫秒）。 */
const MIN_INTERVAL_MS = 1100
/** 失败重试次数（含首次）。 */
const MAX_ATTEMPTS = 3
/** 指数退避基数（毫秒），第 n 次重试等待 BACKOFF_MS[n-1]。 */
const BACKOFF_MS = [1000, 2000, 4000]
/** 缓存有效期：7 天。 */
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** 单次请求超时。 */
const TIMEOUT_MS = 15000

/* ------------------------------------------------------------------ *
 * 限速：进程内共享的时间戳 + Promise 队列，保证并发调用也不会超频。
 * ------------------------------------------------------------------ */

/** 上一次请求发出的时间戳。 */
let lastRequestAt = 0
/** 请求队列尾部，串行化所有对 MusicBrainz 的访问。 */
let queue: Promise<unknown> = Promise.resolve()

/** 抖动：在基准延迟上叠加 ±20% 随机偏移，避免多客户端同时重试打爆对方。 */
function jitter(base: number): number {
  return Math.round(base * (0.8 + Math.random() * 0.4))
}

/** 把任务放进串行队列；前一个任务失败不会阻断队列。 */
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(
    () => task(),
    () => task()
  )
  queue = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

/** 距离上一次请求不足 minInterval 时补足等待，然后执行任务。 */
async function rateLimited<T>(minIntervalMs: number, task: () => Promise<T>): Promise<T> {
  const wait = lastRequestAt + minIntervalMs - Date.now()
  if (wait > 0) await sleep(wait)
  lastRequestAt = Date.now()
  return task()
}

/** 依据上下文计算实际最小间隔：不小于官方 1100ms。 */
function effectiveInterval(ctx: SourceContext): number {
  const perMinute = ctx.rateLimitPerMinute > 0 ? ctx.rateLimitPerMinute : 60
  return Math.max(MIN_INTERVAL_MS, Math.ceil(60000 / perMinute))
}

/* ------------------------------------------------------------------ *
 * 查询串构造
 * ------------------------------------------------------------------ */

/** Lucene 短语内的转义：只需处理引号与反斜杠。 */
function escapeLucene(s: string): string {
  return s.replace(/([\\"])/g, '\\$1')
}

/**
 * 构造 Lucene 查询：`recording:"标题" AND artist:"歌手"`。
 * 标题/歌手都缺失时退化为纯关键词。
 */
export function buildQueryString(q: SourceQuery): string {
  const title = (q.title ?? '').trim()
  const artist = ((q.artists ?? []).find((a) => a && a.trim()) ?? '').trim()
  const parts: string[] = []
  if (title) parts.push(`recording:"${escapeLucene(title)}"`)
  if (artist) parts.push(`artist:"${escapeLucene(artist)}"`)
  if (parts.length) return parts.join(' AND ')
  return (q.keyword ?? '').trim()
}

/**
 * 拼接完整请求 URL。
 * 注意：MusicBrainz 的搜索接口默认不返回 tags/label-info/barcode/track-number，
 * 因此 advisory 只能落到 'none'、label/upc/catalogNumber/trackNumber 为 null（宁缺毋滥）；
 * 若后续需要这些字段，可在 URL 上追加 `&inc=tags&inc=artist-credits` 等参数。
 */
export function buildUrl(queryString: string, offset: number): string {
  return `${MB_ENDPOINT}?query=${encodeURIComponent(queryString)}&fmt=json&limit=${PAGE_SIZE}&offset=${offset}`
}

/* ------------------------------------------------------------------ *
 * 响应映射
 * ------------------------------------------------------------------ */

/** 读取 artist-credit 数组里的名字（忽略 joinphrase）。 */
function creditNames(credit: unknown): string[] {
  if (!Array.isArray(credit)) return []
  const names: string[] = []
  for (const c of credit) {
    if (!isRecord(c)) continue
    const name = str(c.name)
    if (name) names.push(name)
  }
  return names
}

/** 读取 artist-credit 的完整展示串（含 joinphrase）。 */
function creditDisplay(credit: unknown): string {
  if (!Array.isArray(credit)) return ''
  const parts: string[] = []
  for (const c of credit) {
    if (!isRecord(c)) continue
    const name = str(c.name)
    if (!name) continue
    parts.push(name + (str(c.joinphrase) ?? ''))
  }
  return parts.join('')
}

/** 取 releases[0]（没有则 null）。 */
function firstRelease(rec: Record<string, unknown>): Record<string, unknown> | null {
  const releases = rec.releases
  if (!Array.isArray(releases) || !releases.length) return null
  const r = releases[0]
  return isRecord(r) ? r : null
}

/** 取 label-info[0].label.name。 */
function releaseLabel(release: Record<string, unknown> | null): string | null {
  if (!release) return null
  const infos = release['label-info']
  if (!Array.isArray(infos) || !infos.length) return null
  const info = infos[0]
  if (!isRecord(info)) return null
  const label = info.label
  if (!isRecord(label)) return null
  return str(label.name)
}

/** 取 label-info[0].catalog-number。 */
function releaseCatalogNumber(release: Record<string, unknown> | null): string | null {
  if (!release) return null
  const infos = release['label-info']
  if (!Array.isArray(infos) || !infos.length) return null
  const info = infos[0]
  if (!isRecord(info)) return null
  return str(info['catalog-number'])
}

/** 取 media 数组的第一项。 */
function firstMedia(container: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!container) return null
  const media = container.media
  if (!Array.isArray(media) || !media.length) return null
  const m = media[0]
  return isRecord(m) ? m : null
}

/** 判断是否带 explicit 标签。 */
function hasExplicitTag(rec: Record<string, unknown>, release: Record<string, unknown> | null): boolean {
  const check = (tags: unknown): boolean => {
    if (!Array.isArray(tags)) return false
    for (const t of tags) {
      if (!isRecord(t)) continue
      if ((str(t.name) ?? '').toLowerCase() === 'explicit') return true
    }
    return false
  }
  if (check(rec.tags)) return true
  return release ? check(release.tags) : false
}

/** 把一条 recording 映射为候选。 */
function mapRecording(rec: Record<string, unknown>): Candidate | null {
  const mbid = str(rec.id)
  if (!mbid) return null

  const release = firstRelease(rec)
  const artists = creditNames(rec['artist-credit'])
  const display = creditDisplay(rec['artist-credit'])
  const date = release ? str(release.date) : null
  const lengthMs = num(rec.length)
  // 搜索接口把 media 放在 release 上（recording 级 media 只有 lookup 接口才有）
  const media = firstMedia(rec) ?? firstMedia(release)
  const mediaCount = release && Array.isArray(release.media) ? release.media.length : null

  return {
    id: `mb:${mbid}`,
    source: 'musicbrainz',
    sourceKey: mbid,
    title: str(rec.title) ?? '',
    artists,
    album: release ? str(release.title) : null,
    albumArtists: release ? creditNames(release['artist-credit']) : [],
    // 搜索结果不含作曲信息，宁缺毋滥
    composers: [],
    duration: lengthMs == null ? null : Math.round(lengthMs / 1000),
    year: yearOf(date),
    date,
    // 搜索结果不含流派
    genre: null,
    label: releaseLabel(release),
    upc: release ? str(release.barcode) : null,
    catalogNumber: releaseCatalogNumber(release),
    // 搜索结果不含版权信息
    copyright: null,
    trackNumber: num(rec['track-number']),
    discNumber: null,
    totalDiscs: null,
    advisory: hasExplicitTag(rec, release) ? 'explicit' : 'none',
    raw: {
      // 搜索相关度不是最终匹配分，仅作参考保留
      mbScore: num(rec.score),
      artistCredit: display,
      artistsJoined: artists.join(' / '),
      trackCount: media ? num(media['track-count']) : release ? num(release['track-count']) : null,
      discPosition: media ? num(media.position) : null,
      mediaCount,
      disambiguation: str(rec.disambiguation)
    },
    // 打分由整合方（scoring.ts）统一计算
    score: 0,
    scoreDetail: undefined
  }
}

/** 解析响应体里的 recordings 数组。 */
export function mapRecordings(data: unknown): Candidate[] {
  if (!isRecord(data)) return []
  const list = data.recordings
  if (!Array.isArray(list)) return []
  const out: Candidate[] = []
  for (const r of list) {
    if (!isRecord(r)) continue
    const c = mapRecording(r)
    if (c) out.push(c)
    if (out.length >= MAX_CANDIDATES) break
  }
  return out
}

/* ------------------------------------------------------------------ *
 * 请求
 * ------------------------------------------------------------------ */

/** 需要退避重试的状态码。 */
function isRetryable(status: number): boolean {
  return status === 503 || status === 429
}

/** 把 HTTP 状态码翻译成给用户看的文案。 */
function statusMessage(res: FetchJsonResult, attempts: number): string {
  let base: string
  if (res.status === 503) base = '503 服务不可用'
  else if (res.status === 429) base = '429 请求过于频繁'
  else if (res.status === 0) base = res.error ?? '网络请求失败'
  else base = res.error ?? `HTTP ${res.status}`
  if (attempts > 1) base += `（已重试 ${attempts - 1} 次）`
  return base
}

/** 发起请求并按 503/429 做指数退避重试。 */
async function requestWithBackoff(
  url: string,
  ctx: SourceContext,
  minIntervalMs: number
): Promise<{ res: FetchJsonResult; attempts: number }> {
  let res: FetchJsonResult = { ok: false, status: 0, data: null, error: '未知错误' }
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    res = await enqueue(() =>
      rateLimited(minIntervalMs, () =>
        fetchJson(url, {
          headers: {
            'User-Agent': MB_USER_AGENT,
            Accept: 'application/json'
          },
          timeoutMs: TIMEOUT_MS
        })
      )
    )
    if (res.ok) return { res, attempts: attempt + 1 }
    if (!isRetryable(res.status)) return { res, attempts: attempt + 1 }
    if (attempt < MAX_ATTEMPTS - 1) {
      const delay = jitter(BACKOFF_MS[attempt])
      ctx.log(`[MusicBrainz] HTTP ${res.status}，${delay}ms 后重试（第 ${attempt + 1} 次）`)
      await sleep(delay)
    }
  }
  return { res, attempts: MAX_ATTEMPTS }
}

/* ------------------------------------------------------------------ *
 * 适配器
 * ------------------------------------------------------------------ */

export const musicbrainzAdapter: SourceAdapter = {
  id: 'musicbrainz',
  name: 'MusicBrainz',
  offlineCapable: true,

  async query(q: SourceQuery, ctx: SourceContext): Promise<SourceResult> {
    const queryString = buildQueryString(q)
    if (!queryString) {
      return { candidates: [], fromCache: false, message: '缺少查询关键词' }
    }
    const page = Math.max(0, q.page ?? 0)
    const offset = page * PAGE_SIZE
    const url = buildUrl(queryString, offset)
    const cacheKey = `mb:${queryString}:${offset}`
    const minIntervalMs = effectiveInterval(ctx)

    const { res, attempts } = await requestWithBackoff(url, ctx, minIntervalMs)
    if (res.ok) {
      if (!isRecord(res.data) || !Array.isArray(res.data.recordings)) {
        // 响应结构异常不写缓存，避免把坏数据固化下来
        return { candidates: [], fromCache: false, message: '响应格式异常：缺少 recordings 字段' }
      }
      const candidates = mapRecordings(res.data)
      // 只缓存成功响应（含空结果），供断网时重跑
      ctx.cacheSet(cacheKey, res.data, CACHE_TTL_MS)
      return { candidates, fromCache: false }
    }

    const message = statusMessage(res, attempts)
    const cached = ctx.cacheGet(cacheKey)
    if (cached) {
      ctx.log(`[MusicBrainz] 请求失败，回落缓存：${cacheKey}`)
      const candidates = mapRecordings(cached.value)
      return { candidates, fromCache: true, message: `${message}（已使用离线缓存）` }
    }
    ctx.log(`[MusicBrainz] 请求失败且无缓存：${message}`)
    return { candidates: [], fromCache: false, message }
  }
}

export default musicbrainzAdapter

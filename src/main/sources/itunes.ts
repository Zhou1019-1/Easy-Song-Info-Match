/**
 * iTunes Search API 来源适配器。
 *
 * 说明：
 *   - 无需鉴权，官方没有明确的速率限制，但依然写缓存并支持断网重跑；
 *   - iTunes 对中文歌曲经常返回 0 条，属于正常结果，不算错误；
 *   - country 固定 US，避免同一查询请求两次导致结果不可预期。
 */
import type { Candidate } from '@shared/types'
import type { FetchJsonResult, SourceAdapter, SourceContext, SourceQuery, SourceResult } from './base'
import { fetchJson, isRecord, num, str, yearOf } from './base'

/** 搜索接口。 */
const ITUNES_ENDPOINT = 'https://itunes.apple.com/search'
/** 商店地区（固定一个，保证可预期）。 */
const ITUNES_COUNTRY = 'US'
/** 每页条数。 */
const PAGE_SIZE = 5
/** 最多返回的候选数。 */
const MAX_CANDIDATES = 5
/** 缓存有效期：7 天。 */
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** 单次请求超时。 */
const TIMEOUT_MS = 15000

/** 构造搜索词：优先用 keyword，缺失时用「歌名 歌手」拼装。 */
export function buildTerm(q: SourceQuery): string {
  const keyword = (q.keyword ?? '').trim()
  if (keyword) return keyword
  const title = (q.title ?? '').trim()
  const artist = ((q.artists ?? []).find((a) => a && a.trim()) ?? '').trim()
  return [title, artist].filter(Boolean).join(' ')
}

/** 拼接完整请求 URL。 */
export function buildUrl(term: string, offset: number): string {
  const params = new URLSearchParams({
    term,
    entity: 'song',
    limit: String(PAGE_SIZE),
    offset: String(offset),
    country: ITUNES_COUNTRY
  })
  return `${ITUNES_ENDPOINT}?${params.toString()}`
}

/** 由 100x100 封面地址推测 600x600 版本（仅字符串替换，失败则保持原值）。 */
function upgradeArtwork(url: string): string {
  if (!url.includes('100x100')) return url
  return url.replace('100x100', '600x600')
}

/** 把 trackExplicitness 映射为分级。 */
function advisoryOf(raw: string | null): 'explicit' | 'clean' | 'none' {
  const v = (raw ?? '').toLowerCase()
  if (v === 'explicit') return 'explicit'
  if (v === 'clean') return 'clean'
  return 'none'
}

/** 把一条 result 映射为候选。 */
function mapTrack(item: Record<string, unknown>): Candidate | null {
  const trackId = num(item.trackId)
  if (trackId == null) return null

  const artistName = str(item.artistName)
  const collectionId = num(item.collectionId)
  const artwork100 = str(item.artworkUrl100)
  const advisoryRaw = str(item.trackExplicitness)
  const releaseDate = str(item.releaseDate)
  const durationMs = num(item.trackTimeMillis)

  return {
    id: `itunes:${trackId}`,
    source: 'itunes',
    sourceKey: collectionId == null ? '' : String(collectionId),
    title: str(item.trackName) ?? '',
    // 官方 artistName 是一整串（含 feat. 等），这里整串保留为一位歌手
    artists: artistName ? [artistName] : [],
    album: str(item.collectionName),
    albumArtists: (() => {
      const ca = str(item.collectionArtistName)
      return ca ? [ca] : []
    })(),
    composers: [],
    duration: durationMs == null ? null : Math.round(durationMs / 1000),
    year: yearOf(releaseDate),
    date: releaseDate,
    genre: str(item.primaryGenreName),
    label: null,
    upc: null,
    catalogNumber: null,
    copyright: str(item.copyright),
    trackNumber: num(item.trackNumber),
    discNumber: num(item.discNumber),
    totalDiscs: num(item.discCount),
    advisory: advisoryOf(advisoryRaw),
    advisoryRaw: advisoryRaw ?? undefined,
    artworkUrl: artwork100 ? upgradeArtwork(artwork100) : undefined,
    raw: {
      artistName,
      trackCount: num(item.trackCount),
      trackId,
      collectionId,
      collectionName: str(item.collectionName),
      artworkUrl100: artwork100,
      kind: str(item.kind),
      wrapperType: str(item.wrapperType),
      primaryGenreName: str(item.primaryGenreName),
      collectionExplicitness: str(item.collectionExplicitness),
      previewUrl: str(item.previewUrl),
      country: str(item.country),
      currency: str(item.currency)
    },
    // 打分由整合方（scoring.ts）统一计算
    score: 0,
    scoreDetail: undefined
  }
}

/** 解析响应体里的 results 数组。 */
export function mapResults(data: unknown): Candidate[] {
  if (!isRecord(data)) return []
  const list = data.results
  if (!Array.isArray(list)) return []
  const out: Candidate[] = []
  for (const item of list) {
    if (!isRecord(item)) continue
    const c = mapTrack(item)
    if (c) out.push(c)
    if (out.length >= MAX_CANDIDATES) break
  }
  return out
}

/** 把失败信息翻译成给用户看的文案。 */
function statusMessage(res: FetchJsonResult): string {
  if (res.status === 0) return res.error ?? '网络请求失败'
  if (res.status === 403) return '403 访问被拒绝'
  if (res.status === 429) return '429 请求过于频繁'
  if (res.status >= 500) return `${res.status} 服务不可用`
  return res.error ?? `HTTP ${res.status}`
}

export const itunesAdapter: SourceAdapter = {
  id: 'itunes',
  name: 'iTunes',
  offlineCapable: true,

  async query(q: SourceQuery, ctx: SourceContext): Promise<SourceResult> {
    const term = buildTerm(q)
    if (!term) {
      return { candidates: [], fromCache: false, message: '缺少查询关键词' }
    }
    const page = Math.max(0, q.page ?? 0)
    const offset = page * PAGE_SIZE
    const url = buildUrl(term, offset)
    const cacheKey = `itunes:${term}:${offset}`

    const res = await fetchJson(url, { timeoutMs: TIMEOUT_MS })
    if (res.ok) {
      if (!isRecord(res.data) || !Array.isArray(res.data.results)) {
        // 响应结构异常不写缓存，避免把坏数据固化下来
        return { candidates: [], fromCache: false, message: '响应格式异常：缺少 results 字段' }
      }
      const candidates = mapResults(res.data)
      // 空结果同样缓存（中文歌搜不到是常态）
      ctx.cacheSet(cacheKey, res.data, CACHE_TTL_MS)
      return { candidates, fromCache: false }
    }

    const message = statusMessage(res)
    const cached = ctx.cacheGet(cacheKey)
    if (cached) {
      ctx.log(`[iTunes] 请求失败，回落缓存：${cacheKey}`)
      const candidates = mapResults(cached.value)
      return { candidates, fromCache: true, message: `${message}（已使用离线缓存）` }
    }
    ctx.log(`[iTunes] 请求失败且无缓存：${message}`)
    return { candidates: [], fromCache: false, message }
  }
}

export default itunesAdapter

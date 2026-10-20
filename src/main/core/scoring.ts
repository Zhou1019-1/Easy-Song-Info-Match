/**
 * 匹配打分（纯函数）。
 *
 * 综合相似度 = 标题 + 歌手 + 专辑 + 时长 + 年份 的加权和（0~100）。
 * 低于阈值的候选一律标为「待确认」，不自动写入。
 */
import type { ScoreDetail } from '@shared/types'
import { artistKey, canonicalArtist, sameArtist } from './alias'

/** 自动采纳阈值：低于此分进入「待确认」队列。 */
export const AUTO_ACCEPT_SCORE = 60
/** 高置信阈值：达到此分可在批量模式下「一键采纳」。 */
export const HIGH_CONFIDENCE_SCORE = 85

/** 去掉括号内的补充说明（remastered / live / feat. 等）用于标题比较。 */
export function stripParenthetical(s: string): string {
  return s
    .replace(/[(（[【][^)）\]】]*[)）\]】]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 比较用的归一化：去噪声、去括号补充、去 feat 后缀。 */
export function normalizeText(s: string): string {
  let out = s.normalize('NFKC').toLowerCase()
  out = out.replace(/[(（[【][^)）\]】]*[)）\]】]/g, ' ')
  out = out.replace(/\b(feat|ft|featuring|remaster(?:ed)?|live|version|edit|mix|mono|stereo|explicit|clean)\b\.?/g, ' ')
  out = out.replace(/[、,，.。!！?？:：;；'"“”‘’`~·・\-_/\\()（）[\]{}]/g, ' ')
  out = out.replace(/\s+/g, ' ').trim()
  return out
}

/** Levenshtein 距离（滚动数组）。 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  let prev = new Array<number>(b.length + 1)
  let cur = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost)
    }
    const tmp = prev
    prev = cur
    cur = tmp
  }
  return prev[b.length]
}

/** Dice 系数（字符二元组）。 */
export function diceCoefficient(a: string, b: string): number {
  if (a === b) return 1
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0
  const grams = new Map<string, number>()
  for (let i = 0; i < a.length - 1; i++) {
    const g = a.slice(i, i + 2)
    grams.set(g, (grams.get(g) ?? 0) + 1)
  }
  let hits = 0
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2)
    const c = grams.get(g)
    if (c && c > 0) {
      grams.set(g, c - 1)
      hits++
    }
  }
  return (2 * hits) / (a.length + b.length - 2)
}

/** 两个字符串的综合相似度 0~1。 */
export function similarity(a: string, b: string): number {
  const na = normalizeText(a)
  const nb = normalizeText(b)
  if (!na || !nb) return 0
  if (na === nb) return 1

  const lev = 1 - levenshtein(na, nb) / Math.max(na.length, nb.length)
  const dice = diceCoefficient(na, nb)

  let tokenScore = 0
  const ta = new Set(na.split(' ').filter(Boolean))
  const tb = new Set(nb.split(' ').filter(Boolean))
  if (ta.size && tb.size) {
    let inter = 0
    for (const t of ta) if (tb.has(t)) inter++
    tokenScore = (2 * inter) / (ta.size + tb.size)
  }

  let containment = 0
  if (na.includes(nb) || nb.includes(na)) {
    containment = 0.85
  }

  return Math.max(0, Math.min(1, lev * 0.45 + dice * 0.3 + tokenScore * 0.25), containment)
}

/** 艺人列表相似度 0~1：取「最佳配对」的平均值。 */
export function artistSimilarity(
  a: string[],
  b: string[],
  aliasIndex?: Map<string, string>
): number {
  const na = a.filter(Boolean)
  const nb = b.filter(Boolean)
  if (!na.length || !nb.length) return 0

  // 完全命中（考虑别名）
  const exactPairs: number[] = []
  for (const x of na) {
    let best = 0
    for (const y of nb) {
      if (sameArtist(x, y, aliasIndex)) {
        best = 1
        break
      }
      const s = similarity(x, y)
      if (s > best) best = s
    }
    exactPairs.push(best)
  }
  const avg = exactPairs.reduce((s, v) => s + v, 0) / exactPairs.length

  // 若一方是另一方的前缀/包含（feat. 场景），额外加分
  const keysA = new Set(na.map((x) => artistKey(canonicalArtist(x, aliasIndex))))
  const keysB = new Set(nb.map((x) => artistKey(canonicalArtist(x, aliasIndex))))
  let inter = 0
  for (const k of keysA) if (keysB.has(k)) inter++
  const setScore = keysA.size && keysB.size ? (2 * inter) / (keysA.size + keysB.size) : 0

  return Math.max(avg, setScore)
}

/** 时长相似度 0~1。 */
export function durationSimilarity(a: number | null, b: number | null): number {
  if (a == null || b == null || a <= 0 || b <= 0) return 0
  const diff = Math.abs(a - b)
  if (diff <= 2) return 1
  if (diff <= 5) return 0.85
  if (diff <= 10) return 0.6
  if (diff <= 20) return 0.3
  const rel = diff / Math.max(a, b)
  if (rel <= 0.05) return 0.4
  return 0
}

/** 年份相似度 0~1。 */
export function yearSimilarity(a: number | null, b: number | null): number {
  if (!a || !b) return 0
  const diff = Math.abs(a - b)
  if (diff === 0) return 1
  if (diff <= 1) return 0.8
  if (diff <= 3) return 0.55
  if (diff <= 6) return 0.25
  return 0
}

/** 匹配查询条件。 */
export interface MatchQuery {
  title: string
  artists: string[]
  album?: string | null
  duration?: number | null
  year?: number | null
}

/** 打分权重。 */
export const SCORE_WEIGHTS = {
  title: 0.38,
  artist: 0.34,
  album: 0.12,
  duration: 0.12,
  year: 0.04
}

/**
 * 能区分「不同录音版本」的限定词。
 *
 * 刻意不包含 remastered / explicit / clean 这类只描述同一录音的修饰词——
 * 它们不该影响匹配；live / remix 这类则代表另一份录音，必须区分开。
 */
const VERSION_QUALIFIERS = new Set([
  'live',
  'remix',
  'remixed',
  'bootleg',
  'mix',
  'edit',
  'radio',
  'extended',
  'instrumental',
  'acoustic',
  'demo',
  'unplugged',
  'reprise',
  '现场',
  '现场版',
  '伴奏',
  '伴奏版',
  '混音',
  '混音版',
  '钢琴版',
  '版'
])

/** 一方带版本限定词、另一方不带时的标题折扣系数。 */
const VERSION_MISMATCH_FACTOR = 0.65

/** 双方都带限定词但内容不同（如现场版 vs 混音版）时的标题折扣系数。 */
const VERSION_CONFLICT_FACTOR = 0.55

/**
 * 提取标题里的版本限定词。
 * 同时看括号内容与独立成词的限定词（中文没有空格分隔，所以还要单独扫一遍原文）。
 */
export function versionQualifiers(title: string): string[] {
  if (!title) return []
  const found = new Set<string>()
  const push = (raw: string): void => {
    const token = raw.trim().toLowerCase()
    if (VERSION_QUALIFIERS.has(token)) found.add(token)
  }
  // 括号内容
  for (const m of title.matchAll(/[(（[【]([^)）\]】]*)[)）\]】]/g)) {
    for (const token of m[1].split(/[\s,，、/&+·\-_]+/)) push(token)
  }
  // 括号外的独立词
  const flat = title.replace(/[(（[【][^)）\]】]*[)）\]】]/g, ' ')
  for (const token of flat.split(/[\s,，、/&+·\-_]+/)) push(token)
  return [...found]
}

/**
 * 版本限定词折扣。
 *
 * 两侧限定词一致（含两侧都没有）→ 不折扣；
 * 只有一侧有 → 视为不同录音，折扣；
 * 两侧都有但不同 → 视为不同版本，折扣更狠。
 */
export function applyVersionPenalty(base: number, queryQualifiers: string[], candidateQualifiers: string[]): number {
  const q = new Set(queryQualifiers)
  const c = new Set(candidateQualifiers)
  if (!q.size && !c.size) return base
  if (q.size === c.size && [...q].every((x) => c.has(x))) return base
  if (!q.size || !c.size) return base * VERSION_MISMATCH_FACTOR
  return base * VERSION_CONFLICT_FACTOR
}

/** 对一个候选打分，返回 0~100 与明细。 */
export function scoreCandidate(query: MatchQuery, candidate: {
  title: string
  artists: string[]
  album?: string | null
  duration?: number | null
  year?: number | null
}, aliasIndex?: Map<string, string>): ScoreDetail {
  const title = applyVersionPenalty(
    similarity(query.title, candidate.title),
    versionQualifiers(query.title),
    versionQualifiers(candidate.title)
  )
  const artist = artistSimilarity(query.artists, candidate.artists, aliasIndex)
  const album = query.album && candidate.album ? similarity(query.album, candidate.album) : 0
  const duration = durationSimilarity(query.duration ?? null, candidate.duration ?? null)
  const year = yearSimilarity(query.year ?? null, candidate.year ?? null)

  const total =
    title * SCORE_WEIGHTS.title +
    artist * SCORE_WEIGHTS.artist +
    album * SCORE_WEIGHTS.album +
    duration * SCORE_WEIGHTS.duration +
    year * SCORE_WEIGHTS.year

  return {
    title: Math.round(title * 100),
    artist: Math.round(artist * 100),
    album: Math.round(album * 100),
    duration: Math.round(duration * 100),
    year: Math.round(year * 100),
    total: Math.round(total * 100)
  }
}

/** 标题相似度校验（防止歌词下错歌）。 */
export function titleGuard(title: string, expected: string): boolean {
  return similarity(title, expected) >= 0.55
}

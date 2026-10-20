/** 展示层的格式化与文本比较工具（纯函数）。 */
import type { LyricState, MatchState } from '@shared/types'

export const MATCH_STATE_LABELS: Record<MatchState, string> = {
  none: '未匹配',
  pending: '待确认',
  matched: '已匹配',
  rejected: '已否决',
  manual: '手动'
}

export const LYRIC_STATE_LABELS: Record<LyricState, string> = {
  none: '无歌词',
  embedded: '内嵌',
  'lrc-file': 'LRC 文件',
  both: '内嵌 + LRC',
  'plain-text': '纯文本',
  pending: '待补齐'
}

export const ADVISORY_LABELS: Record<string, string> = {
  none: 'None',
  clean: 'Clean',
  explicit: 'Explicit'
}

export function formatDuration(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return ''
  const total = Math.max(0, Math.round(sec))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

export function formatDateTime(ts: number | null | undefined): string {
  if (!ts) return ''
  const d = new Date(ts)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function joinValues(values: string[] | undefined | null): string {
  return (values ?? []).filter(Boolean).join(' / ')
}

export function truncate(s: string, max: number): string {
  if (!s) return ''
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/** 比较用的归一化：去括号补充、去 feat 后缀、去标点。 */
export function normalizeText(s: string): string {
  let out = (s ?? '').normalize('NFKC').toLowerCase()
  out = out.replace(/[(（[【][^)）\]】]*[)）\]】]/g, ' ')
  out = out.replace(/\b(feat|ft|featuring|remaster(?:ed)?|live|version|edit|mix|mono|stereo|explicit|clean)\b\.?/g, ' ')
  out = out.replace(/[、,，.。!！?？:：;；'"“”‘’`~·・\-_/\\()（）[\]{}]/g, ' ')
  return out.replace(/\s+/g, ' ').trim()
}

/** Levenshtein 距离。 */
function levenshtein(a: string, b: string): number {
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
function diceCoefficient(a: string, b: string): number {
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

/** 字符串相似度 0~1（用于歌词标题校验等）。 */
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
  if (na.includes(nb) || nb.includes(na)) containment = 0.85
  return Math.max(0, Math.min(1, lev * 0.45 + dice * 0.3 + tokenScore * 0.25), containment)
}

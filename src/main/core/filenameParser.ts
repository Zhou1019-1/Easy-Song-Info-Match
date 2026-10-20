/**
 * 文件名 / 文件夹名解析（纯函数，便于单元测试）。
 *
 * 支持的命名模式：
 *   1. `歌名 - 歌手`
 *   2. `歌手 - 歌名`
 *   3. `01. 歌手 - 歌名`
 *   4. `N-NN 歌名`            （N-NN 视作 总音轨数-音轨号）
 *   5. `歌名 - 歌手-专辑-来源后缀`（如 `-tx-flac`、`_DSD64`）
 *   6. 仅标题 `歌名`
 *
 * 解析结果带置信度；拿不准的进「待确认」，不编造。
 */
import type { FilenameParseResult, FolderContext } from '@shared/types'

/** 已知来源/音质后缀 token（小写比较）。 */
const SOURCE_TOKENS = new Set([
  'tx', 'kw', 'kg', 'wy', 'mg', 'qq', '163', 'netease', 'xiami', 'qishui',
  'kuwo', 'kugou', 'migu', 'qqmusic', 'apple', 'itunes',
  'flac', 'ape', 'wav', 'mp3', 'm4a', 'dsf', 'dff', 'aiff',
  '320k', '128k', 'flac24', 'flac24bit', 'hires', 'hi-res', 'dsd', 'dolby', 'atmos',
  'remaster', 'remastered', 'explicit', 'official', 'mv', '1080p'
])

/** 强分隔符：两侧都有空白。 */
const STRONG_SEP = /\s+[-–—]\s+/
/** 弱分隔符：连字符/下划线，不要求空白。 */
const LOOSE_SEP = /[-–—]/

export interface ParseContext {
  /** 父文件夹名 */
  folderName?: string
  /** 祖父文件夹名 */
  parentFolderName?: string
  /** 已知歌手（来自标签等更高优先级的来源） */
  knownArtist?: string | null
  /** 已知专辑 */
  knownAlbum?: string | null
}

/** 去掉扩展名。 */
function stripExt(filename: string): string {
  const i = filename.lastIndexOf('.')
  return i > 0 ? filename.slice(0, i) : filename
}

/**
 * 识别并剥离结尾的来源/音质后缀，例如 `-tx-flac`、`_DSD64`、`-320k`。
 * 返回剥离后的主体与识别到的后缀。
 */
export function stripSourceSuffix(base: string): { body: string; hint: string | null } {
  const m = base.match(/[-_]([A-Za-z0-9]+(?:[-_][A-Za-z0-9]+){0,2})$/)
  if (!m) return { body: base, hint: null }
  const tokens = m[1].split(/[-_]/).filter(Boolean)
  if (!tokens.length) return { body: base, hint: null }
  const known = tokens.filter((t) => SOURCE_TOKENS.has(t.toLowerCase()) || /^dsd\d*$/i.test(t))
  if (!known.length) return { body: base, hint: null }
  // 只有当尾部整段都像来源 token 时才剥离，避免误伤 "Hello-World"
  if (known.length < tokens.length && tokens.length > 1) {
    // 允许尾部是 "flac24bit 之类" 但前面有未知词 -> 只在未知词也短时剥离
    const unknown = tokens.filter((t) => !SOURCE_TOKENS.has(t.toLowerCase()) && !/^dsd\d*$/i.test(t))
    if (unknown.some((u) => u.length > 4)) return { body: base, hint: null }
  }
  return { body: base.slice(0, m.index), hint: m[1] }
}

/** 提取开头音轨号。支持 `01.` `01 ` `01-` 与 `N-NN `。 */
export function extractTrackNumber(
  base: string
): { body: string; track: number | null; totalTracks: number | null; reason?: string } {
  // N-NN 形式
  const dash = base.match(/^(\d{1,2})-(\d{1,3})[\s._]+/)
  if (dash) {
    const total = Number(dash[1])
    const track = Number(dash[2])
    if (total > 0 && track > 0) {
      return {
        body: base.slice(dash[0].length).trim(),
        track,
        totalTracks: total,
        reason: `音轨号模式 N-NN：总 ${total} / 第 ${track}`
      }
    }
  }
  // 常见模式 01. / 01 / 01- / 01_
  const simple = base.match(/^(\d{1,3})(?=[.\s\-_])/)
  if (simple) {
    const n = Number(simple[1])
    if (n > 0) {
      const rest = base.slice(simple[0].length).replace(/^[.\s\-_]+/, '').trim()
      if (rest) {
        return { body: rest, track: n, totalTracks: null, reason: `音轨号 ${n}` }
      }
    }
  }
  return { body: base, track: null, totalTracks: null }
}

/** 拆分：优先强分隔符，其次弱分隔符。 */
function splitParts(s: string): { parts: string[]; separator: 'strong' | 'loose' | 'none' } {
  const strong = s.split(STRONG_SEP).map((p) => p.trim()).filter(Boolean)
  if (strong.length >= 2) return { parts: strong, separator: 'strong' }
  if (strong.length === 1 && /[-–—]/.test(strong[0])) {
    const loose = strong[0].split(LOOSE_SEP).map((p) => p.trim()).filter(Boolean)
    if (loose.length >= 2) return { parts: loose, separator: 'loose' }
  }
  if (strong.length === 1 && /_/.test(strong[0])) {
    const us = strong[0].split('_').map((p) => p.trim()).filter(Boolean)
    if (us.length >= 2) return { parts: us, separator: 'loose' }
  }
  return { parts: strong, separator: 'none' }
}

/** 归一化用于比较的字符串。 */
export function normalizeName(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[「」『』《》【】\[\]()（）]/g, '')
    .replace(/[\s._·・,，、'"“”‘’]/g, '')
    .trim()
}

/** 判断字符串是否包含艺人特征。 */
export function artistLikeness(s: string): number {
  let score = 0
  if (/\b(feat|ft|featuring)\b\.?/i.test(s)) score += 3
  if (/[&、,，]| x | and | with /i.test(s)) score += 2
  if (/(band|组合|乐队|orchestra|orchestre|group|choir|quartet|ensemble)$/i.test(s.trim())) score += 2
  if (s.length <= 24) score += 1
  if (!/[（(【\[]/.test(s)) score += 1
  return score
}

/** 判断字符串是否包含标题特征。 */
export function titleLikeness(s: string): number {
  let score = 0
  if (/[（(【\[]/.test(s)) score += 3
  if (s.length > 30) score += 2
  if (/(remaster|live|version|edit|mix|instrumental|demo|bonus|伴奏|现场|版)/i.test(s)) score += 2
  if (/\d{4}/.test(s)) score += 1
  return score
}

/**
 * 在两个片段间判断哪个是歌手、哪个是标题。
 * 无法判定时返回 confidence='low'，交由用户确认。
 */
export function disambiguateArtistTitle(
  a: string,
  b: string,
  ctx: ParseContext = {}
): { title: string; artist: string | null; confidence: 'high' | 'medium' | 'low'; reasons: string[] } {
  const reasons: string[] = []
  const na = normalizeName(a)
  const nb = normalizeName(b)

  const known = ctx.knownArtist ? normalizeName(ctx.knownArtist) : ''
  if (known) {
    if (na === known) {
      reasons.push(`与已知歌手「${ctx.knownArtist}」一致`)
      return { title: b, artist: a, confidence: 'high', reasons }
    }
    if (nb === known) {
      reasons.push(`与已知歌手「${ctx.knownArtist}」一致`)
      return { title: a, artist: b, confidence: 'high', reasons }
    }
  }

  const as = artistLikeness(a)
  const bs = artistLikeness(b)
  const at = titleLikeness(a)
  const bt = titleLikeness(b)
  const aScore = as - at
  const bScore = bs - bt

  if (aScore !== bScore) {
    const artistIsA = aScore > bScore
    const artist = artistIsA ? a : b
    const title = artistIsA ? b : a
    const margin = Math.abs(aScore - bScore)
    reasons.push(
      `启发式判定（艺人特征分 ${as}/${bs}，标题特征分 ${at}/${bt}）`
    )
    return {
      title,
      artist,
      confidence: margin >= 3 ? 'medium' : 'low',
      reasons
    }
  }

  // 完全打平：按「歌手 - 歌名」这一更常见的下载命名习惯兜底，但仍标为低置信度
  reasons.push('无法区分歌手/标题，按常见命名「歌手 - 歌名」兜底，待人工确认')
  return { title: b, artist: a, confidence: 'low', reasons }
}

/** 解析文件夹名，得到艺人/专辑/年份上下文。 */
export function parseFolderContext(folderName: string): FolderContext | null {
  if (!folderName) return null
  const name = folderName.trim()
  if (!name) return null

  // 「XXX代表专辑」
  const rep = name.match(/^(.{1,40})代表专辑$/)
  if (rep) {
    return {
      artist: null,
      album: rep[1].trim() || null,
      year: null,
      prefix: rep[1].trim() || null,
      confidence: 'medium'
    }
  }

  let year: number | null = null
  let rest = name
  const yearMatch = rest.match(/[\[(（\[【]?\s*((?:19|20)\d{2})\s*[\])）\]】]?\s*$/)
  if (yearMatch) {
    year = Number(yearMatch[1])
    rest = rest.slice(0, yearMatch.index).trim()
  }

  // 「歌手 - 专辑」/「歌手 - 专辑」/「歌手_专辑」
  const dash = rest.split(/\s+[-–—]\s+/)
  if (dash.length === 2 && dash[0] && dash[1]) {
    return {
      artist: dash[0].trim(),
      album: dash[1].trim(),
      year,
      prefix: null,
      confidence: 'high'
    }
  }
  const under = rest.split('_')
  if (under.length === 2 && under[0] && under[1]) {
    return {
      artist: under[0].trim(),
      album: under[1].trim(),
      year,
      prefix: null,
      confidence: 'medium'
    }
  }
  if (dash.length === 1 && under.length === 1 && rest) {
    // 只有一个名字：可能是专辑名
    return { artist: null, album: rest, year, prefix: null, confidence: 'low' }
  }
  return { artist: null, album: rest || null, year, prefix: null, confidence: 'low' }
}

/**
 * 主入口：解析文件名。
 */
export function parseFilename(
  filename: string,
  ext: string,
  ctx: ParseContext = {}
): FilenameParseResult {
  const reasons: string[] = []
  if (!ext) reasons.push('文件没有扩展名，按纯标题处理')
  let base = stripExt(filename)

  // 1. 剥离来源后缀
  const { body: noHint, hint } = stripSourceSuffix(base)
  if (hint) {
    reasons.push(`识别到来源/音质后缀「${hint}」`)
    base = noHint.trim()
  }

  // 2. 提取音轨号
  const track = extractTrackNumber(base)
  base = track.body.trim()
  if (track.reason) reasons.push(track.reason)

  // 3. 拆分主体
  const { parts, separator } = splitParts(base)
  const folderCtx = ctx.folderName ? parseFolderContext(ctx.folderName) : null
  const folderArtist = folderCtx?.artist ?? null

  let title = ''
  let artist: string | null = null
  let album: string | null = null
  let artistSource: 'filename' | 'folder' | null = null
  let albumSource: 'filename' | 'folder' | null = null
  let confidence: FilenameParseResult['confidence'] = 'low'

  if (parts.length >= 3) {
    // 形如 `歌名 - 歌手 - 专辑` 或 `歌手 - 歌名 - 专辑`
    const [p1, p2, p3] = parts
    const d = disambiguateArtistTitle(p1, p2, { ...ctx, knownArtist: ctx.knownArtist ?? folderArtist })
    title = d.title
    artist = d.artist
    artistSource = d.artist ? 'filename' : null
    album = p3
    albumSource = 'filename'
    confidence = d.confidence === 'high' ? 'high' : 'medium'
    reasons.push(`三段式解析：${separator} 分隔`, ...d.reasons)
  } else if (parts.length === 2) {
    let [p1, p2] = parts
    // 第二段可能还带 `-专辑`
    let extraAlbum: string | null = null
    if (LOOSE_SEP.test(p2) && !STRONG_SEP.test(p2)) {
      const sub = p2.split(LOOSE_SEP).map((s) => s.trim()).filter(Boolean)
      if (sub.length >= 2) {
        extraAlbum = sub.slice(1).join(' - ')
        p2 = sub[0]
      }
    }
    const d = disambiguateArtistTitle(p1, p2, { ...ctx, knownArtist: ctx.knownArtist ?? folderArtist })
    title = d.title
    artist = d.artist
    artistSource = d.artist ? 'filename' : null
    album = extraAlbum
    albumSource = extraAlbum ? 'filename' : null
    confidence = d.confidence
    reasons.push(`两段式解析（${separator} 分隔）`, ...d.reasons)
  } else {
    title = base
    if (folderArtist) {
      artist = folderArtist
      artistSource = 'folder'
      confidence = 'medium'
      reasons.push(`仅标题，从文件夹继承歌手「${folderArtist}」`)
    } else {
      confidence = 'low'
      reasons.push('仅有标题片段')
    }
  }

  // 4. 文件夹上下文补齐专辑
  if (!album && folderCtx?.album) {
    album = folderCtx.album
    albumSource = 'folder'
    if (confidence === 'low') confidence = 'medium'
    reasons.push(`专辑取自文件夹「${folderCtx.album}」`)
  }

  return {
    title: title.trim(),
    artist: artist ? artist.trim() || null : null,
    album: album ? album.trim() || null : null,
    trackNumber: track.track,
    sourceHint: hint,
    confidence,
    reasons,
    artistSource,
    albumSource
  }
}

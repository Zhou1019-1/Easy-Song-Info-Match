/**
 * 艺人别名归一 + 多歌手分隔符处理（纯函数）。
 *
 * 关键约束：`AC/DC`、`K/DA`、`Fujiya & Miyagi` 这类艺名禁止被拆开。
 * 分隔符优先级：`;` `、` > `,` > `&` > `feat.`。
 */

/** 一条别名规则：from（写法）-> to（规范名）。 */
export interface AliasRule {
  from: string
  to: string
  note?: string
}

/**
 * 内置别名种子。用户的映射表在 SQLite 中维护并可导入导出，
 * 此处只提供出厂默认值。
 */
export const DEFAULT_ALIAS_RULES: AliasRule[] = [
  { from: '老鹰', to: 'Eagles', note: '乐队别称' },
  { from: 'The Eagles', to: 'Eagles' },
  { from: '松原みき', to: '松原美纪', note: '日文/中文写法统一' },
  { from: '松原美紀', to: '松原美纪' },
  { from: "Fool's Garden", to: 'Fools Garden' },
  { from: 'Fools Garden', to: 'Fools Garden' },
  { from: '披头士', to: 'The Beatles' },
  { from: '甲壳虫乐队', to: 'The Beatles' },
  { from: '滚石乐队', to: 'The Rolling Stones' },
  { from: '小甜甜', to: '布兰妮·斯皮尔斯' },
  { from: 'MJ', to: 'Michael Jackson', note: '常见缩写' },
  { from: '泰勒', to: 'Taylor Swift' },
  { from: '霉霉', to: 'Taylor Swift' },
  { from: '薛之谦', to: '薛之谦' },
  { from: '周杰倫', to: '周杰伦', note: '繁简统一' },
  { from: '周傑倫', to: '周杰伦' },
  { from: '陳奕迅', to: '陈奕迅' },
  { from: '陳慧嫻', to: '陈慧娴' },
  { from: '王菲', to: '王菲' },
  { from: '林俊傑', to: '林俊杰' },
  { from: '五月天', to: '五月天' },
  { from: '羽泉', to: '羽泉' },
  { from: '花粥', to: '花粥' }
]

/**
 * 禁止拆分的艺名（保护名单）。整串匹配，匹配成功则完全不拆。
 * 用户可在设置中追加。
 */
export const DEFAULT_PROTECTED_ARTISTS: string[] = [
  'AC/DC',
  'K/DA',
  'Fujiya & Miyagi',
  'Simon & Garfunkel',
  'Earth, Wind & Fire',
  'Crosby, Stills, Nash & Young',
  'Crosby, Stills & Nash',
  'Hall & Oates',
  'Mumford & Sons',
  'Huey Lewis & the News',
  'Brooks & Dunn',
  'Peter, Paul and Mary',
  'Guns N’ Roses',
  'Guns N\' Roses',
  'P!nk',
  'Lil’ Kim',
  "Lil' Kim",
  'Sade',
  'S.H.E',
  'F.I.R',
  'Young Thug',
  'B.o.B',
  'H.E.R.',
  'M.I.A.',
  'D.E.Y.'
]

/** 归一化：用于比较的键。 */
export function artistKey(name: string): string {
  return name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/['‘’ʼ`]/g, '')
    .replace(/[·・･]/g, ' ')
    .replace(/[「」『』《》【】]/g, '')
    .replace(/[.,!?;:"“”]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 展示用归一化：折叠空白、去掉首尾噪声，但保留原始文字。 */
export function tidyArtistName(name: string): string {
  return name
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—_·]+|[\s\-–—_·]+$/g, '')
    .trim()
}

/** 构造别名索引：from 的 key -> 规范名。 */
export function buildAliasIndex(rules: AliasRule[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const rule of rules) {
    const from = tidyArtistName(rule.from)
    const to = tidyArtistName(rule.to)
    if (!from || !to) continue
    map.set(artistKey(from), to)
  }
  return map
}

/**
 * 取得规范名：命中别名表则返回规范名，否则返回清洗后的原名。
 */
export function canonicalArtist(name: string, aliasIndex?: Map<string, string>): string {
  const tidy = tidyArtistName(name)
  if (!tidy) return ''
  if (!aliasIndex) return tidy
  const hit = aliasIndex.get(artistKey(tidy))
  return hit ?? tidy
}

/** 分隔符优先级表。 */
const SEPARATOR_TIERS: Array<{ label: string; re: RegExp; split: (s: string) => string[] }> = [
  {
    label: '分号/顿号',
    re: /[;；、]/,
    split: (s) => s.split(/[;；、]/)
  },
  {
    label: '逗号',
    re: /[,，]/,
    split: (s) => s.split(/[,，]/)
  },
  {
    label: '连接符 &',
    re: /[&＆]/,
    split: (s) => s.split(/[&＆]/)
  },
  {
    label: 'feat./ft./with',
    re: /\s(?:feat\.?|ft\.?|featuring|with|vs\.?)\s/i,
    split: (s) => s.split(/\s(?:feat\.?|ft\.?|featuring|with|vs\.?)\s/i)
  }
]

/**
 * 拆分多歌手。
 * @param value 原始字符串
 * @param protectedNames 保护名单（整串匹配）
 * @param aliasIndex 别名表，用于把拆分后的片段规范化
 */
export function splitArtists(
  value: string,
  protectedNames: string[] = DEFAULT_PROTECTED_ARTISTS,
  aliasIndex?: Map<string, string>
): string[] {
  const raw = value.trim()
  if (!raw) return []

  const protectedKeys = new Set(protectedNames.map((n) => artistKey(n)))
  if (protectedKeys.has(artistKey(raw))) return [canonicalArtist(raw, aliasIndex)]

  return splitByTier(raw, 0, protectedKeys, aliasIndex)
}

function splitByTier(
  value: string,
  tier: number,
  protectedKeys: Set<string>,
  aliasIndex?: Map<string, string>
): string[] {
  if (tier >= SEPARATOR_TIERS.length) {
    const one = canonicalArtist(value, aliasIndex)
    return one ? [one] : []
  }
  const t = SEPARATOR_TIERS[tier]
  if (!t.re.test(value)) return splitByTier(value, tier + 1, protectedKeys, aliasIndex)

  const segments = t
    .split(value)
    .map((s) => s.trim())
    .filter(Boolean)

  // 保护名单内的片段不继续拆分
  const result: string[] = []
  for (const seg of segments) {
    if (protectedKeys.has(artistKey(seg))) {
      result.push(canonicalArtist(seg, aliasIndex))
      continue
    }
    result.push(...splitByTier(seg, tier + 1, protectedKeys, aliasIndex))
  }
  return result.filter(Boolean)
}

/**
 * 合并多个来源的艺人列表：按 artistKey 归组，组内取出现次数最多的写法，
 * 再套用别名表得到规范名。
 */
export function mergeArtistLists(
  lists: string[][],
  aliasIndex?: Map<string, string>
): string[] {
  const counts = new Map<string, { display: Map<string, number>; total: number }>()
  for (const list of lists) {
    for (const raw of list) {
      const tidy = tidyArtistName(raw)
      if (!tidy) continue
      // 先套别名再归组：「老鹰」与「Eagles」必须落在同一组里
      const canon = canonicalArtist(tidy, aliasIndex)
      const key = artistKey(canon)
      if (!key) continue
      let bucket = counts.get(key)
      if (!bucket) {
        bucket = { display: new Map(), total: 0 }
        counts.set(key, bucket)
      }
      bucket.total++
      bucket.display.set(tidy, (bucket.display.get(tidy) ?? 0) + 1)
    }
  }
  const out: string[] = []
  for (const bucket of counts.values()) {
    let best = ''
    let bestN = -1
    for (const [display, n] of bucket.display) {
      if (n > bestN || (n === bestN && display.length < best.length)) {
        best = display
        bestN = n
      }
    }
    out.push(canonicalArtist(best, aliasIndex))
  }
  return out
}

/**
 * 判断两个艺人名是否指同一人（考虑别名表）。
 */
export function sameArtist(a: string, b: string, aliasIndex?: Map<string, string>): boolean {
  const ca = canonicalArtist(a, aliasIndex)
  const cb = canonicalArtist(b, aliasIndex)
  if (!ca || !cb) return false
  if (artistKey(ca) === artistKey(cb)) return true
  if (!aliasIndex) return false
  const ka = aliasIndex.get(artistKey(ca))
  const kb = aliasIndex.get(artistKey(cb))
  if (ka && kb && artistKey(ka) === artistKey(kb)) return true
  return false
}

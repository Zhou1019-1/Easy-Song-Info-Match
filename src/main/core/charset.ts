/**
 * 字符集修复：GBK ↔ UTF-8 乱码识别还原，以及文件名字符清洗。
 *
 * 典型症状：UTF-8 字节被按 GBK/Latin-1 解读，或 GBK 字节被按 UTF-8 解读。
 * 修复思路：把文本重新编码回字节，再按另一种编码解码，用两种证据择优：
 *   1) 强证据（oracle）：重新编码得到的字节是**严格合法的 UTF-8**；
 *   2) 普通证据：解码结果的自然语言分值明显高于原文。
 * 证据不足时一律保持原样（宁缺毋滥）。
 */
import iconv from 'iconv-lite'

/** Windows 非法文件名字符 + 控制字符。 */
const ILLEGAL_FILENAME_CHARS = /[<>:"/\\|?*\x00-\x1f]/g

/** Windows 保留设备名。 */
const RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
])

/** CP1252 中 0x80~0x9F 与 Unicode 的映射（latin1 无法表示的部分）。 */
const CP1252_HIGH: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85,
  0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a,
  0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92,
  0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c,
  0x017e: 0x9e, 0x0178: 0x9f
}

function isCjk(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 统一表意
    (cp >= 0x3400 && cp <= 0x4dbf) || // 扩展 A
    (cp >= 0xf900 && cp <= 0xfaff) || // 兼容表意
    (cp >= 0x3000 && cp <= 0x303f) || // CJK 标点
    (cp >= 0xff01 && cp <= 0xff60) || // 全角形式
    (cp >= 0xffe0 && cp <= 0xffee)
  )
}

function isKana(cp: number): boolean {
  return (
    (cp >= 0x3040 && cp <= 0x309f) || // 平假名
    (cp >= 0x30a0 && cp <= 0x30ff) || // 片假名
    (cp >= 0x31f0 && cp <= 0x31ff) ||
    (cp >= 0xff61 && cp <= 0xff9f) // 半角片假名（真实文本里罕见，只给很低的分）
  )
}

/** 半角片假名：几乎只出现在乱码里，绝不该当成正常日文。 */
function isHalfWidthKana(cp: number): boolean {
  return cp >= 0xff61 && cp <= 0xff9f
}

function isHangul(cp: number): boolean {
  return (cp >= 0xac00 && cp <= 0xd7af) || (cp >= 0x1100 && cp <= 0x11ff)
}

/**
 * 给一段文本打分：CJK/假名越多越好，出现替换字符/控制字符则重罚。
 * 分值只用于「同一片段不同解码策略之间」横向比较。
 */
export function scoreText(s: string): number {
  let score = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0)!
    if (cp === 0xfffd) score -= 12 // U+FFFD 替换字符：解码失败
    else if (cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) score -= 8
    else if (cp < 0x80) score += 0.5
    else if (isHalfWidthKana(cp)) score += 0.5 // 半角片假名：乱码特征，强惩罚
    else if (isCjk(cp)) score += 4
    else if (isKana(cp)) score += 3
    else if (isHangul(cp)) score += 3
    else if (cp >= 0x00a0 && cp <= 0x024f) score += 0.2 // 拉丁扩展/重音字母
    else score += 0.1
  }
  return score
}

/** 把字符串按 CP1252 还原成字节；无法表示时返回 null。 */
function encodeCp1252(s: string): Buffer | null {
  const bytes: number[] = []
  for (const ch of s) {
    const cp = ch.codePointAt(0)!
    if (cp <= 0xff) bytes.push(cp)
    else if (CP1252_HIGH[cp] !== undefined) bytes.push(CP1252_HIGH[cp])
    else return null
  }
  return Buffer.from(bytes)
}

/** CP1252 高位区的反向映射（字节 -> Unicode）。 */
const CP1252_REVERSE: Record<number, number> = Object.fromEntries(
  Object.entries(CP1252_HIGH).map(([cp, byte]) => [byte, Number(cp)])
)

/** CP1252 解码。 */
function decodeCp1252(buf: Buffer): string {
  let out = ''
  for (const b of buf) {
    const hi = CP1252_REVERSE[b]
    out += hi !== undefined ? String.fromCodePoint(hi) : String.fromCharCode(b)
  }
  return out
}

/** 按 Latin-1 还原成字节；出现 > 0xFF 的字符时返回 null（避免截断丢信息）。 */
function encodeLatin1(s: string): Buffer | null {
  for (const ch of s) {
    if (ch.codePointAt(0)! > 0xff) return null
  }
  return Buffer.from(s, 'latin1')
}

/** 一个编解码器。 */
interface Codec {
  encode: (s: string) => Buffer | null
  decode: (buf: Buffer) => string
}

const CODECS: Record<string, Codec> = {
  utf8: { encode: (s) => Buffer.from(s, 'utf8'), decode: (b) => b.toString('utf8') },
  latin1: { encode: encodeLatin1, decode: (b) => b.toString('latin1') },
  cp1252: { encode: encodeCp1252, decode: decodeCp1252 },
  gbk: { encode: (s) => iconv.encode(s, 'gbk'), decode: (b) => iconv.decode(b, 'gbk') },
  big5: { encode: (s) => iconv.encode(s, 'big5'), decode: (b) => iconv.decode(b, 'big5') },
  shift_jis: {
    encode: (s) => iconv.encode(s, 'shift_jis'),
    decode: (b) => iconv.decode(b, 'shift_jis')
  }
}

/** 可以作为「重新编码」方向：把乱码文本变回原始字节。 */
const ENCODER_ORDER = ['cp1252', 'latin1', 'gbk']
/** 可以作为「解码」方向。 */
const DECODER_ORDER = ['utf8', 'gbk', 'big5', 'shift_jis']

/** 严格 UTF-8 校验：字节序列必须是合法且可无损还原的 UTF-8。 */
function isStrictUtf8(buf: Buffer): boolean {
  const s = buf.toString('utf8')
  if (s.includes('�')) return false
  return Buffer.compare(Buffer.from(s, 'utf8'), buf) === 0
}

/** 「拉丁 1 区高位字符」数量：正常中文/日文里为 0，是乱码的典型特征。 */
function markerCount(s: string): number {
  let n = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0)!
    if (cp >= 0x80 && cp <= 0xff) n++
  }
  return n
}

/** 是否含中日韩文字。 */
function hasCjkOrKana(s: string): boolean {
  for (const ch of s) {
    const cp = ch.codePointAt(0)!
    if (isCjk(cp) || isKana(cp) || isHangul(cp)) return true
  }
  return false
}

interface Candidate {
  decoded: string
  strategy: string
  /** 自然语言分值（越高越像正常文本） */
  natural: number
  /** 「拉丁 1 区高位字符」数量 */
  markers: number
  /** 是否是「字节严格合法 UTF-8」这种强证据 */
  oracle: boolean
}

/**
 * 枚举所有可能的解码方向。
 * 关键约束：编码与解码两侧都必须无损，否则「还原」出来的只是另一串乱码。
 */
function collectCandidates(text: string): Candidate[] {
  const out: Candidate[] = []
  for (const encName of ENCODER_ORDER) {
    const enc = CODECS[encName]
    let bytes: Buffer | null
    try {
      bytes = enc.encode(text)
    } catch {
      continue
    }
    if (!bytes || bytes.length === 0) continue
    // 编码方向必须无损：解回来要等于原文，否则这一步已经丢信息
    let roundTrip: string
    try {
      roundTrip = enc.decode(bytes)
    } catch {
      continue
    }
    if (roundTrip !== text) continue

    for (const decName of DECODER_ORDER) {
      const dec = CODECS[decName]
      let decoded: string
      try {
        decoded = dec.decode(bytes)
      } catch {
        continue
      }
      if (decoded === text) continue
      if (decoded.includes('�')) continue

      const oracle = decName === 'utf8' && isStrictUtf8(bytes)
      if (!oracle) {
        // 解码也必须无损，否则说明这串字节本来就不是该编码
        let back: Buffer | null
        try {
          back = dec.encode(decoded)
        } catch {
          continue
        }
        if (!back || Buffer.compare(back, bytes) !== 0) continue
      }
      out.push({
        decoded,
        strategy: `${encName}→${decName}`,
        natural: scoreText(decoded),
        markers: markerCount(decoded),
        oracle
      })
    }
  }
  return out
}

/** 判定某个候选是否可以采纳（宁缺毋滥：证据不足就保持原样）。 */
function isAcceptable(c: Candidate, text: string, base: number, baseMarkers: number): boolean {
  if (c.oracle) {
    // 强证据：字节是合法 UTF-8。仍要求结果比原文更「像」正常文本
    const shorter = c.decoded.length < text.length
    if (hasCjkOrKana(c.decoded)) return shorter || c.markers < baseMarkers
    return c.markers < baseMarkers
  }
  // 普通证据：自然语言分值必须明显提升
  return c.natural > base + 2
}

/** 在一段文本里找出最佳修复结果。 */
function findBestRepair(text: string): { text: string; changed: boolean; strategy?: string } {
  if (!text) return { text, changed: false }
  const base = scoreText(text)
  const baseMarkers = markerCount(text)
  const candidates = collectCandidates(text)
  let best: Candidate | null = null
  for (const c of candidates) {
    if (!isAcceptable(c, text, base, baseMarkers)) continue
    if (!best) {
      best = c
      continue
    }
    // 强证据优先，其次比自然分值
    if (c.oracle !== best.oracle) {
      if (c.oracle) best = c
      continue
    }
    if (c.natural > best.natural) best = c
  }
  if (!best) return { text, changed: false }
  return { text: best.decoded, changed: true, strategy: best.strategy }
}

/**
 * 尝试修复一段文本中的乱码。
 * 先尝试整串（乱码常常横跨多个片段），失败再按「非 ASCII 连续片段」逐段处理。
 */
export function repairMojibake(input: string): { text: string; changed: boolean; strategy?: string } {
  if (!input) return { text: input, changed: false }

  const whole = findBestRepair(input)
  if (whole.changed) return whole

  const parts = input.split(/([^\x00-\x7f]+)/)
  let changed = false
  let strategy: string | undefined
  const out = parts.map((part) => {
    if (!part) return part
    const fixed = findBestRepair(part)
    if (fixed.changed) {
      changed = true
      strategy = strategy ?? fixed.strategy
    }
    return fixed.text
  })
  return { text: out.join(''), changed, strategy }
}

/** 检测文本是否为疑似乱码（不修改）。 */
export function isMojibake(input: string): boolean {
  return repairMojibake(input).changed
}

/**
 * 清洗文件名字符：
 * - 替换 Windows 非法字符
 * - 去掉首尾空格与结尾的点
 * - 规避保留设备名
 */
export function sanitizeFilename(name: string, replacement = '_'): string {
  let out = name.replace(ILLEGAL_FILENAME_CHARS, replacement)
  out = out.replace(/[. ]+$/, '')
  out = out.trim()
  if (!out) out = 'unnamed'
  const stem = out.split('.')[0]
  if (RESERVED_NAMES.has(stem.toUpperCase())) out = `_${out}`
  return out
}

/** 判断路径是否超过 Windows MAX_PATH（260）限制。 */
export function isLongPath(path: string): boolean {
  return path.length > 240
}

/** 为超长路径生成 \\?\ 前缀（Windows）。 */
export function toExtendedPath(path: string): string {
  if (!/^[A-Za-z]:/.test(path)) return path
  if (path.startsWith('\\\\?\\')) return path
  return `\\\\?\\${path.replace(/\//g, '\\')}`
}

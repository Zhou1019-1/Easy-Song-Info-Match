/**
 * 标签读写（基于 node-taglib-sharp 的纯 JS TagLib 移植）。
 *
 * 读：按格式对应的物理键读出语义字段。
 * 写：先做「物理键冲突消解」（同一物理键被多个语义字段命中时只写第一个），
 *     再逐字段写入；写入失败的字段明确报错，不静默跳过。
 */
import {
  ByteVector,
  File,
  FileAccessMode,
  ReadStyle,
  StringType,
  TagTypes,
  Id3v2FrameIdentifiers
} from 'node-taglib-sharp'
import type { TagValues } from '@shared/types'
import {
  FIELD_KEYS,
  formatFromExtension,
  formatWarning,
  parseFraction,
  supportsField,
  type PhysicalKey,
  type TagFormat
} from './fieldMap'
import { readId3v2TextFrames, SPLIT_TEXT_FRAMES } from './id3v2Text'

export interface TagReadResult {
  format: TagFormat
  tags: TagValues
  /** 原始物理键 -> 值 */
  raw: Record<string, string[]>
  hasArtwork: boolean
  durationMs: number
  bitrate: number
  sampleRate: number
  channels: number
  corrupt: boolean
  warnings: string[]
  error?: string
}

export interface FieldWriteOutcome {
  field: string
  ok: boolean
  reason?: string
}

export interface TagWriteResult {
  ok: boolean
  written: string[]
  failed: FieldWriteOutcome[]
  warnings: string[]
  error?: string
}

/** 标签格式的判定：优先看磁盘上真实存在的标签类型。 */
export function detectFormat(file: File, ext: string): TagFormat {
  const types = file.tagTypesOnDisk
  if (types & TagTypes.Xiph) return 'vorbis'
  if (types & TagTypes.Apple) return 'mp4'
  if (types & TagTypes.Id3v2) return 'id3v2'
  if (types & TagTypes.Ape) return 'ape'
  if (types & TagTypes.Asf) return 'asf'
  if (types & TagTypes.Id3v1) return 'id3v1'
  if (types & TagTypes.RiffInfo) return 'riff'
  return formatFromExtension(ext)
}

/** MP4 freeform 键 `----:mean:name` 拆解。 */
function parseFreeform(key: string): { mean: string; name: string } | null {
  const m = key.match(/^----:(.+):([^:]+)$/)
  if (!m) return null
  return { mean: m[1], name: m[2] }
}

/** 从泛型 Tag 读取需要特殊处理的字段（USLT / COMM / MP4 二进制对）。 */
function readGenericSpecial(
  format: TagFormat,
  file: File,
  field: string
): string[] {
  const tag = file.tag as any
  if (!tag) return []
  if (format === 'id3v2') {
    if (field === 'lyrics') return tag.lyrics ? [String(tag.lyrics)] : []
    if (field === 'comment') return tag.comment ? [String(tag.comment)] : []
  }
  if (format === 'mp4') {
    if (field === 'track') return tag.track ? [String(tag.track)] : []
    if (field === 'totaltracks') return tag.trackCount ? [String(tag.trackCount)] : []
    if (field === 'disc') return tag.disc ? [String(tag.disc)] : []
    if (field === 'totaldiscs') return tag.discCount ? [String(tag.discCount)] : []
  }
  if (format === 'vorbis') {
    if (field === 'totaltracks') {
      const xiph = file.getTag(TagTypes.Xiph, false) as any
      const v = xiph?.getField?.('TRACKTOTAL')
      if (v && v.length && v[0]) return [v[0]]
    }
    if (field === 'totaldiscs') {
      const xiph = file.getTag(TagTypes.Xiph, false) as any
      const v = xiph?.getField?.('TOTALDISCS')
      if (v && v.length && v[0]) return [v[0]]
      const alt = xiph?.getField?.('DISCTOTAL')
      if (alt && alt.length && alt[0]) return [alt[0]]
    }
  }
  return []
}

/** 「音轨号 / 总音轨数」这类分数型字段在语义上的归属。 */
const FRACTION_PARTS: Record<string, 'numerator' | 'denominator'> = {
  track: 'numerator',
  disc: 'numerator',
  totaltracks: 'denominator',
  totaldiscs: 'denominator'
}

function readPhysical(
  format: TagFormat,
  file: File,
  spec: PhysicalKey[],
  field: string,
  rawText?: Map<string, string[]>
): string[] {
  switch (format) {
    case 'vorbis': {
      const tag = file.getTag(TagTypes.Xiph, false) as any
      if (!tag) return []
      for (const k of spec) {
        const values = tag.getField(k.key)
        if (values && values.length) {
          const filtered = values.filter((v: unknown) => v !== undefined && v !== null && String(v).trim() !== '')
          if (filtered.length) return filtered.map((v: unknown) => String(v))
        }
      }
      return []
    }
    case 'id3v2': {
      const tag = file.getTag(TagTypes.Id3v2, false) as any
      if (!tag) return []
      for (const k of spec) {
        if (k.kind === 'userText') {
          const desc = k.key.slice('TXXX:'.length)
          const v = tag.getUserTextAsString?.(desc)
          if (v) return [String(v)]
          continue
        }
        const ident = (Id3v2FrameIdentifiers as unknown as Record<string, unknown>)[k.key]
        if (!ident) continue
        // taglib 会把 TPE1 等帧按 "/" 拆开（"AC/DC" -> "AC; DC"），
        // 这几类帧改用原始解析结果。
        if (SPLIT_TEXT_FRAMES.has(k.key)) {
          const raw = rawText?.get(k.key)
          if (raw && raw.length) return raw.map((v) => String(v))
        }
        const v = tag.getTextAsString?.(ident)
        if (!v) continue
        // TRCK / TPOS 形如 "3/12"：音轨号取分子，总音轨数取分母
        if (k.kind === 'fraction') {
          const part = FRACTION_PARTS[field]
          if (!part) return [String(v)]
          const f = parseFraction(String(v))
          const n = part === 'numerator' ? f.numerator : f.denominator
          if (n === null) continue
          return [String(n)]
        }
        return [String(v)]
      }
      return []
    }
    case 'mp4': {
      const tag = file.getTag(TagTypes.Apple, false) as any
      if (!tag) return []
      for (const k of spec) {
        if (k.kind === 'freeform') {
          const ff = parseFreeform(k.key)
          if (!ff) continue
          const values = tag.getItunesStrings?.(ff.mean, ff.name)
          if (values && values.length) return values.map((v: unknown) => String(v))
          continue
        }
        const bv = ByteVector.fromString(k.key, StringType.Latin1)
        const v = tag.getFirstQuickTimeString?.(bv)
        if (v) return [String(v)]
      }
      return []
    }
    case 'ape': {
      const tag = file.getTag(TagTypes.Ape, false) as any
      if (!tag) return []
      for (const k of spec) {
        const v = tag.get?.(k.key)
        if (v) return [String(v)]
      }
      return []
    }
    case 'riff': {
      const tag = file.getTag(TagTypes.RiffInfo, false) as any
      if (!tag) return []
      for (const k of spec) {
        const v = readRiffInfoValue(tag, k.key)
        if (v && v.length) return v
      }
      return []
    }
    default:
      return []
  }
}

/**
 * 读 RIFF INFO 的某个键。
 *
 * 直接按四字符键取值，不走 InfoTag 的便捷 getter——
 * 那些 getter 与标准键并不一致（如 performers 读 ISTR、album 读 DIRC），
 * 与 fieldMap 的映射对不上。
 */
function readRiffInfoValue(tag: any, key: string): string[] {
  if (key.length !== 4) return []
  try {
    const values = tag.getValuesAsStrings?.(key) as string[] | undefined
    if (!values || !values.length) return []
    return values.map((v) => String(v))
  } catch {
    return []
  }
}

/** 读取一个文件的全部语义字段。 */
export function readTags(filePath: string): TagReadResult {
  const warnings: string[] = []
  let file: File | null = null
  try {
    file = File.createFromPath(filePath, undefined, ReadStyle.Average)
    const ext = filePath.slice(filePath.lastIndexOf('.'))
    const format = detectFormat(file, ext)
    const fw = formatWarning(format)
    if (fw) warnings.push(fw)

    const tags: TagValues = {}
    const raw: Record<string, string[]> = {}
    const fieldMap = FIELD_KEYS[format] ?? {}
    // ID3v2 的 TPE1/TPE2/TCOM 等帧需要原始解析（taglib 会按 "/" 拆开）
    const rawText = format === 'id3v2' ? readId3v2TextFrames(filePath) : undefined

    for (const [field, spec] of Object.entries(fieldMap)) {
      let values = readGenericSpecial(format, file, field)
      if (!values.length) values = readPhysical(format, file, spec, field, rawText)
      const cleaned = values.map((v) => String(v).trim()).filter((v) => v.length > 0)
      if (cleaned.length) {
        tags[field] = cleaned
        raw[field] = cleaned
      }
    }

    const props = file.properties
    let hasArtwork = false
    try {
      hasArtwork = Array.isArray(file.tag?.pictures) && file.tag.pictures.length > 0
    } catch {
      hasArtwork = false
    }

    return {
      format,
      tags,
      raw,
      hasArtwork,
      durationMs: props?.durationMilliseconds ?? 0,
      bitrate: props?.audioBitrate ?? 0,
      sampleRate: props?.audioSampleRate ?? 0,
      channels: props?.audioChannels ?? 0,
      corrupt: file.isPossiblyCorrupt,
      warnings
    }
  } catch (err) {
    return {
      format: 'unknown',
      tags: {},
      raw: {},
      hasArtwork: false,
      durationMs: 0,
      bitrate: 0,
      sampleRate: 0,
      channels: 0,
      corrupt: true,
      warnings,
      error: err instanceof Error ? err.message : String(err)
    }
  } finally {
    try {
      file?.dispose()
    } catch {
      /* ignore */
    }
  }
}

/** 写入计划中的一条：物理键 -> 值。 */
interface PlanEntry {
  values: string[]
  field: string
  kind: PhysicalKey['kind']
  /** 分数型字段对：分子 / 分母（如音轨号与总音轨数） */
  pair?: { numerator: string; denominator: string }
}

interface WriteTarget {
  format: TagFormat
  /** 物理键 -> 值（空数组代表删除） */
  plan: Map<string, PlanEntry>
}

/**
 * 分数型字段对：两种容器都把「音轨号 + 总音轨数」塞进同一个物理字段。
 * ID3 用 "3/12" 文本帧，MP4 用 trkn 二进制对。
 */
const FRACTION_PAIRS: Record<string, Array<{ num: string; den: string; key: string }>> = {
  id3v2: [
    { num: 'track', den: 'totaltracks', key: 'TRCK' },
    { num: 'disc', den: 'totaldiscs', key: 'TPOS' }
  ],
  mp4: [
    { num: 'track', den: 'totaltracks', key: 'trkn' },
    { num: 'disc', den: 'totaldiscs', key: 'disk' }
  ]
}

/**
 * 计算写入计划：把语义字段映射到物理键，并消解同一物理键的冲突。
 * 返回 null 表示该字段在此格式下不受支持。
 */
export function buildWritePlan(
  format: TagFormat,
  fields: TagValues
): { plan: WriteTarget['plan']; unsupported: string[]; conflicts: string[] } {
  const plan = new Map<string, PlanEntry>()
  const unsupported: string[] = []
  const conflicts: string[] = []
  const fieldMap = FIELD_KEYS[format] ?? {}
  const handled = new Set<string>()

  // 1) 分数型字段对：音轨号与总音轨数合并进同一物理字段
  for (const pair of FRACTION_PAIRS[format] ?? []) {
    const numValues = fields[pair.num]
    const denValues = fields[pair.den]
    if (!numValues && !denValues) continue
    handled.add(pair.num)
    handled.add(pair.den)
    const numerator = (numValues ?? []).map(String).find((v) => v.length > 0) ?? ''
    const denominator = (denValues ?? []).map(String).find((v) => v.length > 0) ?? ''
    if (!numerator) {
      conflicts.push(
        `ID3/MP4 的「${pair.num === 'track' ? '音轨号' : '碟号'}」与「${pair.den === 'totaltracks' ? '总音轨数' : '总碟数'}」共用同一物理字段，缺少${pair.num === 'track' ? '音轨号' : '碟号'}，已跳过 ${pair.den}`
      )
      continue
    }
    const kind = fieldMap[pair.num]?.[0]?.kind ?? 'text'
    plan.set(pair.key, {
      values: format === 'id3v2' ? [denominator ? `${numerator}/${denominator}` : numerator] : [numerator],
      field: pair.num,
      kind,
      pair: { numerator, denominator }
    })
  }

  // 2) 其它字段
  for (const [field, values] of Object.entries(fields)) {
    if (handled.has(field)) continue
    const spec = fieldMap[field]
    if (!spec || !spec.length) {
      unsupported.push(field)
      continue
    }
    const key = spec[0]
    const existing = plan.get(key.key)
    if (existing) {
      conflicts.push(`${field} 与 ${existing.field} 映射到同一物理键「${key.key}」，已跳过 ${field}`)
      continue
    }
    plan.set(key.key, { values: (values ?? []).map((v) => String(v)), field, kind: key.kind })
  }
  return { plan, unsupported, conflicts }
}

function writeVorbis(file: File, entry: { values: string[]; field: string }): void {
  const tag = file.getTag(TagTypes.Xiph, true) as any
  if (!tag) throw new Error('无法创建 Vorbis Comment 标签')
  if (!entry.values.length) {
    tag.removeField(entry.field)
    return
  }
  tag.setFieldAsStrings(entry.field, ...entry.values)
}

function writeId3v2(file: File, entry: { values: string[]; kind: PhysicalKey['kind']; key: string }): void {
  const tag = file.getTag(TagTypes.Id3v2, true) as any
  if (!tag) throw new Error('无法创建 ID3v2 标签')

  if (entry.kind === 'userText') {
    const desc = entry.key.slice('TXXX:'.length)
    tag.setUserTextAsString(desc, entry.values.join(';'))
    return
  }
  const ident = (Id3v2FrameIdentifiers as unknown as Record<string, unknown>)[entry.key]
  if (!ident) throw new Error(`未知的 ID3 帧 ${entry.key}`)
  tag.setTextFrame(ident, ...entry.values)
}

function writeMp4(file: File, entry: { values: string[]; kind: PhysicalKey['kind']; key: string }): void {
  const tag = file.getTag(TagTypes.Apple, true) as any
  if (!tag) throw new Error('无法创建 MP4 标签')

  if (entry.kind === 'freeform') {
    const ff = parseFreeform(entry.key)
    if (!ff) throw new Error(`非法的 MP4 freeform 键 ${entry.key}`)
    tag.setItunesStrings(ff.mean, ff.name, ...entry.values)
    return
  }
  const bv = ByteVector.fromString(entry.key, StringType.Latin1)
  tag.setQuickTimeStrings(bv, entry.values)
}

/** 写 RIFF INFO（WAV）标签。直接按四字符键写，键为空的字段会被删除。 */
function writeRiff(file: File, entry: { values: string[]; key: string }): void {
  const tag = file.getTag(TagTypes.RiffInfo, true) as any
  if (!tag) throw new Error('无法创建 RIFF INFO 标签')
  if (entry.key.length !== 4) throw new Error(`非法的 RIFF INFO 键 ${entry.key}`)
  const values = entry.values.map((v) => String(v)).filter((v) => v.length > 0)
  tag.setValuesFromStrings?.(entry.key, values.length ? values : undefined)
}

/**
 * 写入标签。
 * @param fields 要写入的字段（值为空数组表示清空该字段）
 */
export function writeTags(filePath: string, fields: TagValues): TagWriteResult {
  const warnings: string[] = []
  const written: string[] = []
  const failed: FieldWriteOutcome[] = []
  let file: File | null = null

  try {
    file = File.createFromPath(filePath, undefined, ReadStyle.None)
    const ext = filePath.slice(filePath.lastIndexOf('.'))
    const format = detectFormat(file, ext)
    const fw = formatWarning(format)
    if (fw) warnings.push(fw)

    const { plan, unsupported, conflicts } = buildWritePlan(format, fields)
    warnings.push(...conflicts)
    for (const f of unsupported) {
      failed.push({ field: f, ok: false, reason: `格式 ${format} 不支持该字段` })
    }

    // WAV 上 node-taglib-sharp 会自动建一个空的 ID3v2 标签并一起写回，
    // 而读取时 ID3v2 优先于 RIFF INFO，会用旧值遮蔽刚写入的 INFO。
    // 因此：盘上原本就有 ID3v2 时同步写入同一批字段；没有则移除这个自动标签。
    const riffHasId3v2 = format === 'riff' && !!(file.tagTypesOnDisk & TagTypes.Id3v2)

    file.mode = FileAccessMode.Write

    // MP4 的 trkn/disk 需要分子分母同时写入
    const mp4Pairs: Array<{ box: 'trkn' | 'disk'; num: number; den: number }> = []
    if (format === 'mp4') {
      const trackEntry = plan.get('trkn')
      const diskEntry = plan.get('disk')
      if (trackEntry) {
        mp4Pairs.push({
          box: 'trkn',
          num: Number(trackEntry.pair?.numerator ?? trackEntry.values[0] ?? 0) || 0,
          den: Number(trackEntry.pair?.denominator ?? 0) || 0
        })
      }
      if (diskEntry) {
        mp4Pairs.push({
          box: 'disk',
          num: Number(diskEntry.pair?.numerator ?? diskEntry.values[0] ?? 0) || 0,
          den: Number(diskEntry.pair?.denominator ?? 0) || 0
        })
      }
    }

    for (const [key, entry] of plan) {
      try {
        if (format === 'vorbis') {
          writeVorbis(file, { values: entry.values, field: key })
        } else if (format === 'id3v2') {
          if (key === 'USLT') {
            const tag = file.getTag(TagTypes.Id3v2, true) as any
            tag.lyrics = entry.values.join('\n')
          } else if (key === 'COMM') {
            const tag = file.getTag(TagTypes.Id3v2, true) as any
            tag.comment = entry.values.join('\n')
          } else {
            writeId3v2(file, { values: entry.values, kind: entry.kind, key })
          }
        } else if (format === 'mp4') {
          if (key === 'trkn' || key === 'disk') continue // 由 mp4Pairs 统一处理
          writeMp4(file, { values: entry.values, kind: entry.kind, key })
        } else if (format === 'ape') {
          const tag = file.getTag(TagTypes.Ape, true) as any
          if (!tag) throw new Error('无法创建 APE 标签')
          tag.set?.(key, entry.values.join(';'))
        } else if (format === 'riff') {
          writeRiff(file, { values: entry.values, key })
          if (riffHasId3v2) {
            // 文件本来就有 ID3v2，同步写入避免两边值不一致
            const id3spec = FIELD_KEYS.id3v2[entry.field]
            if (id3spec) {
              writeId3v2(file, { values: entry.values, kind: id3spec[0].kind, key: id3spec[0].key })
            }
          }
        } else {
          throw new Error(`格式 ${format} 的写入尚未实现`)
        }
        written.push(entry.field)
      } catch (err) {
        failed.push({
          field: entry.field,
          ok: false,
          reason: err instanceof Error ? err.message : String(err)
        })
      }
    }

    if (format === 'mp4' && mp4Pairs.length) {
      const tag = file.getTag(TagTypes.Apple, true) as any
      for (const p of mp4Pairs) {
        try {
          if (p.box === 'trkn') {
            tag.track = p.num
            tag.trackCount = p.den
          } else {
            tag.disc = p.num
            tag.discCount = p.den
          }
          written.push(p.box === 'trkn' ? 'track' : 'disc')
        } catch (err) {
          failed.push({
            field: p.box === 'trkn' ? 'track' : 'disc',
            ok: false,
            reason: err instanceof Error ? err.message : String(err)
          })
        }
      }
    }

    if (format === 'riff' && !riffHasId3v2) {
      // 去掉 taglib 自动生成的 ID3v2 标签，WAV 只保留 RIFF INFO 一个来源
      file.removeTags(TagTypes.Id3v2)
    }

    file.save()

    return {
      ok: failed.length === 0,
      written: [...new Set(written)],
      failed,
      warnings
    }
  } catch (err) {
    return {
      ok: false,
      written,
      failed,
      warnings,
      error: err instanceof Error ? err.message : String(err)
    }
  } finally {
    try {
      file?.dispose()
    } catch {
      /* ignore */
    }
  }
}

/** 该格式是否支持某字段（供 UI 提示）。 */
export { supportsField }

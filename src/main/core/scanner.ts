/**
 * 扫描器：目录遍历 + 单文件信息提取。
 *
 * 关键约束（提示词第五节 A）：
 *   - 信息提取优先级：内嵌标签 > 文件名 > 文件夹 > 联网；
 *   - 单个文件失败**不丢弃**，进入异常隔离清单；
 *   - 目录遍历失败（权限/超长路径）也要进报告，不能静默跳过。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { FieldSource, LyricState, MatchState, TagValues, TrackIssue } from '@shared/types'
import { computeAudioHash } from './hash'
import { detectFormat, readTags } from './tagIo'
import { parseFilename, parseFolderContext } from './filenameParser'
import { isMojibake, repairMojibake, toExtendedPath } from './charset'
import { splitArtists } from './alias'
import type { ScannedFile } from '../db'

/** 默认支持的音频扩展名。 */
export const DEFAULT_EXTENSIONS = [
  'mp3',
  'flac',
  'm4a',
  'm4b',
  'mp4',
  'aac',
  'ogg',
  'oga',
  'opus',
  'ape',
  'wv',
  'wav',
  'wave',
  'wma',
  'dsf',
  'dff',
  'aiff',
  'mka'
]

export interface ScanContext {
  extensions: string[]
  recursive: boolean
  followSymlinks: boolean
  computeHash: boolean
  /** 别名表（歌手名归一） */
  aliasIndex?: Map<string, string>
  /** 保护名单（禁止拆分的艺名） */
  protectedArtists: string[]
  onProgress?: (done: number, total: number, current: string) => void
  isCancelled?: () => boolean
}

export interface CollectResult {
  files: string[]
  /** 目录级错误（进报告，不中断扫描） */
  dirErrors: Array<{ dir: string; message: string }>
}

/** 判断是否为受支持的音频文件。 */
export function isAudioFile(file: string, extensions: string[]): boolean {
  const ext = path.extname(file).replace(/^\./, '').toLowerCase()
  return extensions.includes(ext)
}

/** 递归遍历目录，收集音频文件。 */
export function collectFiles(roots: string[], ctx: ScanContext): CollectResult {
  const files: string[] = []
  const dirErrors: Array<{ dir: string; message: string }> = []
  const extSet = new Set(ctx.extensions.map((e) => e.replace(/^\./, '').toLowerCase()))

  const walk = (dir: string, depth: number): void => {
    if (ctx.isCancelled?.()) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (err) {
      dirErrors.push({
        dir,
        message: err instanceof Error ? err.message : String(err)
      })
      return
    }
    for (const entry of entries) {
      if (ctx.isCancelled?.()) return
      const full = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        if (!ctx.followSymlinks) continue
        try {
          const st = fs.statSync(full)
          if (st.isDirectory()) walk(full, depth + 1)
          else if (st.isFile() && extSet.has(path.extname(entry.name).replace(/^\./, '').toLowerCase()))
            files.push(full)
        } catch (err) {
          dirErrors.push({ dir: full, message: err instanceof Error ? err.message : String(err) })
        }
        continue
      }
      if (entry.isDirectory()) {
        if (ctx.recursive) walk(full, depth + 1)
        continue
      }
      if (entry.isFile()) {
        const ext = path.extname(entry.name).replace(/^\./, '').toLowerCase()
        if (extSet.has(ext)) files.push(full)
      }
    }
  }

  for (const root of roots) {
    try {
      const st = fs.statSync(root)
      if (st.isDirectory()) walk(root, 0)
      else if (st.isFile() && extSet.has(path.extname(root).replace(/^\./, '').toLowerCase()))
        files.push(root)
    } catch (err) {
      dirErrors.push({ dir: root, message: err instanceof Error ? err.message : String(err) })
    }
  }
  return { files, dirErrors }
}

/** 修复乱码后的标签值；同时记录异常。 */
function repairTags(
  tags: TagValues,
  issues: TrackIssue[]
): { tags: TagValues; changed: boolean } {
  let changed = false
  const out: TagValues = {}
  for (const [field, values] of Object.entries(tags)) {
    const fixed: string[] = []
    for (const v of values) {
      if (isMojibake(v)) {
        const r = repairMojibake(v)
        if (r.changed) {
          changed = true
          fixed.push(r.text)
          continue
        }
      }
      fixed.push(v)
    }
    out[field] = fixed
  }
  if (changed) {
    issues.push({
      code: 'mojibake-repaired',
      level: 'info',
      message: '检测到乱码字符，已按 GBK/UTF-8 规则修复（仅显示修复结果，未写回文件）'
    })
  }
  return { tags: out, changed }
}

/** 提取单个文件的完整信息。 */
export function scanOne(filePath: string, ctx: ScanContext): ScannedFile {
  const issues: TrackIssue[] = []
  const dir = path.dirname(filePath)
  const filename = path.basename(filePath)
  const ext = path.extname(filePath).replace(/^\./, '').toLowerCase()

  let size = 0
  let mtime = 0
  try {
    const st = fs.statSync(filePath)
    size = st.size
    mtime = st.mtimeMs
  } catch (err) {
    issues.push({
      code: 'stat-failed',
      level: 'error',
      message: `无法读取文件属性：${err instanceof Error ? err.message : String(err)}`
    })
  }

  // 1) 读标签
  const read = readTags(filePath)
  if (read.error) {
    issues.push({ code: 'read-failed', level: 'error', message: `标签读取失败：${read.error}` })
  }
  for (const w of read.warnings) {
    issues.push({ code: 'format-warning', level: 'warn', message: w })
  }
  if (read.corrupt && !read.error) {
    issues.push({ code: 'corrupt', level: 'error', message: '文件可能已损坏，标签可能不完整' })
  }

  // 2) 修乱码
  const repaired = repairTags(read.tags, issues)
  const tags: TagValues = repaired.tags
  const sources: Record<string, FieldSource> = {}
  for (const key of Object.keys(tags)) sources[key] = 'tag'
  // 内嵌标签数量（回填之前统计）：用来判断"文件本身是否带任何信息"。
  const embeddedTagCount = Object.keys(tags).length

  // 3) 文件名 / 文件夹解析
  const parentName = path.basename(dir)
  const grandName = path.basename(path.dirname(dir))
  const knownArtist = tags.artist?.[0] ?? null
  const parsed = parseFilename(filename, ext, {
    folderName: parentName,
    parentFolderName: grandName,
    knownArtist,
    knownAlbum: tags.album?.[0] ?? null
  })
  const context = parseFolderContext(parentName)

  if (parsed.confidence === 'low') {
    issues.push({
      code: 'low-confidence-name',
      level: 'warn',
      message: `文件名解析置信度低：${parsed.reasons.join('；')}`,
      detail: parsed.title
    })
  }

  // 4) 补齐缺失字段（标签 > 文件名 > 文件夹）
  if (!tags.title?.length && parsed.title) {
    tags.title = [parsed.title]
    sources.title = 'filename'
  }
  if (!tags.artist?.length && parsed.artist) {
    tags.artist = splitArtists(parsed.artist, ctx.protectedArtists, ctx.aliasIndex)
    sources.artist = parsed.artistSource === 'folder' ? 'folder' : 'filename'
  }
  if (!tags.album?.length) {
    if (parsed.album) {
      tags.album = [parsed.album]
      sources.album = parsed.albumSource === 'folder' ? 'folder' : 'filename'
    } else if (context?.album) {
      tags.album = [context.album]
      sources.album = 'folder'
    }
  }
  if (!tags.year?.length && context?.year) {
    tags.year = [String(context.year)]
    sources.year = 'folder'
  }
  if (!tags.track?.length && parsed.trackNumber) {
    tags.track = [String(parsed.trackNumber)]
    sources.track = 'filename'
  }
  if (tags.artist?.length) {
    const split = splitArtists(tags.artist.join('; '), ctx.protectedArtists, ctx.aliasIndex)
    if (split.length !== tags.artist.length) {
      tags.artist = split
      sources.artist = sources.artist ?? 'tag'
    }
  }

  // 5) 待确认判定：文件本身没有任何信息，或信息只能靠猜测。
  let matchState: MatchState = 'none'
  if (embeddedTagCount === 0) {
    issues.push({
      code: 'no-tags',
      level: 'warn',
      message: '文件没有任何内嵌标签，所有信息均来自文件名/文件夹推断，已标记为待确认'
    })
    matchState = 'pending'
  } else if (read.error || read.corrupt) {
    matchState = 'pending'
  } else if (parsed.confidence === 'low') {
    matchState = 'pending'
  }

  // 6) 歌词状态
  let lyricState: LyricState = 'none'
  if (tags.lyrics?.length && tags.lyrics.some((l) => l.trim())) {
    lyricState = 'embedded'
  }
  const lrcPath = path.join(dir, `${filename.slice(0, filename.length - ext.length - 1)}.lrc`)
  let hasLrc = false
  try {
    hasLrc = fs.existsSync(lrcPath)
  } catch {
    hasLrc = false
  }
  if (hasLrc) lyricState = lyricState === 'embedded' ? 'both' : 'lrc-file'

  // 7) 哈希
  let audioHash: string | null = null
  if (ctx.computeHash) {
    try {
      audioHash = computeAudioHash(toExtendedPath(filePath), detectFormatFromExt(ext))
    } catch {
      audioHash = null
    }
  }

  return {
    path: filePath,
    dir,
    filename,
    ext,
    size,
    mtime,
    audioHash,
    format: read.format,
    duration: read.durationMs ? Math.round(read.durationMs / 10) / 100 : null,
    bitrate: read.bitrate || null,
    sampleRate: read.sampleRate || null,
    channels: read.channels || null,
    hasArtwork: read.hasArtwork,
    tags,
    sources,
    parsed,
    context,
    issues,
    matchState,
    lyricState
  }
}

/** 按扩展名推断标签格式（用于哈希计算）。 */
function detectFormatFromExt(ext: string): ReturnType<typeof detectFormat> {
  const map: Record<string, ReturnType<typeof detectFormat>> = {
    flac: 'vorbis',
    ogg: 'vorbis',
    oga: 'vorbis',
    opus: 'vorbis',
    mp3: 'id3v2',
    mp2: 'id3v2',
    aac: 'id3v2',
    m4a: 'mp4',
    m4b: 'mp4',
    mp4: 'mp4',
    ape: 'ape',
    wv: 'ape',
    wav: 'riff',
    wave: 'riff',
    wma: 'asf',
    dsf: 'id3v2',
    dff: 'id3v2'
  }
  return map[ext] ?? 'unknown'
}

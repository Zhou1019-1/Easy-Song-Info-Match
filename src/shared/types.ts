/**
 * 跨进程共享的类型定义。
 *
 * 核心设计：标签字段以「语义字段 + 多值」的平铺结构表达（SemanticField），
 * 这样才能做到 ①逐字段勾选写回 ②逐字段记录来源 ③逐字段 diff ④逐字段清空。
 */

/** 字段值的来源，用于「来源可追溯」原则（原则 6）。 */
export type FieldSource =
  | 'tag' // 文件内嵌标签
  | 'filename' // 文件名解析
  | 'folder' // 文件夹名推断
  | 'musicbrainz'
  | 'itunes'
  | 'plugin' // 用户导入的音源插件
  | 'lyrics' // 歌词文本解析（词/曲信息）
  | 'manual' // 用户手动编辑
  | 'albumart'

export const FIELD_SOURCES: FieldSource[] = [
  'tag',
  'filename',
  'folder',
  'musicbrainz',
  'itunes',
  'plugin',
  'lyrics',
  'manual',
  'albumart'
]

export const FIELD_SOURCE_LABELS: Record<FieldSource, string> = {
  tag: '标签',
  filename: '文件名',
  folder: '文件夹',
  musicbrainz: 'MusicBrainz',
  itunes: 'iTunes',
  plugin: '音源插件',
  lyrics: '歌词解析',
  manual: '手动',
  albumart: '封面'
}

/** 内容分级。 */
export type AdvisoryLevel = 'explicit' | 'clean' | 'none'

/** 单个语义字段的一个值，附带来源。 */
export interface FieldValue {
  value: string
  source: FieldSource
}

/** 语义字段 -> 值列表。 */
export type FieldValueMap = Record<string, FieldValue[]>

/** 语义字段 -> 纯字符串列表（比较/展示用）。 */
export type TagValues = Record<string, string[]>

/** 单个候选的来源类型。 */
export type CandidateSource = 'musicbrainz' | 'itunes' | 'plugin' | 'local'

export const CANDIDATE_SOURCE_LABELS: Record<CandidateSource, string> = {
  musicbrainz: 'MusicBrainz',
  itunes: 'iTunes',
  plugin: '音源插件',
  local: '本地线索'
}

/** 一个匹配候选。 */
export interface Candidate {
  id: string
  source: CandidateSource
  /** 来源内部的主键（MBID / trackId / 插件 id） */
  sourceKey: string
  title: string
  artists: string[]
  album: string | null
  albumArtists: string[]
  composers: string[]
  duration: number | null
  year: number | null
  date: string | null
  genre: string | null
  label: string | null
  upc: string | null
  catalogNumber: string | null
  copyright: string | null
  trackNumber: number | null
  discNumber: number | null
  totalDiscs: number | null
  advisory: AdvisoryLevel
  /** 分级原始值（iTunes trackExplicitness） */
  advisoryRaw?: string
  /** 歌词内容（插件来源可能直接带歌词） */
  lyrics?: string
  /** 封面 URL */
  artworkUrl?: string
  /** 其它原始字段，保留以防丢失 */
  raw?: Record<string, unknown>
  /** 综合匹配分 0~100 */
  score: number
  /** 各维度得分明细 */
  scoreDetail?: ScoreDetail
  /** 插件来源名 */
  pluginId?: string
  /** 插件来源的原始 musicInfo */
  rawMusicInfo?: Record<string, unknown>
}

/** 匹配分维度明细。 */
export interface ScoreDetail {
  title: number
  artist: number
  album: number
  duration: number
  year: number
  total: number
}

/** 一个本地文件在库中的记录。 */
export interface TrackRecord {
  id: number
  path: string
  dir: string
  filename: string
  ext: string
  size: number
  mtime: number
  /** 音频数据区哈希（不含标签） */
  audioHash: string | null
  /** 标签字段值 */
  tags: TagValues
  /** 每个字段的来源 */
  sources: Record<string, FieldSource>
  /** 文件名解析结果 */
  parsed: FilenameParseResult | null
  /** 目录上下文推断 */
  context: FolderContext | null
  /** 时长（秒） */
  duration: number | null
  bitrate: number | null
  sampleRate: number | null
  channels: number | null
  /** 异常标记 */
  issues: TrackIssue[]
  /** 匹配状态 */
  matchState: MatchState
  /** 歌词状态 */
  lyricState: LyricState
  /** 是否已有封面 */
  hasArtwork: boolean
  scanBatch: string
  lastSeen: number
}

export type MatchState = 'none' | 'pending' | 'matched' | 'rejected' | 'manual'

export type LyricState = 'none' | 'embedded' | 'lrc-file' | 'both' | 'plain-text' | 'pending'

/** 异常隔离清单项。 */
export interface TrackIssue {
  code: string
  level: 'info' | 'warn' | 'error'
  message: string
  detail?: string
}

/** 文件名解析结果。 */
export interface FilenameParseResult {
  title: string
  artist: string | null
  album: string | null
  trackNumber: number | null
  /** 来源后缀提示，如 tx-flac / DSD64 */
  sourceHint: string | null
  confidence: 'high' | 'medium' | 'low'
  reasons: string[]
  /** 歌手是取自文件名还是文件夹上下文 */
  artistSource?: 'filename' | 'folder' | null
  /** 专辑是取自文件名还是文件夹上下文 */
  albumSource?: 'filename' | 'folder' | null
}

/** 文件夹上下文推断。 */
export interface FolderContext {
  artist: string | null
  album: string | null
  year: number | null
  /** 命名前缀，如 "XX代表专辑" 中的 XX */
  prefix: string | null
  confidence: 'high' | 'medium' | 'low'
}

/** 扫描选项。 */
export interface ScanOptions {
  roots: string[]
  recursive: boolean
  followSymlinks: boolean
  extensions: string[]
  /** 是否计算音频数据区哈希（较慢） */
  computeHash: boolean
  /** 是否解析 CUE 整轨 */
  parseCue: boolean
}

/** 批量操作预览（干跑报告）。 */
export interface PreviewReport {
  batchId: string
  opType: BatchOpType
  items: PreviewItem[]
  /** 汇总 */
  summary: {
    total: number
    changed: number
    unchanged: number
    failed: number
    skipped: number
  }
  warnings: string[]
}

export type BatchOpType = 'write-tags' | 'clear-tags' | 'rename' | 'move' | 'archive' | 'lyrics' | 'alias'

export interface PreviewItem {
  fileId: number
  path: string
  filename: string
  /** 字段级 diff */
  diffs: FieldDiff[]
  /** 新路径（重命名/移动时） */
  newPath?: string
  status: 'changed' | 'unchanged' | 'failed' | 'skipped'
  message?: string
}

export interface FieldDiff {
  field: string
  label: string
  oldValue: string | null
  newValue: string | null
  source: FieldSource
  /** 覆盖模式下的旧值非空 */
  overwrite: boolean
}

/** 一次批量写入的请求。 */
export interface WriteRequest {
  batchId: string
  items: WriteItem[]
  /** 覆盖模式：写已有值的字段（需二次确认） */
  overwrite: boolean
}

export interface WriteItem {
  fileId: number
  path: string
  /** 要写入的字段：语义字段 -> 新值列表 */
  fields: TagValues
  /** 字段来源 */
  sources: Record<string, FieldSource>
  /** 需要删除的字段 */
  clearFields?: string[]
}

/** 任务（每个批量操作是一个独立任务）。 */
export interface TaskInfo {
  id: string
  type: string
  title: string
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
  progress: number
  total: number
  message: string
  createdAt: number
  startedAt?: number
  finishedAt?: number
  error?: string
}

/** 操作日志一行。 */
export interface OpLogEntry {
  id: number
  ts: number
  filePath: string
  field: string
  oldValue: string | null
  newValue: string | null
  source: FieldSource
  batchId: string
}

/** 撤销条目。 */
export interface UndoEntry {
  id: number
  batchId: string
  fileId: number
  path: string
  kind: 'tag' | 'rename' | 'move' | 'delete' | 'create'
  field: string | null
  oldValue: string | null
  newValue: string | null
}

/** 音源插件元信息。 */
export interface PluginInfo {
  id: string
  name: string
  version: string
  path: string
  enabled: boolean
  /** 插件声明支持的平台源码，如 kw/kg/tx/wy/mg */
  sources: string[]
  qualitys: string[]
  /** 是否声明为 lx 格式 */
  format: 'lx' | 'unknown'
  /** 导入时间 */
  importedAt: number
  /** 是否加载成功 */
  loadOk: boolean
  loadError?: string
  /** 与本程序协议不兼容的地方（明确提示，禁止悄悄吞掉） */
  incompatibilities: string[]
  /** 限速：每分钟最多调用次数 */
  rateLimit: number
  /** 调用日志 */
  calls: PluginCallLog[]
}

export interface PluginCallLog {
  ts: number
  fn: string
  ok: boolean
  durationMs: number
  message?: string
}

/** 插件调用返回的规范化结果。 */
export interface PluginSearchResult {
  list: Array<{
    id: string
    name: string
    singer: string
    album?: string
    source: string
    interval?: number
    imgurl?: string
    lyric?: string
    [k: string]: unknown
  }>
  total?: number
  limit?: number
  page?: number
}

export interface PluginLyricResult {
  lyric: string
  translation?: string
  /** 是否带时间轴 */
  timed: boolean
}

export interface PluginMeta {
  id: string
  name: string
  version: string
  description?: string
  author?: string
  /** 声明支持的源码 */
  sources: string[]
  qualitys: string[]
}

export interface PluginAdapterInfo {
  id: string
  name: string
  version: string
  description?: string
  author?: string
  sources: string[]
  qualitys: string[]
  /** 不兼容说明 */
  incompatibilities: string[]
}

/** 歌词候选。 */
export interface LyricCandidate {
  id: string
  source: 'local' | 'plugin' | 'musicbrainz' | 'remote'
  pluginId?: string
  title: string
  artist: string
  content: string
  translation?: string
  timed: boolean
  /** 行数 */
  lineCount: number
  /** 时间轴覆盖度 0~1 */
  coverage: number
  /** 质量评分 */
  score: number
}

/** 歌词写入方式。 */
export interface LyricWriteOptions {
  /** 写入内嵌歌词 */
  embedded: boolean
  /** 生成同名 .lrc */
  lrcFile: boolean
  /** 覆盖已有歌词 */
  overwrite: boolean
  /** 歌词偏移毫秒 */
  offsetMs: number
  /** 歌词语言 */
  language?: string
}

/** 扫描结果摘要。 */
export interface ScanSummary {
  batchId: string
  scanned: number
  parsed: number
  failed: number
  issues: number
  durationMs: number
  /** 按扩展名统计 */
  byExtension: Record<string, number>
}

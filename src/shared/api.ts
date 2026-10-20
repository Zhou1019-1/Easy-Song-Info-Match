/**
 * 渲染进程 <-> 主进程 的 API 契约。
 *
 * 所有方法都通过 preload 的 `window.songmatch` 暴露；
 * 主进程在 src/main/ipc/ 下用 ipcMain.handle 实现，频道名一一对应。
 */
import type {
  Candidate,
  FieldSource,
  LyricCandidate,
  LyricWriteOptions,
  OpLogEntry,
  PluginInfo,
  PreviewReport,
  ScanOptions,
  TagValues,
  TaskInfo,
  TrackIssue,
  TrackRecord,
  UndoEntry
} from './types'

export interface LibraryQuery {
  keyword?: string
  /** 需要包含的标签字段（全部非空） */
  requiredFields?: string[]
  /** 需要缺失的标签字段 */
  emptyFields?: string[]
  matchState?: string
  lyricState?: string
  hasIssue?: boolean
  offset?: number
  limit?: number
  sortBy?: string
  sortDir?: 'asc' | 'desc'
}

export interface LibraryPage {
  rows: TrackRecord[]
  total: number
  offset: number
  limit: number
}

export interface MatchQueryResult {
  fileId: number
  query: {
    title: string
    artists: string[]
    album: string | null
    duration: number | null
    year: number | null
  }
  candidates: Candidate[]
  /** 各来源是否成功（失败原因） */
  sourceStatus: Array<{ source: string; ok: boolean; message?: string }>
  /** 命中的缓存（离线可用） */
  fromCache: boolean
}

export interface ApplyFieldSelection {
  fileId: number
  path: string
  /** 语义字段 -> 新值 */
  fields: TagValues
  /** 每个字段的来源 */
  sources: Record<string, FieldSource>
  /** 要清空的字段 */
  clearFields?: string[]
}

export interface WriteExecuteResult {
  batchId: string
  ok: boolean
  written: number
  failed: Array<{ path: string; field?: string; reason: string }>
  /** 音频数据区哈希是否保持不变 */
  audioIntact: boolean
  message: string
}

export interface RenameRule {
  /** 模板，如 {track} {title} {artist} {album} {year} */
  template: string
}

export interface MoveRule {
  /** 归档模板，如 {artist}/{album}/{year} */
  template: string
  /** 移动还是复制 */
  mode: 'move' | 'copy'
}

export interface AliasRuleDto {
  from: string
  to: string
  note?: string
}

export interface PluginCallRequest {
  pluginId: string
  fn: 'search' | 'lyric' | 'albumArt' | 'url'
  keyword?: string
  page?: number
  size?: number
  musicInfo?: Record<string, unknown>
  quality?: string
  source?: string
}

export interface PluginCallResponse {
  ok: boolean
  data?: unknown
  error?: string
  durationMs: number
}

export interface SettingsDto {
  /** 数据目录 */
  dataDir: string
  /** 便携模式 */
  portable: boolean
  /** 插件目录 */
  pluginDir: string
  /** 归档根目录（空 = 使用所选文件的公共祖先目录） */
  archiveRoot: string
  /** 自动采纳阈值 */
  autoAcceptScore: number
  /** 全局歌词偏移（毫秒） */
  globalLyricOffset: number
  /** MusicBrainz 每秒请求上限 */
  mbRateLimit: number
  /** iTunes 每秒请求上限 */
  itunesRateLimit: number
  /** 保护名单（禁止拆分的艺名） */
  protectedArtists: string[]
  /** 免责声明确认状态 */
  disclaimerAccepted: boolean
}

export interface SongMatchApi {
  /* ---------- 库 ---------- */
  libraryList(query: LibraryQuery): Promise<LibraryPage>
  libraryGet(fileId: number): Promise<TrackRecord | null>
  libraryStats(): Promise<{
    total: number
    byMatchState: Record<string, number>
    byLyricState: Record<string, number>
    issues: number
  }>

  /* ---------- 扫描 ---------- */
  scanStart(options: ScanOptions): Promise<{ taskId: string; batchId: string }>
  scanCancel(taskId: string): Promise<void>
  scanPreviewRoots(): Promise<string[]>

  /* ---------- 任务 ---------- */
  taskList(): Promise<TaskInfo[]>
  taskCancel(taskId: string): Promise<void>
  onTaskUpdate(cb: (task: TaskInfo) => void): () => void

  /* ---------- 匹配 ---------- */
  matchQuery(fileIds: number[], force?: boolean): Promise<MatchQueryResult[]>
  matchApplyPreview(items: ApplyFieldSelection[], overwrite: boolean): Promise<PreviewReport>
  matchApplyExecute(items: ApplyFieldSelection[], overwrite: boolean): Promise<WriteExecuteResult>
  matchClear(fileId: number): Promise<void>

  /* ---------- 歌词 ---------- */
  lyricQuery(fileIds: number[]): Promise<Array<{ fileId: number; candidates: LyricCandidate[] }>>
  lyricWrite(
    fileIds: number[],
    candidateIds: Record<number, string>,
    options: LyricWriteOptions
  ): Promise<WriteExecuteResult>
  lyricSetOffset(fileId: number, offsetMs: number): Promise<void>

  /* ---------- 批量操作 ---------- */
  renamePreview(fileIds: number[], rule: RenameRule): Promise<PreviewReport>
  movePreview(fileIds: number[], rule: MoveRule): Promise<PreviewReport>
  aliasPreview(fileIds: number[]): Promise<PreviewReport>
  clearFieldsPreview(fileIds: number[], fields: string[]): Promise<PreviewReport>
  /** 批量重命名执行（预览确认后调用） */
  renameExecute(fileIds: number[], rule: RenameRule): Promise<WriteExecuteResult>
  /** 批量归档移动执行（预览确认后调用） */
  moveExecute(fileIds: number[], rule: MoveRule): Promise<WriteExecuteResult>

  /* ---------- 回滚与日志 ---------- */
  undoList(): Promise<Array<{ batchId: string; opType: string; createdAt: number; count: number; undone: boolean }>>
  undoApply(batchId: string): Promise<{ ok: boolean; message: string; restored: number }>
  opLogList(limit: number): Promise<OpLogEntry[]>
  opLogExportCsv(): Promise<string>
  undoEntries(batchId: string): Promise<UndoEntry[]>

  /* ---------- 插件 ---------- */
  pluginList(): Promise<PluginInfo[]>
  pluginImport(filePath: string): Promise<PluginInfo>
  pluginSetEnabled(pluginId: string, enabled: boolean): Promise<PluginInfo[]>
  pluginDelete(pluginId: string): Promise<PluginInfo[]>
  pluginSetRateLimit(pluginId: string, perMinute: number): Promise<PluginInfo[]>
  pluginCall(req: PluginCallRequest): Promise<PluginCallResponse>
  pluginOpenDir(): Promise<void>

  /* ---------- 别名表 ---------- */
  aliasList(): Promise<AliasRuleDto[]>
  aliasSave(rules: AliasRuleDto[]): Promise<AliasRuleDto[]>
  aliasImport(csv: string): Promise<AliasRuleDto[]>
  aliasExport(): Promise<string>

  /* ---------- 设置 ---------- */
  settingsGet(): Promise<SettingsDto>
  settingsSet(patch: Partial<SettingsDto>): Promise<SettingsDto>

  /* ---------- 异常清单 ---------- */
  issuesList(limit: number): Promise<Array<{ fileId: number; path: string; issues: TrackIssue[] }>>

  /* ---------- 文件选择 ---------- */
  pickDirectories(): Promise<string[]>
  pickFiles(): Promise<string[]>

  /* ---------- 其它 ---------- */
  /** 打开数据目录 */
  openDataDir(): Promise<void>
  /** 应用信息 */
  appInfo(): Promise<{ version: string; dataDir: string; portable: boolean }>
}

declare global {
  interface Window {
    songmatch: SongMatchApi
  }
}

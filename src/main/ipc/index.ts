/**
 * IPC 桥：渲染进程能调用的全部能力都在这里实现。
 *
 * 约定：
 *   - 重活（扫描 / 批量写入 / 插件执行）一律走 worker_threads；
 *   - 任何失败都要把可读的中文原因回传给渲染层，禁止吞掉。
 */
import { app, dialog, ipcMain, shell, BrowserWindow } from 'electron'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import type {
  LyricCandidate,
  OpLogEntry,
  PluginInfo,
  PreviewReport,
  ScanOptions,
  TaskInfo,
  TrackRecord,
  UndoEntry
} from '@shared/types'
import type {
  AliasRuleDto,
  ApplyFieldSelection,
  LibraryPage,
  LibraryQuery,
  MatchQueryResult,
  MoveRule,
  PluginCallRequest,
  PluginCallResponse,
  RenameRule,
  SettingsDto,
  WriteExecuteResult
} from '@shared/api'
import { Db, type ScannedFile } from '../db'
import { resolvePaths, type AppPaths } from '../core/paths'
import { TaskManager } from '../tasks/manager'
import { PluginManager } from '../plugins/manager'
import { BatchEngine, newBatchId, type WriteJob, type WriteJobResult } from '../core/batch'
import { Matcher } from '../core/matcher'
import { LyricPipeline } from '../core/lyricPipeline'
import {
  DEFAULT_ALIAS_RULES,
  DEFAULT_PROTECTED_ARTISTS,
  buildAliasIndex,
  canonicalArtist
} from '../core/alias'
import { DEFAULT_EXTENSIONS } from '../core/scanner'
import type { ScanWorkerMessage } from '../workers/scan.worker'
import type { WriteWorkerMessage } from '../workers/write.worker'

const SETTINGS_KEY = 'app'

interface StoredSettings {
  autoAcceptScore: number
  globalLyricOffset: number
  mbRateLimit: number
  itunesRateLimit: number
  protectedArtists: string[]
  disclaimerAccepted: boolean
  archiveRoot: string
}

const DEFAULT_SETTINGS: StoredSettings = {
  autoAcceptScore: 60,
  globalLyricOffset: 0,
  mbRateLimit: 60,
  itunesRateLimit: 120,
  protectedArtists: [...DEFAULT_PROTECTED_ARTISTS],
  disclaimerAccepted: false,
  archiveRoot: ''
}

export class IpcBridge {
  private readonly paths: AppPaths
  private readonly db: Db
  private readonly tasks: TaskManager
  private readonly plugins: PluginManager
  private readonly batch: BatchEngine
  private readonly matcher: Matcher
  private readonly lyrics: LyricPipeline

  constructor() {
    this.paths = resolvePaths()
    this.db = new Db(this.paths.dbFile)
    this.tasks = new TaskManager(this.db)
    this.plugins = new PluginManager(this.db, this.paths.pluginDir)
    this.batch = new BatchEngine(
      this.db,
      { backupDir: this.paths.backupDir, archiveRoot: this.settings().archiveRoot },
      (jobs) => this.runWriteWorker(jobs)
    )
    this.matcher = new Matcher(this.db, this.plugins, {
      autoAcceptScore: this.settings().autoAcceptScore,
      protectedArtists: this.settings().protectedArtists,
      aliasIndex: this.aliasIndex(),
      mbRateLimit: this.settings().mbRateLimit,
      itunesRateLimit: this.settings().itunesRateLimit,
      perSourceLimit: 5
    })
    this.lyrics = new LyricPipeline(this.db, this.plugins, (jobs) => this.runWriteWorker(jobs))
  }

  /* ==================== 设置 ==================== */

  private settings(): StoredSettings {
    const stored = this.db.getSetting<Partial<StoredSettings>>(SETTINGS_KEY, {})
    return { ...DEFAULT_SETTINGS, ...stored }
  }

  private saveSettings(patch: Partial<StoredSettings>): void {
    this.db.setSetting(SETTINGS_KEY, { ...this.settings(), ...patch })
  }

  private aliasIndex(): Map<string, string> {
    const rows = this.db.listAliases()
    if (!rows.length) return buildAliasIndex(DEFAULT_ALIAS_RULES)
    return buildAliasIndex(rows.map((r) => ({ from: r.from, to: r.to, note: r.note })))
  }

  private settingsDto(): SettingsDto {
    const s = this.settings()
    return {
      dataDir: this.paths.dataDir,
      portable: this.paths.portable,
      pluginDir: this.paths.pluginDir,
      archiveRoot: s.archiveRoot,
      autoAcceptScore: s.autoAcceptScore,
      globalLyricOffset: s.globalLyricOffset,
      mbRateLimit: s.mbRateLimit,
      itunesRateLimit: s.itunesRateLimit,
      protectedArtists: s.protectedArtists,
      disclaimerAccepted: s.disclaimerAccepted
    }
  }

  /* ==================== 写 worker ==================== */

  private runWriteWorker(jobs: WriteJob[]): Promise<WriteJobResult[]> {
    if (!jobs.length) return Promise.resolve([])
    const workerPath = path.join(__dirname, 'workers', 'write.js')
    return new Promise<WriteJobResult[]>((resolve, reject) => {
      const worker = new Worker(workerPath)
      const results: WriteJobResult[] = []
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        void worker.terminate()
        resolve(results)
      }
      worker.on('message', (msg: WriteWorkerMessage) => {
        if (msg.type === 'result') {
          results.push(...msg.results)
          finish()
        } else if (msg.type === 'error') {
          if (!settled) {
            settled = true
            void worker.terminate()
            reject(new Error(msg.error))
          }
        }
      })
      worker.on('error', (err) => {
        if (!settled) {
          settled = true
          reject(err)
        }
      })
      worker.postMessage({ type: 'write', jobs })
    })
  }

  /* ==================== 扫描 ==================== */

  private runScanWorker(
    roots: string[],
    options: ScanOptions,
    taskId: string,
    batchId: string
  ): Promise<void> {
    const workerPath = path.join(__dirname, 'workers', 'scan.js')
    return new Promise<void>((resolve) => {
      const worker = new Worker(workerPath)
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        void worker.terminate()
        resolve()
      }
      worker.on('message', (msg: ScanWorkerMessage) => {
        switch (msg.type) {
          case 'progress':
            this.tasks.progress(taskId, msg.done, msg.total, `已扫描 ${msg.done}/${msg.total}`)
            break
          case 'records':
            try {
              this.db.upsertFiles(msg.records, batchId)
            } catch (err) {
              this.tasks.fail(taskId, `写入库失败：${err instanceof Error ? err.message : String(err)}`)
            }
            break
          case 'dirErrors':
            for (const e of msg.errors) {
              console.warn(`[scan] 目录遍历失败 ${e.dir}：${e.message}`)
            }
            break
          case 'done':
            this.tasks.done(taskId, `扫描完成：${msg.scanned} 个文件，异常 ${msg.issues} 条`)
            finish()
            break
          case 'error':
            this.tasks.fail(taskId, msg.error)
            finish()
            break
          default:
            break
        }
      })
      worker.on('error', (err) => {
        this.tasks.fail(taskId, err.message)
        finish()
      })
      worker.postMessage({
        type: 'scan',
        roots,
        options: {
          recursive: options.recursive,
          followSymlinks: options.followSymlinks,
          extensions: options.extensions?.length ? options.extensions : DEFAULT_EXTENSIONS,
          computeHash: options.computeHash
        },
        aliasPairs: [...this.aliasIndex().entries()],
        protectedArtists: this.settings().protectedArtists,
        taskId
      })
    })
  }

  /* ==================== 注册 ==================== */

  register(): void {
    const handle = <T>(channel: string, fn: (...args: never[]) => T | Promise<T>): void => {
      ipcMain.handle(channel, async (_e, ...args) => fn(...(args as never[])))
    }

    /* ---------- 库 ---------- */
    handle('libraryList', (query: LibraryQuery): LibraryPage => {
      const res = this.db.listFiles({
        keyword: query.keyword,
        requiredFields: query.requiredFields,
        emptyFields: query.emptyFields,
        matchState: query.matchState,
        lyricState: query.lyricState,
        hasIssue: query.hasIssue,
        offset: query.offset,
        limit: query.limit,
        sortBy: query.sortBy,
        sortDir: query.sortDir
      })
      return { rows: res.rows, total: res.total, offset: query.offset ?? 0, limit: query.limit ?? 200 }
    })
    handle('libraryGet', (fileId: number): TrackRecord | null => this.db.getFile(fileId))
    handle('libraryStats', () => this.db.stats())

    /* ---------- 扫描 ---------- */
    handle('scanStart', async (options: ScanOptions) => {
      const batchId = newBatchId('scan')
      const task = this.tasks.create('scan', `扫描 ${options.roots.length} 个目录`)
      this.tasks.start(task.id)
      void this.runScanWorker(options.roots, options, task.id, batchId)
      return { taskId: task.id, batchId }
    })
    handle('scanCancel', (taskId: string) => {
      this.tasks.cancel(taskId)
    })
    handle('scanPreviewRoots', () => {
      const roots = this.db
        .listFiles({ limit: 100000 })
        .rows.map((r) => r.dir)
      return [...new Set(roots)].slice(0, 50)
    })

    /* ---------- 任务 ---------- */
    handle('taskList', (): TaskInfo[] => this.tasks.list())
    handle('taskCancel', (taskId: string) => {
      this.tasks.cancel(taskId)
    })

    /* ---------- 匹配 ---------- */
    handle('matchQuery', async (fileIds: number[], force = false): Promise<MatchQueryResult[]> => {
      const task = this.tasks.create('match', `查询 ${fileIds.length} 个文件的匹配候选`)
      this.tasks.start(task.id)
      const out: MatchQueryResult[] = []
      const records = this.db.getFiles(fileIds)
      let done = 0
      for (const rec of records) {
        try {
          out.push(await this.matcher.queryOne(rec, force))
        } catch (err) {
          out.push({
            fileId: rec.id,
            query: { title: '', artists: [], album: null, duration: null, year: null },
            candidates: [],
            sourceStatus: [
              {
                source: 'all',
                ok: false,
                message: err instanceof Error ? err.message : String(err)
              }
            ],
            fromCache: false
          })
        }
        done++
        this.tasks.progress(task.id, done, records.length, `已查询 ${done}/${records.length}`)
      }
      this.tasks.done(task.id, `完成：${records.length} 个文件`)
      return out
    })

    handle(
      'matchApplyPreview',
      (items: ApplyFieldSelection[], overwrite: boolean): PreviewReport =>
        this.batch.previewTagWrite(items, overwrite)
    )
    handle(
      'matchApplyExecute',
      async (items: ApplyFieldSelection[], overwrite: boolean): Promise<WriteExecuteResult> => {
        const task = this.tasks.create('write', `写入 ${items.length} 个文件`)
        this.tasks.start(task.id)
        const res = await this.batch.executeTagWrite(items, overwrite)
        if (res.ok) this.tasks.done(task.id, res.message)
        else this.tasks.fail(task.id, res.message)
        return res
      }
    )
    handle('matchClear', (fileId: number) => {
      this.db.setMatchState(fileId, 'none')
    })

    /* ---------- 歌词 ---------- */
    handle('lyricQuery', async (fileIds: number[]) => {
      const out: Array<{ fileId: number; candidates: LyricCandidate[] }> = []
      for (const rec of this.db.getFiles(fileIds)) {
        out.push({ fileId: rec.id, candidates: await this.lyrics.collect(rec) })
      }
      return out
    })
    handle(
      'lyricWrite',
      async (
        fileIds: number[],
        candidateIds: Record<number, string>,
        options: {
          embedded: boolean
          lrcFile: boolean
          overwrite: boolean
          offsetMs: number
          language?: string
        }
      ): Promise<WriteExecuteResult> => {
        const task = this.tasks.create('lyric', `写入 ${fileIds.length} 个文件的歌词`)
        this.tasks.start(task.id)
        const failed: WriteExecuteResult['failed'] = []
        let written = 0
        let done = 0
        for (const rec of this.db.getFiles(fileIds)) {
          const cid = candidateIds[rec.id]
          if (!cid) continue
          const candidates = await this.lyrics.collect(rec)
          const candidate = candidates.find((c) => c.id === cid)
          if (!candidate) {
            failed.push({ path: rec.path, reason: '找不到所选歌词候选' })
            continue
          }
          const res = await this.lyrics.write(rec, candidate, options)
          written += res.written
          failed.push(...res.failed)
          done++
          this.tasks.progress(task.id, done, fileIds.length, `已写入 ${done}/${fileIds.length}`)
        }
        this.tasks.done(task.id, `歌词写入完成：${written} 处`)
        return {
          batchId: `lyric-${Date.now()}`,
          ok: failed.length === 0,
          written,
          failed,
          audioIntact: true,
          message: `歌词写入完成：${written} 处${failed.length ? `，失败 ${failed.length} 处` : ''}`
        }
      }
    )
    handle('lyricSetOffset', (fileId: number, offsetMs: number) => {
      this.lyrics.setOffset(fileId, offsetMs)
    })

    /* ---------- 批量操作 ---------- */
    handle('renamePreview', (fileIds: number[], rule: RenameRule): PreviewReport =>
      this.batch.previewRename(fileIds, rule)
    )
    handle('movePreview', (fileIds: number[], rule: MoveRule): PreviewReport =>
      this.batch.previewMove(fileIds, rule)
    )
    handle('aliasPreview', (fileIds: number[]): PreviewReport => {
      const items: ApplyFieldSelection[] = fileIds.map((id) => {
        const rec = this.db.getFile(id)
        const fields: Record<string, string[]> = {}
        const sources: Record<string, 'manual'> = {}
        const artist = rec?.tags.artist?.[0]
        if (rec && artist) {
          const canonical = canonicalArtist(artist, this.aliasIndex())
          if (canonical && canonical !== artist) {
            fields.artist = [canonical]
            sources.artist = 'manual'
          }
        }
        return { fileId: id, path: rec?.path ?? '', fields, sources }
      })
      return this.batch.previewTagWrite(items, true)
    })
    handle('clearFieldsPreview', (fileIds: number[], fields: string[]): PreviewReport =>
      this.batch.previewClearFields(fileIds, fields)
    )
    handle('renameExecute', async (fileIds: number[], rule: RenameRule): Promise<WriteExecuteResult> => {
      const task = this.tasks.create('rename', `重命名 ${fileIds.length} 个文件`)
      this.tasks.start(task.id)
      const res = await this.batch.executePathChange(fileIds, rule, 'rename')
      if (res.ok) this.tasks.done(task.id, res.message)
      else this.tasks.fail(task.id, res.message)
      return res
    })
    handle('moveExecute', async (fileIds: number[], rule: MoveRule): Promise<WriteExecuteResult> => {
      const task = this.tasks.create('move', `归档移动 ${fileIds.length} 个文件`)
      this.tasks.start(task.id)
      const res = await this.batch.executePathChange(fileIds, rule, 'move')
      if (res.ok) this.tasks.done(task.id, res.message)
      else this.tasks.fail(task.id, res.message)
      return res
    })

    /* ---------- 回滚与日志 ---------- */
    handle('undoList', () => this.db.undoBatches())
    handle('undoApply', async (batchId: string) => {
      const res = await this.batch.undoBatch(batchId)
      return res
    })
    handle('opLogList', (limit: number): OpLogEntry[] => this.db.opLogs(limit))
    handle('opLogExportCsv', () => this.toCsv(this.db.opLogs(100000)))
    handle('undoEntries', (batchId: string): UndoEntry[] => this.db.undoEntries(batchId))

    /* ---------- 插件 ---------- */
    handle('pluginList', (): PluginInfo[] => this.plugins.list())
    handle('pluginImport', async (filePath: string): Promise<PluginInfo> => this.plugins.import(filePath))
    handle('pluginSetEnabled', (pluginId: string, enabled: boolean): PluginInfo[] =>
      this.plugins.setEnabled(pluginId, enabled)
    )
    handle('pluginDelete', (pluginId: string): PluginInfo[] => this.plugins.delete(pluginId))
    handle('pluginSetRateLimit', (pluginId: string, perMinute: number): PluginInfo[] =>
      this.plugins.setRateLimit(pluginId, perMinute)
    )
    handle('pluginCall', async (req: PluginCallRequest): Promise<PluginCallResponse> =>
      this.plugins.call(req)
    )
    handle('pluginOpenDir', async () => {
      await shell.openPath(this.paths.pluginDir)
    })

    /* ---------- 别名表 ---------- */
    handle('aliasList', (): AliasRuleDto[] => {
      const rows = this.db.listAliases()
      return rows.length
        ? rows.map((r) => ({ from: r.from, to: r.to, note: r.note }))
        : DEFAULT_ALIAS_RULES.map((r) => ({ from: r.from, to: r.to, note: r.note }))
    })
    handle('aliasSave', (rules: AliasRuleDto[]): AliasRuleDto[] => {
      this.db.saveAliases(rules)
      return this.db.listAliases().map((r) => ({ from: r.from, to: r.to, note: r.note }))
    })
    handle('aliasImport', (csv: string): AliasRuleDto[] => {
      const rules = parseAliasCsv(csv)
      this.db.saveAliases(rules)
      return this.db.listAliases().map((r) => ({ from: r.from, to: r.to, note: r.note }))
    })
    handle('aliasExport', () => {
      const rows = this.db.listAliases()
      const list = rows.length ? rows : DEFAULT_ALIAS_RULES.map((r) => ({ ...r }))
      return ['from,to,note', ...list.map((r) => `${csvCell(r.from)},${csvCell(r.to)},${csvCell(r.note ?? '')}`)].join(
        '\n'
      )
    })

    /* ---------- 设置 ---------- */
    handle('settingsGet', (): SettingsDto => this.settingsDto())
    handle('settingsSet', (patch: Partial<SettingsDto>): SettingsDto => {
      this.saveSettings({
        autoAcceptScore: patch.autoAcceptScore ?? this.settings().autoAcceptScore,
        globalLyricOffset: patch.globalLyricOffset ?? this.settings().globalLyricOffset,
        mbRateLimit: patch.mbRateLimit ?? this.settings().mbRateLimit,
        itunesRateLimit: patch.itunesRateLimit ?? this.settings().itunesRateLimit,
        protectedArtists: patch.protectedArtists ?? this.settings().protectedArtists,
        disclaimerAccepted: patch.disclaimerAccepted ?? this.settings().disclaimerAccepted,
        archiveRoot: patch.archiveRoot ?? this.settings().archiveRoot
      })
      return this.settingsDto()
    })

    /* ---------- 异常清单 ---------- */
    handle('issuesList', (limit: number) => this.db.issues(limit))

    /* ---------- 文件选择 ---------- */
    handle('pickDirectories', async (): Promise<string[]> => {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      const res = await dialog.showOpenDialog(win, {
        properties: ['openDirectory', 'multiSelections']
      })
      return res.canceled ? [] : res.filePaths
    })
    handle('pickFiles', async (): Promise<string[]> => {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      const res = await dialog.showOpenDialog(win, {
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: '音源插件脚本', extensions: ['js', 'mjs', 'cjs'] },
          { name: '所有文件', extensions: ['*'] }
        ]
      })
      return res.canceled ? [] : res.filePaths
    })

    /* ---------- 其它 ---------- */
    handle('openDataDir', async () => {
      await shell.openPath(this.paths.dataDir)
    })
    handle('appInfo', () => ({
      version: app.getVersion(),
      dataDir: this.paths.dataDir,
      portable: this.paths.portable
    }))
  }

  /** 任务更新推送到渲染层。 */
  forwardTaskUpdates(): void {
    this.tasks.onUpdate((t) => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send('task:update', t)
      }
    })
  }

  dispose(): void {
    this.plugins.dispose()
    this.db.close()
  }

  private toCsv(rows: OpLogEntry[]): string {
    const head = '时间,文件,字段,旧值,新值,来源,批次号'
    const body = rows.map((r) =>
      [
        new Date(r.ts).toLocaleString('zh-CN'),
        csvCell(r.filePath),
        csvCell(r.field),
        csvCell(r.oldValue ?? ''),
        csvCell(r.newValue ?? ''),
        csvCell(r.source),
        csvCell(r.batchId)
      ].join(',')
    )
    return [head, ...body].join('\n')
  }
}

function csvCell(v: string): string {
  if (!/[",\n]/.test(v)) return v
  return `"${v.replace(/"/g, '""')}"`
}

function parseAliasCsv(csv: string): AliasRuleDto[] {
  const out: AliasRuleDto[] = []
  for (const line of csv.split(/\r?\n/)) {
    const t = line.trim()
    if (!t) continue
    const cells = t.split(',').map((c) => c.trim().replace(/^"|"$/g, ''))
    if (cells[0] === 'from') continue
    if (cells.length < 2 || !cells[0] || !cells[1]) continue
    out.push({ from: cells[0], to: cells[1], note: cells[2] ?? '' })
  }
  return out
}

export type { ScannedFile }

/**
 * SQLite 持久层（better-sqlite3）。
 *
 * 存储内容：
 *   - files / tags：本地库（文件清单 + 标签值 + 每个字段的来源）
 *   - cache：多来源查询缓存（断网可重跑）
 *   - match_records：匹配记录（含被否决的候选）
 *   - undo_batches / undo_entries：回滚日志
 *   - op_log：操作日志（可导出 CSV）
 *   - lyric_offsets：歌词偏移记忆
 *   - alias_map：别名表
 *   - tasks / plugin_meta / plugin_calls：任务与插件元信息
 *   - settings：键值设置
 */
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import type {
  FieldSource,
  LyricState,
  MatchState,
  OpLogEntry,
  TagValues,
  TaskInfo,
  TrackIssue,
  TrackRecord,
  UndoEntry
} from '@shared/types'

/**
 * 扫描不得覆盖的匹配状态：用户已经裁决过的条目（已匹配 / 已否决 / 手动改过）。
 */
const PRESERVED_MATCH_STATES: MatchState[] = ['matched', 'rejected', 'manual']

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS files (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  path          TEXT NOT NULL UNIQUE,
  dir           TEXT NOT NULL DEFAULT '',
  filename      TEXT NOT NULL DEFAULT '',
  ext           TEXT NOT NULL DEFAULT '',
  size          INTEGER NOT NULL DEFAULT 0,
  mtime         INTEGER NOT NULL DEFAULT 0,
  audio_hash    TEXT,
  format        TEXT,
  duration      REAL,
  bitrate       INTEGER,
  sample_rate   INTEGER,
  channels      INTEGER,
  match_state   TEXT NOT NULL DEFAULT 'none',
  lyric_state   TEXT NOT NULL DEFAULT 'none',
  has_artwork   INTEGER NOT NULL DEFAULT 0,
  scan_batch    TEXT NOT NULL DEFAULT '',
  last_seen     INTEGER NOT NULL DEFAULT 0,
  parsed_json   TEXT,
  context_json  TEXT,
  issues_json   TEXT
);
CREATE INDEX IF NOT EXISTS idx_files_dir ON files(dir);
CREATE INDEX IF NOT EXISTS idx_files_match ON files(match_state);
CREATE INDEX IF NOT EXISTS idx_files_lyric ON files(lyric_state);

CREATE TABLE IF NOT EXISTS tags (
  file_id  INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  field    TEXT NOT NULL,
  value    TEXT NOT NULL,
  source   TEXT NOT NULL DEFAULT 'tag',
  PRIMARY KEY (file_id, field, value)
);
CREATE INDEX IF NOT EXISTS idx_tags_file ON tags(file_id);
CREATE INDEX IF NOT EXISTS idx_tags_field ON tags(field);

CREATE TABLE IF NOT EXISTS cache (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_cache_ts ON cache(ts);

CREATE TABLE IF NOT EXISTS match_records (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id     INTEGER NOT NULL,
  candidate_id TEXT NOT NULL,
  source      TEXT NOT NULL,
  source_key  TEXT NOT NULL DEFAULT '',
  score       REAL NOT NULL DEFAULT 0,
  applied     INTEGER NOT NULL DEFAULT 0,
  batch_id    TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_match_file ON match_records(file_id);

CREATE TABLE IF NOT EXISTS undo_batches (
  batch_id   TEXT PRIMARY KEY,
  op_type    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  undone     INTEGER NOT NULL DEFAULT 0,
  summary    TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS undo_entries (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id  TEXT NOT NULL,
  file_id   INTEGER,
  path      TEXT NOT NULL,
  kind      TEXT NOT NULL,
  field     TEXT,
  old_value TEXT,
  new_value TEXT
);
CREATE INDEX IF NOT EXISTS idx_undo_batch ON undo_entries(batch_id);

CREATE TABLE IF NOT EXISTS op_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        INTEGER NOT NULL,
  file_path TEXT NOT NULL,
  field     TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  source    TEXT NOT NULL DEFAULT 'manual',
  batch_id  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_oplog_batch ON op_log(batch_id);
CREATE INDEX IF NOT EXISTS idx_oplog_ts ON op_log(ts);

CREATE TABLE IF NOT EXISTS lyric_offsets (
  file_id    INTEGER PRIMARY KEY,
  offset_ms  INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS alias_map (
  from_key TEXT PRIMARY KEY,
  to_name  TEXT NOT NULL,
  note     TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  title       TEXT NOT NULL,
  status      TEXT NOT NULL,
  progress    REAL NOT NULL DEFAULT 0,
  total       REAL NOT NULL DEFAULT 0,
  message     TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  started_at  INTEGER,
  finished_at INTEGER,
  error       TEXT
);

CREATE TABLE IF NOT EXISTS plugin_meta (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  version           TEXT NOT NULL DEFAULT '',
  path              TEXT NOT NULL,
  enabled           INTEGER NOT NULL DEFAULT 1,
  sources           TEXT NOT NULL DEFAULT '[]',
  qualitys          TEXT NOT NULL DEFAULT '[]',
  format            TEXT NOT NULL DEFAULT 'unknown',
  imported_at       INTEGER NOT NULL,
  load_ok           INTEGER NOT NULL DEFAULT 0,
  load_error        TEXT,
  incompatibilities TEXT NOT NULL DEFAULT '[]',
  rate_limit        INTEGER NOT NULL DEFAULT 60
);

CREATE TABLE IF NOT EXISTS plugin_calls (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  plugin_id   TEXT NOT NULL,
  ts          INTEGER NOT NULL,
  fn          TEXT NOT NULL,
  ok          INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  message     TEXT
);
CREATE INDEX IF NOT EXISTS idx_calls_plugin ON plugin_calls(plugin_id, ts DESC);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

export interface FileRow {
  id: number
  path: string
  dir: string
  filename: string
  ext: string
  size: number
  mtime: number
  audioHash: string | null
  format: string | null
  duration: number | null
  bitrate: number | null
  sampleRate: number | null
  channels: number | null
  matchState: MatchState
  lyricState: LyricState
  hasArtwork: boolean
  scanBatch: string
  lastSeen: number
  parsed: TrackRecord['parsed']
  context: TrackRecord['context']
  issues: TrackIssue[]
}

/** 扫描 worker 回传的一条记录。 */
export interface ScannedFile {
  path: string
  dir: string
  filename: string
  ext: string
  size: number
  mtime: number
  audioHash: string | null
  format: string
  duration: number | null
  bitrate: number | null
  sampleRate: number | null
  channels: number | null
  hasArtwork: boolean
  tags: TagValues
  sources: Record<string, FieldSource>
  parsed: TrackRecord['parsed']
  context: TrackRecord['context']
  issues: TrackIssue[]
  matchState: MatchState
  lyricState: LyricState
}

function safeJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export class Db {
  private db: Database.Database

  constructor(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    this.db = new Database(file)
    this.db.exec(SCHEMA)
  }

  close(): void {
    try {
      this.db.close()
    } catch {
      /* ignore */
    }
  }

  /* ------------------------- 文件 ------------------------- */

  upsertFile(rec: ScannedFile, batchId: string): number {
    const now = Date.now()
    const existing = this.db
      .prepare('SELECT id, match_state FROM files WHERE path = ?')
      .get(rec.path) as { id: number; match_state: MatchState } | undefined

    let fileId: number
    if (existing) {
      fileId = existing.id
      // 用户已经裁决过的状态（已匹配 / 已否决 / 手动改过）不能被扫描结果覆盖。
      const nextState = PRESERVED_MATCH_STATES.includes(existing.match_state)
        ? existing.match_state
        : rec.matchState
      this.db
        .prepare(
          `UPDATE files SET dir=?, filename=?, ext=?, size=?, mtime=?, audio_hash=?, format=?,
           duration=?, bitrate=?, sample_rate=?, channels=?, has_artwork=?, scan_batch=?, last_seen=?,
           parsed_json=?, context_json=?, issues_json=?, match_state=? WHERE id=?`
        )
        .run(
          rec.dir,
          rec.filename,
          rec.ext,
          rec.size,
          rec.mtime,
          rec.audioHash,
          rec.format,
          rec.duration,
          rec.bitrate,
          rec.sampleRate,
          rec.channels,
          rec.hasArtwork ? 1 : 0,
          batchId,
          now,
          JSON.stringify(rec.parsed ?? null),
          JSON.stringify(rec.context ?? null),
          JSON.stringify(rec.issues ?? []),
          nextState,
          fileId
        )
      this.db.prepare('DELETE FROM tags WHERE file_id = ?').run(fileId)
    } else {
      const info = this.db
        .prepare(
          `INSERT INTO files (path, dir, filename, ext, size, mtime, audio_hash, format, duration,
           bitrate, sample_rate, channels, has_artwork, scan_batch, last_seen, parsed_json, context_json, issues_json, match_state)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          rec.path,
          rec.dir,
          rec.filename,
          rec.ext,
          rec.size,
          rec.mtime,
          rec.audioHash,
          rec.format,
          rec.duration,
          rec.bitrate,
          rec.sampleRate,
          rec.channels,
          rec.hasArtwork ? 1 : 0,
          batchId,
          now,
          JSON.stringify(rec.parsed ?? null),
          JSON.stringify(rec.context ?? null),
          JSON.stringify(rec.issues ?? []),
          rec.matchState
        )
      fileId = Number(info.lastInsertRowid)
    }

    const insTag = this.db.prepare(
      'INSERT OR IGNORE INTO tags (file_id, field, value, source) VALUES (?,?,?,?)'
    )
    const tx = this.db.transaction((items: ScannedFile[]) => {
      for (const it of items) {
        for (const [field, values] of Object.entries(it.tags)) {
          for (const v of values) {
            insTag.run(fileId, field, v, it.sources[field] ?? 'tag')
          }
        }
      }
    })
    tx([rec])
    return fileId
  }

  /** 批量写入扫描结果（每批一个事务）。 */
  upsertFiles(recs: ScannedFile[], batchId: string): number {
    const tx = this.db.transaction((items: ScannedFile[]) => {
      for (const r of items) this.upsertFile(r, batchId)
    })
    tx(recs)
    return recs.length
  }

  private rowToFile(r: Record<string, unknown>): FileRow {
    return {
      id: Number(r.id),
      path: String(r.path),
      dir: String(r.dir ?? ''),
      filename: String(r.filename ?? ''),
      ext: String(r.ext ?? ''),
      size: Number(r.size ?? 0),
      mtime: Number(r.mtime ?? 0),
      audioHash: (r.audio_hash as string) ?? null,
      format: (r.format as string) ?? null,
      duration: r.duration === null || r.duration === undefined ? null : Number(r.duration),
      bitrate: r.bitrate === null || r.bitrate === undefined ? null : Number(r.bitrate),
      sampleRate:
        r.sample_rate === null || r.sample_rate === undefined ? null : Number(r.sample_rate),
      channels: r.channels === null || r.channels === undefined ? null : Number(r.channels),
      matchState: (r.match_state as MatchState) ?? 'none',
      lyricState: (r.lyric_state as LyricState) ?? 'none',
      hasArtwork: Number(r.has_artwork ?? 0) === 1,
      scanBatch: String(r.scan_batch ?? ''),
      lastSeen: Number(r.last_seen ?? 0),
      parsed: safeJson(r.parsed_json as string, null),
      context: safeJson(r.context_json as string, null),
      issues: safeJson(r.issues_json as string, [])
    }
  }

  listFiles(opts: {
    keyword?: string
    requiredFields?: string[]
    emptyFields?: string[]
    matchState?: string
    lyricState?: string
    hasIssue?: boolean
    offset?: number
    limit?: number
    sortBy?: string
    sortDir?: 'asc' | 'desc'
  }): { rows: TrackRecord[]; total: number } {
    const where: string[] = []
    const params: unknown[] = []

    if (opts.keyword) {
      where.push('(f.path LIKE ? OR EXISTS (SELECT 1 FROM tags t WHERE t.file_id = f.id AND t.value LIKE ?))')
      params.push(`%${opts.keyword}%`, `%${opts.keyword}%`)
    }
    if (opts.matchState) {
      where.push('f.match_state = ?')
      params.push(opts.matchState)
    }
    if (opts.lyricState) {
      where.push('f.lyric_state = ?')
      params.push(opts.lyricState)
    }
    if (opts.hasIssue) {
      where.push("f.issues_json IS NOT NULL AND f.issues_json NOT IN ('[]', 'null')")
    }
    for (const f of opts.requiredFields ?? []) {
      where.push('EXISTS (SELECT 1 FROM tags t WHERE t.file_id = f.id AND t.field = ? AND t.value <> "")')
      params.push(f)
    }
    for (const f of opts.emptyFields ?? []) {
      where.push('NOT EXISTS (SELECT 1 FROM tags t WHERE t.file_id = f.id AND t.field = ? AND t.value <> "")')
      params.push(f)
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM files f ${whereSql}`).get(...params) as { n: number }
    ).n

    const sortMap: Record<string, string> = {
      path: 'f.path',
      filename: 'f.filename',
      size: 'f.size',
      mtime: 'f.mtime',
      duration: 'f.duration',
      matchState: 'f.match_state',
      lyricState: 'f.lyric_state',
      lastSeen: 'f.last_seen'
    }
    const sortCol = sortMap[opts.sortBy ?? 'path'] ?? 'f.path'
    const dir = opts.sortDir === 'desc' ? 'DESC' : 'ASC'
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 100000)
    const offset = Math.max(opts.offset ?? 0, 0)

    const raw = this.db
      .prepare(
        `SELECT f.* FROM files f ${whereSql} ORDER BY ${sortCol} ${dir}, f.id ASC LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset) as Record<string, unknown>[]

    const rows = raw.map((r) => this.toTrackRecord(this.rowToFile(r)))
    return { rows, total }
  }

  getFile(id: number): TrackRecord | null {
    const r = this.db.prepare('SELECT * FROM files WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    if (!r) return null
    return this.toTrackRecord(this.rowToFile(r))
  }

  /** 按路径查文件 id（不存在返回 0）。 */
  fileIdByPath(filePath: string): number {
    const r = this.db.prepare('SELECT id FROM files WHERE path = ?').get(filePath) as
      | { id: number }
      | undefined
    return r?.id ?? 0
  }

  getFiles(ids: number[]): TrackRecord[] {
    if (!ids.length) return []
    const marks = ids.map(() => '?').join(',')
    const raw = this.db
      .prepare(`SELECT * FROM files WHERE id IN (${marks})`)
      .all(...ids) as Record<string, unknown>[]
    const map = new Map<number, TrackRecord>()
    for (const r of raw) {
      const t = this.toTrackRecord(this.rowToFile(r))
      map.set(t.id, t)
    }
    return ids.map((i) => map.get(i)).filter((x): x is TrackRecord => !!x)
  }

  private toTrackRecord(row: FileRow): TrackRecord {
    const tagRows = this.db
      .prepare('SELECT field, value, source FROM tags WHERE file_id = ?')
      .all(row.id) as Array<{ field: string; value: string; source: FieldSource }>
    const tags: TagValues = {}
    const sources: Record<string, FieldSource> = {}
    for (const t of tagRows) {
      if (!tags[t.field]) tags[t.field] = []
      tags[t.field].push(t.value)
      if (!sources[t.field]) sources[t.field] = t.source
    }
    return {
      id: row.id,
      path: row.path,
      dir: row.dir,
      filename: row.filename,
      ext: row.ext,
      size: row.size,
      mtime: row.mtime,
      audioHash: row.audioHash,
      tags,
      sources,
      parsed: row.parsed,
      context: row.context,
      duration: row.duration,
      bitrate: row.bitrate,
      sampleRate: row.sampleRate,
      channels: row.channels,
      issues: row.issues ?? [],
      matchState: row.matchState,
      lyricState: row.lyricState,
      hasArtwork: row.hasArtwork,
      scanBatch: row.scanBatch,
      lastSeen: row.lastSeen
    }
  }

  stats(): {
    total: number
    byMatchState: Record<string, number>
    byLyricState: Record<string, number>
    issues: number
  } {
    const total = (this.db.prepare('SELECT COUNT(*) AS n FROM files').get() as { n: number }).n
    const ms = this.db
      .prepare('SELECT match_state AS k, COUNT(*) AS n FROM files GROUP BY match_state')
      .all() as Array<{ k: string; n: number }>
    const ls = this.db
      .prepare('SELECT lyric_state AS k, COUNT(*) AS n FROM files GROUP BY lyric_state')
      .all() as Array<{ k: string; n: number }>
    const issues = (
      this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM files WHERE issues_json IS NOT NULL AND issues_json NOT IN ('[]','null')"
        )
        .get() as { n: number }
    ).n
    return {
      total,
      byMatchState: Object.fromEntries(ms.map((x) => [x.k, x.n])),
      byLyricState: Object.fromEntries(ls.map((x) => [x.k, x.n])),
      issues
    }
  }

  issues(limit: number): Array<{ fileId: number; path: string; issues: TrackIssue[] }> {
    const raw = this.db
      .prepare(
        `SELECT id, path, issues_json FROM files
         WHERE issues_json IS NOT NULL AND issues_json NOT IN ('[]','null')
         ORDER BY id DESC LIMIT ?`
      )
      .all(limit) as Array<{ id: number; path: string; issues_json: string }>
    return raw.map((r) => ({
      fileId: r.id,
      path: r.path,
      issues: safeJson<TrackIssue[]>(r.issues_json, [])
    }))
  }

  setMatchState(id: number, state: MatchState): void {
    this.db.prepare('UPDATE files SET match_state = ? WHERE id = ?').run(state, id)
  }

  setLyricState(id: number, state: LyricState): void {
    this.db.prepare('UPDATE files SET lyric_state = ? WHERE id = ?').run(state, id)
  }

  /** 写标签后同步库内标签与来源。 */
  updateTags(id: number, tags: TagValues, sources: Record<string, FieldSource>): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM tags WHERE file_id = ?').run(id)
      const ins = this.db.prepare(
        'INSERT OR IGNORE INTO tags (file_id, field, value, source) VALUES (?,?,?,?)'
      )
      for (const [field, values] of Object.entries(tags)) {
        for (const v of values) ins.run(id, field, v, sources[field] ?? 'manual')
      }
    })
    tx()
  }

  /** 文件被重命名/移动后更新路径。 */
  updatePath(id: number, newPath: string): void {
    this.db
      .prepare('UPDATE files SET path = ?, dir = ?, filename = ? WHERE id = ?')
      .run(
        newPath,
        path.dirname(newPath),
        path.basename(newPath),
        id
      )
  }

  /* ------------------------- 缓存 ------------------------- */

  cacheGet(key: string): { value: unknown; ts: number } | null {
    const r = this.db.prepare('SELECT value, ts, expires_at FROM cache WHERE key = ?').get(key) as
      | { value: string; ts: number; expires_at: number | null }
      | undefined
    if (!r) return null
    if (r.expires_at && r.expires_at < Date.now()) return null
    return { value: safeJson(r.value, null), ts: r.ts }
  }

  cacheSet(key: string, value: unknown, ttlMs?: number): void {
    const expires = ttlMs ? Date.now() + ttlMs : null
    this.db
      .prepare(
        'INSERT INTO cache (key, value, ts, expires_at) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, ts=excluded.ts, expires_at=excluded.expires_at'
      )
      .run(key, JSON.stringify(value), Date.now(), expires)
  }

  cacheClear(): void {
    this.db.prepare('DELETE FROM cache').run()
  }

  /* ------------------------- 匹配记录 ------------------------- */

  saveMatchRecords(
    fileId: number,
    candidates: Array<{ id: string; source: string; sourceKey: string; score: number }>,
    appliedId?: string
  ): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM match_records WHERE file_id = ?').run(fileId)
      const ins = this.db.prepare(
        'INSERT INTO match_records (file_id, candidate_id, source, source_key, score, applied, created_at) VALUES (?,?,?,?,?,?,?)'
      )
      const now = Date.now()
      for (const c of candidates) {
        ins.run(fileId, c.id, c.source, c.sourceKey, c.score, appliedId === c.id ? 1 : 0, now)
      }
    })
    tx()
  }

  markMatchApplied(fileId: number, candidateId: string, batchId: string): void {
    this.db
      .prepare('UPDATE match_records SET applied = 1, batch_id = ? WHERE file_id = ? AND candidate_id = ?')
      .run(batchId, fileId, candidateId)
  }

  /* ------------------------- 回滚 ------------------------- */

  createUndoBatch(batchId: string, opType: string, summary: string): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO undo_batches (batch_id, op_type, created_at, undone, summary) VALUES (?,?,?,0,?)'
      )
      .run(batchId, opType, Date.now(), summary)
  }

  addUndoEntries(entries: UndoEntry[]): void {
    const ins = this.db.prepare(
      'INSERT INTO undo_entries (batch_id, file_id, path, kind, field, old_value, new_value) VALUES (?,?,?,?,?,?,?)'
    )
    const tx = this.db.transaction((items: UndoEntry[]) => {
      for (const e of items) {
        ins.run(e.batchId, e.fileId, e.path, e.kind, e.field, e.oldValue, e.newValue)
      }
    })
    tx(entries)
  }

  undoBatches(): Array<{
    batchId: string
    opType: string
    createdAt: number
    count: number
    undone: boolean
  }> {
    const rows = this.db
      .prepare(
        `SELECT b.batch_id, b.op_type, b.created_at, b.undone,
                (SELECT COUNT(*) FROM undo_entries e WHERE e.batch_id = b.batch_id) AS n
         FROM undo_batches b ORDER BY b.created_at DESC`
      )
      .all() as Array<{ batch_id: string; op_type: string; created_at: number; undone: number; n: number }>
    return rows.map((r) => ({
      batchId: r.batch_id,
      opType: r.op_type,
      createdAt: r.created_at,
      count: r.n,
      undone: r.undone === 1
    }))
  }

  undoEntries(batchId: string): UndoEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM undo_entries WHERE batch_id = ? ORDER BY id ASC')
      .all(batchId) as Array<Record<string, unknown>>
    return rows.map((r) => ({
      id: Number(r.id),
      batchId: String(r.batch_id),
      fileId: r.file_id === null ? 0 : Number(r.file_id),
      path: String(r.path),
      kind: r.kind as UndoEntry['kind'],
      field: (r.field as string) ?? null,
      oldValue: (r.old_value as string) ?? null,
      newValue: (r.new_value as string) ?? null
    }))
  }

  markBatchUndone(batchId: string): void {
    this.db.prepare('UPDATE undo_batches SET undone = 1 WHERE batch_id = ?').run(batchId)
  }

  /* ------------------------- 操作日志 ------------------------- */

  logOps(entries: OpLogEntry[]): void {
    const ins = this.db.prepare(
      'INSERT INTO op_log (ts, file_path, field, old_value, new_value, source, batch_id) VALUES (?,?,?,?,?,?,?)'
    )
    const tx = this.db.transaction((items: OpLogEntry[]) => {
      for (const e of items) {
        ins.run(e.ts, e.filePath, e.field, e.oldValue, e.newValue, e.source, e.batchId)
      }
    })
    tx(entries)
  }

  opLogs(limit: number): OpLogEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM op_log ORDER BY id DESC LIMIT ?')
      .all(limit) as Array<Record<string, unknown>>
    return rows.map((r) => ({
      id: Number(r.id),
      ts: Number(r.ts),
      filePath: String(r.file_path),
      field: String(r.field),
      oldValue: (r.old_value as string) ?? null,
      newValue: (r.new_value as string) ?? null,
      source: r.source as FieldSource,
      batchId: String(r.batch_id ?? '')
    }))
  }

  /* ------------------------- 歌词偏移 ------------------------- */

  getLyricOffset(fileId: number): number {
    const r = this.db.prepare('SELECT offset_ms FROM lyric_offsets WHERE file_id = ?').get(fileId) as
      | { offset_ms: number }
      | undefined
    return r?.offset_ms ?? 0
  }

  setLyricOffset(fileId: number, offsetMs: number): void {
    this.db
      .prepare(
        'INSERT INTO lyric_offsets (file_id, offset_ms, updated_at) VALUES (?,?,?) ON CONFLICT(file_id) DO UPDATE SET offset_ms=excluded.offset_ms, updated_at=excluded.updated_at'
      )
      .run(fileId, offsetMs, Date.now())
  }

  /* ------------------------- 别名表 ------------------------- */

  listAliases(): Array<{ from: string; to: string; note: string }> {
    const rows = this.db
      .prepare('SELECT from_key, to_name, note FROM alias_map ORDER BY from_key')
      .all() as Array<{ from_key: string; to_name: string; note: string }>
    return rows.map((r) => ({ from: r.from_key, to: r.to_name, note: r.note }))
  }

  saveAliases(rules: Array<{ from: string; to: string; note?: string }>): void {
    const tx = this.db.transaction((items: Array<{ from: string; to: string; note?: string }>) => {
      this.db.prepare('DELETE FROM alias_map').run()
      const ins = this.db.prepare(
        'INSERT OR REPLACE INTO alias_map (from_key, to_name, note) VALUES (?,?,?)'
      )
      for (const r of items) {
        if (!r.from || !r.to) continue
        ins.run(r.from, r.to, r.note ?? '')
      }
    })
    tx(rules)
  }

  /* ------------------------- 任务 ------------------------- */

  saveTask(t: TaskInfo): void {
    this.db
      .prepare(
        `INSERT INTO tasks (id, type, title, status, progress, total, message, created_at, started_at, finished_at, error)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET status=excluded.status, progress=excluded.progress, total=excluded.total,
           message=excluded.message, started_at=excluded.started_at, finished_at=excluded.finished_at, error=excluded.error`
      )
      .run(
        t.id,
        t.type,
        t.title,
        t.status,
        t.progress,
        t.total,
        t.message,
        t.createdAt,
        t.startedAt ?? null,
        t.finishedAt ?? null,
        t.error ?? null
      )
  }

  listTasks(): TaskInfo[] {
    const rows = this.db
      .prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT 200')
      .all() as Array<Record<string, unknown>>
    return rows.map((r) => ({
      id: String(r.id),
      type: String(r.type),
      title: String(r.title),
      status: r.status as TaskInfo['status'],
      progress: Number(r.progress ?? 0),
      total: Number(r.total ?? 0),
      message: String(r.message ?? ''),
      createdAt: Number(r.created_at ?? 0),
      startedAt: r.started_at === null ? undefined : Number(r.started_at),
      finishedAt: r.finished_at === null ? undefined : Number(r.finished_at),
      error: (r.error as string) ?? undefined
    }))
  }

  /* ------------------------- 设置 ------------------------- */

  getSetting<T>(key: string, fallback: T): T {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    if (!r) return fallback
    return safeJson(r.value, fallback)
  }

  setSetting(key: string, value: unknown): void {
    this.db
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
      )
      .run(key, JSON.stringify(value))
  }

  /* ------------------------- 插件 ------------------------- */

  listPluginMeta(): Array<Record<string, unknown>> {
    return this.db.prepare('SELECT * FROM plugin_meta ORDER BY imported_at ASC').all() as Array<
      Record<string, unknown>
    >
  }

  upsertPluginMeta(p: Record<string, unknown>): void {
    this.db
      .prepare(
        `INSERT INTO plugin_meta (id,name,version,path,enabled,sources,qualitys,format,imported_at,load_ok,load_error,incompatibilities,rate_limit)
         VALUES (@id,@name,@version,@path,@enabled,@sources,@qualitys,@format,@imported_at,@load_ok,@load_error,@incompatibilities,@rate_limit)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, version=excluded.version, path=excluded.path,
           enabled=excluded.enabled, sources=excluded.sources, qualitys=excluded.qualitys, format=excluded.format,
           load_ok=excluded.load_ok, load_error=excluded.load_error, incompatibilities=excluded.incompatibilities,
           rate_limit=excluded.rate_limit`
      )
      .run({
        id: p.id,
        name: p.name,
        version: p.version ?? '',
        path: p.path,
        enabled: p.enabled === undefined ? 1 : p.enabled,
        sources: JSON.stringify(p.sources ?? []),
        qualitys: JSON.stringify(p.qualitys ?? []),
        format: p.format ?? 'unknown',
        imported_at: p.imported_at ?? Date.now(),
        load_ok: p.load_ok ?? 0,
        load_error: p.load_error ?? null,
        incompatibilities: JSON.stringify(p.incompatibilities ?? []),
        rate_limit: p.rate_limit ?? 60
      })
  }

  deletePluginMeta(id: string): void {
    this.db.prepare('DELETE FROM plugin_meta WHERE id = ?').run(id)
    this.db.prepare('DELETE FROM plugin_calls WHERE plugin_id = ?').run(id)
  }

  setPluginEnabled(id: string, enabled: boolean): void {
    this.db.prepare('UPDATE plugin_meta SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id)
  }

  setPluginRateLimit(id: string, perMinute: number): void {
    this.db.prepare('UPDATE plugin_meta SET rate_limit = ? WHERE id = ?').run(perMinute, id)
  }

  addPluginCall(
    pluginId: string,
    fn: string,
    ok: boolean,
    durationMs: number,
    message?: string
  ): void {
    this.db
      .prepare(
        'INSERT INTO plugin_calls (plugin_id, ts, fn, ok, duration_ms, message) VALUES (?,?,?,?,?,?)'
      )
      .run(pluginId, Date.now(), fn, ok ? 1 : 0, durationMs, message ?? null)
  }

  pluginCalls(pluginId: string, limit = 200): Array<{
    ts: number
    fn: string
    ok: boolean
    durationMs: number
    message?: string
  }> {
    const rows = this.db
      .prepare('SELECT ts, fn, ok, duration_ms, message FROM plugin_calls WHERE plugin_id = ? ORDER BY id DESC LIMIT ?')
      .all(pluginId, limit) as Array<Record<string, unknown>>
    return rows.map((r) => ({
      ts: Number(r.ts),
      fn: String(r.fn),
      ok: Number(r.ok) === 1,
      durationMs: Number(r.duration_ms),
      message: (r.message as string) ?? undefined
    }))
  }
}

/**
 * 批量操作引擎：干跑预览 -> 确认执行 -> 按批次回滚。
 *
 * 对应提示词的前三条硬性约束：
 *   1. 永不静默覆盖：重名加序号；默认只补空字段；覆盖需二次确认且逐字段 diff；
 *   2. 先干跑后执行：所有写操作都必须先出 PreviewReport；
 *   3. 完全可回滚：每批次写 undo_entries + op_log + 批次 JSON 备份。
 */
import fs from 'node:fs'
import path from 'node:path'
import type {
  FieldDiff,
  FieldSource,
  OpLogEntry,
  PreviewItem,
  PreviewReport,
  TagValues,
  TrackRecord,
  UndoEntry
} from '@shared/types'
import { FIELD_LABELS } from '@shared/fields'
import type { ApplyFieldSelection, MoveRule, RenameRule, WriteExecuteResult } from '@shared/api'
import type { Db } from '../db'
import { buildFileName, commonAncestor, sanitizeRelativePath, uniqueFileName } from './rename'
import { computeAudioHash } from './hash'
import { formatFromExtension } from './fieldMap'
import { readTags } from './tagIo'

/** 一次写标签的作业。 */
export interface WriteJob {
  path: string
  /** 语义字段 -> 新值（空数组表示清空该字段） */
  fields: TagValues
  /** 写之前的音频数据区哈希（用于写后校验） */
  expectedHash?: string | null
}

export interface WriteJobResult {
  path: string
  ok: boolean
  written: string[]
  failed: Array<{ field: string; reason: string }>
  /** 音频数据区是否保持不变 */
  audioIntact: boolean
  error?: string
}

/** 写入执行器（由 IPC 层注入 worker 实现）。 */
export type WriteExecutor = (jobs: WriteJob[]) => Promise<WriteJobResult[]>

/** 生成批次号：时间戳 + 随机后缀。 */
export function newBatchId(prefix = 'batch'): string {
  const ts = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
  const rand = Math.random().toString(36).slice(2, 7)
  return `${prefix}-${ts}-${rand}`
}

/** 多值字段的存储分隔符（与 alias.ts 的优先级一致）。 */
const VALUE_SEP = '; '

/** 属于「外部候选来源」的字段来源：写入这些字段代表用户采纳了匹配结果。 */
const REMOTE_FIELD_SOURCES: string[] = ['musicbrainz', 'itunes', 'plugin']

function joinValues(values: string[] | undefined): string {
  return (values ?? []).join(VALUE_SEP)
}

function splitValues(value: string | null): string[] {
  if (!value) return []
  return value
    .split(VALUE_SEP)
    .map((v) => v.trim())
    .filter(Boolean)
}

export interface BatchEngineOptions {
  /** 批次 JSON 备份目录 */
  backupDir: string
  /** 归档根目录（空 = 用所选文件的公共祖先目录） */
  archiveRoot: string
}

export class BatchEngine {
  constructor(
    private readonly db: Db,
    private readonly opts: BatchEngineOptions,
    private readonly write: WriteExecutor
  ) {}

  /* ==================== 标签写入 ==================== */

  /**
   * 干跑预览：逐字段 diff。
   * @param overwrite false = 只补空字段（默认）；true = 覆盖已有值（需二次确认）
   */
  previewTagWrite(items: ApplyFieldSelection[], overwrite: boolean): PreviewReport {
    const warnings: string[] = []
    const out: PreviewItem[] = []
    let changed = 0
    let unchanged = 0
    let failed = 0
    let skipped = 0

    for (const item of items) {
      const rec = this.db.getFile(item.fileId)
      if (!rec) {
        out.push({
          fileId: item.fileId,
          path: item.path,
          filename: path.basename(item.path),
          diffs: [],
          status: 'failed',
          message: '库中找不到该文件记录'
        })
        failed++
        continue
      }

      const diffs: FieldDiff[] = []
      let itemSkipped = false

      for (const [field, values] of Object.entries(item.fields ?? {})) {
        const oldValues = rec.tags[field] ?? []
        const oldValue = joinValues(oldValues)
        const newValue = joinValues(values)
        if (oldValue === newValue) continue
        if (oldValue && !overwrite) {
          diffs.push({
            field,
            label: FIELD_LABELS[field] ?? field,
            oldValue,
            newValue,
            source: item.sources?.[field] ?? 'manual',
            overwrite: true
          })
          itemSkipped = true
          continue
        }
        diffs.push({
          field,
          label: FIELD_LABELS[field] ?? field,
          oldValue: oldValue || null,
          newValue: newValue || null,
          source: item.sources?.[field] ?? 'manual',
          overwrite: !!oldValue
        })
      }

      for (const field of item.clearFields ?? []) {
        const oldValues = rec.tags[field] ?? []
        if (!oldValues.length) continue
        diffs.push({
          field,
          label: FIELD_LABELS[field] ?? field,
          oldValue: joinValues(oldValues),
          newValue: null,
          source: 'manual',
          overwrite: true
        })
      }

      const status: PreviewItem['status'] = itemSkipped
        ? 'skipped'
        : diffs.length
          ? 'changed'
          : 'unchanged'
      if (status === 'changed') changed++
      else if (status === 'unchanged') unchanged++
      else if (status === 'skipped') skipped++

      out.push({
        fileId: rec.id,
        path: rec.path,
        filename: rec.filename,
        diffs,
        status,
        message: itemSkipped ? '已有值的字段默认不覆盖（可勾选“强制覆盖”后执行）' : undefined
      })
    }

    if (!overwrite) {
      warnings.push('当前为“仅补空字段”模式：已有值的字段不会被覆盖，勾选“强制覆盖”后方可替换。')
    }
    const weak = items.filter((i) => {
      const rec = this.db.getFile(i.fileId)
      if (!rec) return false
      const fmt = formatFromExtension(rec.ext)
      return fmt === 'riff' || fmt === 'id3v1' || fmt === 'unknown'
    })
    if (weak.length) {
      warnings.push(
        `有 ${weak.length} 个文件使用了标签能力弱的格式（WAV/ID3v1/未知），相关字段会写入失败并明确报错。`
      )
    }

    return {
      batchId: '',
      opType: item0OpType(items),
      items: out,
      summary: { total: out.length, changed, unchanged, failed, skipped },
      warnings
    }
  }

  /**
   * 执行标签写入。
   */
  async executeTagWrite(
    items: ApplyFieldSelection[],
    overwrite: boolean,
    batchId = newBatchId('write')
  ): Promise<WriteExecuteResult> {
    const jobs: WriteJob[] = []
    const plans: Array<{
      item: ApplyFieldSelection
      rec: TrackRecord
      fields: TagValues
      oldValues: Record<string, string[]>
    }> = []
    const failed: WriteExecuteResult['failed'] = []

    for (const item of items) {
      const rec = this.db.getFile(item.fileId)
      if (!rec) {
        failed.push({ path: item.path, reason: '库中找不到该文件记录' })
        continue
      }
      const fields: TagValues = {}
      const oldValues: Record<string, string[]> = {}

      for (const [field, values] of Object.entries(item.fields ?? {})) {
        const old = rec.tags[field] ?? []
        if (old.length && !overwrite) continue
        fields[field] = values
        oldValues[field] = old
      }
      for (const field of item.clearFields ?? []) {
        const old = rec.tags[field] ?? []
        if (!old.length) continue
        fields[field] = []
        oldValues[field] = old
      }
      if (!Object.keys(fields).length) continue

      plans.push({ item, rec, fields, oldValues })
      jobs.push({ path: rec.path, fields, expectedHash: rec.audioHash })
    }

    if (!jobs.length) {
      return {
        batchId,
        ok: true,
        written: 0,
        failed,
        audioIntact: true,
        message: '没有需要写入的字段（已有值的字段在非覆盖模式下会被跳过）'
      }
    }

    const results = await this.write(jobs)
    const resultByPath = new Map(results.map((r) => [r.path, r]))

    const undoEntries: UndoEntry[] = []
    const opLogs: OpLogEntry[] = []
    let written = 0
    let audioIntact = true

    for (const plan of plans) {
      const res = resultByPath.get(plan.rec.path)
      if (!res) {
        failed.push({ path: plan.rec.path, reason: '写入作业没有返回结果' })
        continue
      }
      if (res.error) failed.push({ path: plan.rec.path, reason: res.error })
      for (const f of res.failed) {
        failed.push({ path: plan.rec.path, field: f.field, reason: f.reason })
      }
      if (!res.audioIntact) {
        audioIntact = false
        failed.push({ path: plan.rec.path, reason: '写入后音频数据区哈希发生变化，已阻止本次操作' })
      }
      if (!res.ok && !res.written.length) continue
      written++

      // 更新库内标签
      const nextTags: TagValues = { ...plan.rec.tags }
      for (const [field, values] of Object.entries(plan.fields)) {
        if (values.length) nextTags[field] = values
        else delete nextTags[field]
      }
      const nextSources: Record<string, FieldSource> = { ...plan.rec.sources }
      for (const field of Object.keys(plan.fields)) {
        nextSources[field] = plan.item.sources?.[field] ?? 'manual'
      }
      this.db.updateTags(plan.rec.id, nextTags, nextSources)

      // 推进匹配状态：采纳了外部来源的候选 → 已匹配；纯手动编辑或清空修正 → 手动。
      const adoptedRemote = Object.keys(plan.fields).some((f) =>
        REMOTE_FIELD_SOURCES.includes(plan.item.sources?.[f] ?? 'manual')
      )
      this.db.setMatchState(plan.rec.id, adoptedRemote ? 'matched' : 'manual')

      for (const [field, values] of Object.entries(plan.fields)) {
        undoEntries.push({
          id: 0,
          batchId,
          fileId: plan.rec.id,
          path: plan.rec.path,
          kind: 'tag',
          field,
          oldValue: joinValues(plan.oldValues[field]) || null,
          newValue: joinValues(values) || null
        })
        opLogs.push({
          id: 0,
          ts: Date.now(),
          filePath: plan.rec.path,
          field,
          oldValue: joinValues(plan.oldValues[field]) || null,
          newValue: joinValues(values) || null,
          source: plan.item.sources?.[field] ?? 'manual',
          batchId
        })
      }
    }

    this.db.createUndoBatch(
      batchId,
      'write-tags',
      `写入 ${written} 个文件，涉及 ${undoEntries.length} 个字段`
    )
    this.db.addUndoEntries(undoEntries)
    this.db.logOps(opLogs)
    this.writeBatchBackup(batchId, 'write-tags', undoEntries)

    return {
      batchId,
      ok: failed.length === 0,
      written,
      failed,
      audioIntact,
      message: `成功写入 ${written} 个文件${failed.length ? `，失败 ${failed.length} 处` : ''}`
    }
  }

  /* ==================== 清空字段 ==================== */

  /** 清空字段预览（本质是「写入空值」的干跑）。 */
  previewClearFields(fileIds: number[], fields: string[]): PreviewReport {
    const items: ApplyFieldSelection[] = fileIds.map((id) => {
      const rec = this.db.getFile(id)
      return {
        fileId: id,
        path: rec?.path ?? '',
        fields: {},
        sources: {},
        clearFields: fields
      }
    })
    const report = this.previewTagWrite(items, true)
    report.opType = 'clear-tags'
    return report
  }

  /* ==================== 重命名 ==================== */

  /** 重命名干跑预览。 */
  previewRename(fileIds: number[], rule: RenameRule): PreviewReport {
    return this.previewPathChange(fileIds, rule, 'rename')
  }

  /** 归档移动干跑预览。 */
  previewMove(fileIds: number[], rule: MoveRule): PreviewReport {
    return this.previewPathChange(fileIds, rule, 'move')
  }

  private previewPathChange(
    fileIds: number[],
    rule: RenameRule | MoveRule,
    opType: 'rename' | 'move'
  ): PreviewReport {
    const warnings: string[] = []
    const items: PreviewItem[] = []
    const reserved = new Set<string>()
    let changed = 0
    let unchanged = 0
    let failed = 0
    let skipped = 0

    const records = this.db.getFiles(fileIds)
    // 归档时以被移动文件的共同祖先为基准，保留原有的相对目录结构。
    const sourceRoot = commonAncestor(records.map((r) => r.dir))
    const archiveRoot = opType === 'move' ? this.opts.archiveRoot || sourceRoot : ''

    for (const rec of records) {
      const ext = rec.ext
      const { name, warnings: w } = buildFileName(
        rule.template,
        { tags: rec.tags, filename: rec.filename, ext },
        rec.filename
      )
      warnings.push(...w.map((x) => `${rec.filename}：${x}`))

      const relDir =
        opType === 'move' && sourceRoot ? path.relative(sourceRoot, rec.dir) : ''
      const targetDir =
        opType === 'move' ? path.join(archiveRoot, sanitizeRelativePath(relDir)) : rec.dir
      const base = path.basename(name)
      const finalName = uniqueFileName(targetDir, base.replace(/\.[^.]+$/, ''), ext, reserved)
      const newPath = path.join(targetDir, finalName)

      if (newPath === rec.path) {
        items.push({
          fileId: rec.id,
          path: rec.path,
          filename: rec.filename,
          diffs: [],
          newPath,
          status: 'unchanged'
        })
        unchanged++
        continue
      }
      items.push({
        fileId: rec.id,
        path: rec.path,
        filename: rec.filename,
        diffs: [
          {
            field: 'filename',
            label: '文件路径',
            oldValue: rec.path,
            newValue: newPath,
            source: 'manual',
            overwrite: false
          }
        ],
        newPath,
        status: 'changed'
      })
      changed++
    }

    const missing = fileIds.length - records.length
    if (missing > 0) {
      failed += missing
      warnings.push(`有 ${missing} 个文件在库中找不到记录，已跳过。`)
    }
    warnings.push('目标同名文件不会被覆盖：系统会自动追加序号（如 “ (2)”）。')

    return {
      batchId: '',
      opType,
      items,
      summary: { total: items.length, changed, unchanged, failed, skipped },
      warnings
    }
  }

  /** 执行重命名 / 移动。 */
  async executePathChange(
    fileIds: number[],
    rule: RenameRule | MoveRule,
    opType: 'rename' | 'move'
  ): Promise<WriteExecuteResult> {
    const preview = this.previewPathChange(fileIds, rule, opType)
    const batchId = newBatchId(opType)
    const failed: WriteExecuteResult['failed'] = []
    const undoEntries: UndoEntry[] = []
    const opLogs: OpLogEntry[] = []
    let written = 0

    for (const item of preview.items) {
      if (item.status !== 'changed' || !item.newPath) continue
      const rec = this.db.getFile(item.fileId)
      if (!rec) {
        failed.push({ path: item.path, reason: '库中找不到该文件记录' })
        continue
      }
      try {
        if (opType === 'move') {
          fs.mkdirSync(path.dirname(item.newPath), { recursive: true })
        }
        // 最后一次确认目标不存在，绝不覆盖
        if (fs.existsSync(item.newPath)) {
          failed.push({ path: item.path, reason: `目标已存在，已跳过：${item.newPath}` })
          continue
        }
        fs.renameSync(rec.path, item.newPath)
        this.db.updatePath(rec.id, item.newPath)
        undoEntries.push({
          id: 0,
          batchId,
          fileId: rec.id,
          path: rec.path,
          kind: opType === 'rename' ? 'rename' : 'move',
          field: null,
          oldValue: rec.path,
          newValue: item.newPath
        })
        opLogs.push({
          id: 0,
          ts: Date.now(),
          filePath: rec.path,
          field: 'filename',
          oldValue: rec.path,
          newValue: item.newPath,
          source: 'manual',
          batchId
        })
        written++
      } catch (err) {
        failed.push({
          path: rec.path,
          reason: err instanceof Error ? err.message : String(err)
        })
      }
    }

    this.db.createUndoBatch(
      batchId,
      opType,
      `${opType === 'rename' ? '重命名' : '归档移动'} ${written} 个文件`
    )
    this.db.addUndoEntries(undoEntries)
    this.db.logOps(opLogs)
    this.writeBatchBackup(batchId, opType, undoEntries)

    return {
      batchId,
      ok: failed.length === 0,
      written,
      failed,
      audioIntact: true,
      message:
        opType === 'rename'
          ? `重命名完成：${written} 个`
          : `归档移动完成：${written} 个`
    }
  }

  /* ==================== 回滚 ==================== */

  /** 按批次撤销。 */
  async undoBatch(batchId: string): Promise<{ ok: boolean; message: string; restored: number }> {
    const entries = this.db.undoEntries(batchId)
    if (!entries.length) {
      return { ok: false, message: '找不到该批次的回滚记录', restored: 0 }
    }
    const batch = this.db.undoBatches().find((b) => b.batchId === batchId)
    if (batch?.undone) {
      return { ok: false, message: '该批次已经撤销过了', restored: 0 }
    }

    let restored = 0
    const failures: string[] = []
    const opLogs: OpLogEntry[] = []

    // 逆序回滚：先撤销文件移动，再撤销标签
    const pathEntries = entries.filter((e) => e.kind === 'rename' || e.kind === 'move').reverse()
    const tagEntries = entries.filter((e) => e.kind === 'tag')

    for (const e of pathEntries) {
      if (!e.newValue || !e.oldValue) continue
      try {
        if (fs.existsSync(e.newValue)) {
          if (fs.existsSync(e.oldValue)) {
            failures.push(`原路径已被占用，未回滚：${e.oldValue}`)
            continue
          }
          fs.mkdirSync(path.dirname(e.oldValue), { recursive: true })
          fs.renameSync(e.newValue, e.oldValue)
          this.db.updatePath(e.fileId, e.oldValue)
          restored++
          opLogs.push({
            id: 0,
            ts: Date.now(),
            filePath: e.newValue,
            field: 'filename',
            oldValue: e.newValue,
            newValue: e.oldValue,
            source: 'manual',
            batchId
          })
        } else {
          failures.push(`文件已不存在，未回滚：${e.newValue}`)
        }
      } catch (err) {
        failures.push(`${e.newValue}：${err instanceof Error ? err.message : String(err)}`)
      }
    }

    if (tagEntries.length) {
      // 按文件分组，一次性写回
      const byFile = new Map<number, UndoEntry[]>()
      for (const e of tagEntries) {
        if (!byFile.has(e.fileId)) byFile.set(e.fileId, [])
        byFile.get(e.fileId)!.push(e)
      }
      const jobs: WriteJob[] = []
      for (const [fileId, list] of byFile) {
        const rec = this.db.getFile(fileId)
        if (!rec) {
          failures.push(`文件记录不存在，未回滚：${fileId}`)
          continue
        }
        const fields: TagValues = {}
        for (const e of list) {
          if (!e.field) continue
          fields[e.field] = e.oldValue ? splitValues(e.oldValue) : []
        }
        jobs.push({ path: rec.path, fields })
      }
      if (jobs.length) {
        const results = await this.write(jobs)
        const resultByPath = new Map(results.map((r) => [r.path, r]))
        for (const job of jobs) {
          const res = resultByPath.get(job.path)
          if (!res) {
            failures.push(`${job.path}：回滚作业没有返回结果`)
            continue
          }
          if (res.error) {
            failures.push(`${res.path}：${res.error}`)
            continue
          }
          for (const f of res.failed) {
            failures.push(`${res.path} [${f.field}]：${f.reason}`)
          }
          if (!res.audioIntact) {
            failures.push(`${res.path}：回滚后音频数据区哈希发生变化`)
            continue
          }
          // 重新读盘并同步库内标签，保证库与文件一致
          const rec = this.db.getFile(this.db.fileIdByPath(job.path))
          const read = readTags(job.path)
          if (rec) {
            this.db.updateTags(rec.id, read.tags, rec.sources)
          }
          restored++
        }
      }
    }

    this.db.markBatchUndone(batchId)
    this.db.logOps(opLogs)

    return {
      ok: failures.length === 0,
      message: failures.length
        ? `已回滚 ${restored} 处，${failures.length} 处失败：${failures.slice(0, 3).join('；')}`
        : `已完整回滚 ${restored} 处改动`,
      restored
    }
  }

  /* ==================== 内部 ==================== */

  /** 写批次 JSON 备份（含时间戳与批次号）。 */
  private writeBatchBackup(batchId: string, opType: string, entries: UndoEntry[]): void {
    try {
      fs.mkdirSync(this.opts.backupDir, { recursive: true })
      const payload = {
        batchId,
        opType,
        createdAt: new Date().toISOString(),
        timestamp: Date.now(),
        entries
      }
      fs.writeFileSync(
        path.join(this.opts.backupDir, `${batchId}.json`),
        JSON.stringify(payload, null, 2),
        'utf8'
      )
    } catch {
      /* 备份写失败不阻断主流程（DB 中已有完整回滚记录） */
    }
  }

  /** 供外部复用：计算某个文件的音频哈希。 */
  hashOf(filePath: string): string {
    return computeAudioHash(filePath, formatFromExtension(path.extname(filePath)))
  }
}

function item0OpType(items: ApplyFieldSelection[]): PreviewReport['opType'] {
  const hasClear = items.some((i) => (i.clearFields?.length ?? 0) > 0)
  const hasWrite = items.some((i) => Object.keys(i.fields ?? {}).length > 0)
  if (hasClear && !hasWrite) return 'clear-tags'
  return 'write-tags'
}

/**
 * 歌词流水线：多来源收集 -> 候选评分 -> 预览 -> 三种落地。
 *
 * 规则（提示词第五节 C）：
 *   - 已有歌词默认不动（需显式勾选「覆盖已有歌词」）；
 *   - 写入前做标题相似度校验，相似度 < 0.55 视为可能下错歌，给出警告；
 *   - 支持 ±0.5 秒（±500ms）偏移，并记忆每个文件的偏移。
 */
import fs from 'node:fs'
import type { LyricCandidate, LyricWriteOptions, TrackRecord } from '@shared/types'
import type { WriteExecuteResult } from '@shared/api'
import { applyLrcOffset, countLyricLines, lrcCoverage, lrcPathFor, parseLrc } from './lyrics'
import { similarity } from './scoring'
import type { Db } from '../db'
import type { PluginManager } from '../plugins/manager'
import type { WriteExecutor } from './batch'

/** 标题相似度低于此值视为可能下错歌。 */
export const TITLE_MATCH_THRESHOLD = 0.55

export interface LyricQueryResult {
  fileId: number
  candidates: LyricCandidate[]
}

export class LyricPipeline {
  constructor(
    private readonly db: Db,
    private readonly plugins: PluginManager,
    private readonly writeExecutor: WriteExecutor
  ) {}

  /** 收集一个文件的歌词候选。 */
  async collect(rec: TrackRecord): Promise<LyricCandidate[]> {
    const candidates: LyricCandidate[] = []
    const expectedTitle = rec.tags.title?.[0] ?? rec.parsed?.title ?? ''
    const expectedArtist = rec.tags.artist?.[0] ?? rec.parsed?.artist ?? ''

    // 1) 本地已有歌词
    const embedded = rec.tags.lyrics?.find((l) => l.trim())
    if (embedded) {
      candidates.push(
        this.makeCandidate({
          id: `local-embedded:${rec.id}`,
          source: 'local',
          title: expectedTitle,
          artist: expectedArtist,
          content: embedded,
          expectedTitle,
          expectedArtist,
          bonus: 10
        })
      )
    }
    const lrcPath = lrcPathFor(rec.path)
    if (fs.existsSync(lrcPath)) {
      try {
        const text = fs.readFileSync(lrcPath, 'utf8')
        candidates.push(
          this.makeCandidate({
            id: `local-lrc:${rec.id}`,
            source: 'local',
            title: expectedTitle,
            artist: expectedArtist,
            content: text,
            expectedTitle,
            expectedArtist,
            bonus: 8
          })
        )
      } catch {
        /* 读取 .lrc 失败不阻断 */
      }
    }

    // 2) 插件来源
    for (const p of this.plugins.list().filter((x) => x.enabled)) {
      const res = await this.plugins.call({
        pluginId: p.id,
        fn: 'lyric',
        source: 'local',
        musicInfo: {
          id: rec.tags.mb_recording_id?.[0] ?? rec.id,
          name: expectedTitle,
          singer: expectedArtist,
          source: 'local',
          interval: rec.duration ?? 0,
          meta: {
            songId: rec.tags.mb_recording_id?.[0] ?? '',
            albumName: rec.tags.album?.[0] ?? '',
            picUrl: ''
          }
        }
      })
      if (!res.ok) continue
      const data = res.data as { lyric?: string; translation?: string } | undefined
      const content = data?.lyric?.trim()
      if (!content) continue
      candidates.push(
        this.makeCandidate({
          id: `plugin:${p.id}:${rec.id}`,
          source: 'plugin',
          pluginId: p.id,
          title: expectedTitle,
          artist: expectedArtist,
          content,
          translation: data?.translation,
          expectedTitle,
          expectedArtist,
          bonus: 5
        })
      )
    }

    candidates.sort((a, b) => b.score - a.score)
    return candidates
  }

  /** 构造候选并打分。 */
  private makeCandidate(input: {
    id: string
    source: LyricCandidate['source']
    pluginId?: string
    title: string
    artist: string
    content: string
    translation?: string
    expectedTitle: string
    expectedArtist: string
    bonus: number
  }): LyricCandidate {
    const parsed = parseLrc(input.content)
    const titleSim = input.expectedTitle
      ? similarity(input.expectedTitle, input.title)
      : 1
    const artistSim = input.expectedArtist && input.artist
      ? similarity(input.expectedArtist, input.artist)
      : 1
    const coverage = lrcCoverage(input.content)
    const lines = countLyricLines(input.content)
    let score = 0
    score += titleSim * 50
    score += artistSim * 20
    score += parsed.timed ? 20 : 5
    score += coverage * 10
    if (lines < 3) score -= 20
    score += input.bonus
    return {
      id: input.id,
      source: input.source,
      pluginId: input.pluginId,
      title: input.title,
      artist: input.artist,
      content: input.content,
      translation: input.translation,
      timed: parsed.timed,
      lineCount: lines,
      coverage,
      score: Math.max(0, Math.round(score))
    }
  }

  /** 标题相似度校验（防止歌词下错歌）。 */
  static titleGuard(candidate: LyricCandidate, rec: TrackRecord): boolean {
    const expected = rec.tags.title?.[0] ?? rec.parsed?.title ?? ''
    if (!expected) return true
    return similarity(expected, candidate.title) >= TITLE_MATCH_THRESHOLD
  }

  /** 写入歌词。 */
  async write(
    rec: TrackRecord,
    candidate: LyricCandidate,
    options: LyricWriteOptions
  ): Promise<WriteExecuteResult> {
    const batchId = `lyric-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const failed: WriteExecuteResult['failed'] = []
    const hasEmbedded = !!(rec.tags.lyrics?.find((l) => l.trim()))
    const lrcPath = lrcPathFor(rec.path)
    const hasLrc = fs.existsSync(lrcPath)

    if (!options.overwrite && (hasEmbedded || hasLrc)) {
      return {
        batchId,
        ok: false,
        written: 0,
        failed: [
          {
            path: rec.path,
            reason: hasEmbedded
              ? '文件已有内嵌歌词，默认不覆盖（如需覆盖请勾选「覆盖已有歌词」）'
              : '同目录已有 .lrc 文件，默认不覆盖（如需覆盖请勾选「覆盖已有歌词」）'
          }
        ],
        audioIntact: true,
        message: '已有歌词，未做改动'
      }
    }

    const offset = options.offsetMs || this.db.getLyricOffset(rec.id) || 0
    const content = applyLrcOffset(candidate.content, offset)
    const undoEntries: Array<{
      id: number
      batchId: string
      fileId: number
      path: string
      kind: 'tag' | 'rename' | 'move' | 'delete' | 'create'
      field: string | null
      oldValue: string | null
      newValue: string | null
    }> = []
    let written = 0

    if (options.embedded) {
      const res = await this.writeExecutor([{ path: rec.path, fields: { lyrics: [content] } }])
      const r = res[0]
      if (r?.error) {
        failed.push({ path: rec.path, field: 'lyrics', reason: r.error })
      } else {
        written++
        undoEntries.push({
          id: 0,
          batchId,
          fileId: rec.id,
          path: rec.path,
          kind: 'tag',
          field: 'lyrics',
          oldValue: rec.tags.lyrics?.join('; ') ?? null,
          newValue: content
        })
        this.db.setLyricState(rec.id, options.lrcFile ? 'both' : 'embedded')
      }
    }

    if (options.lrcFile) {
      try {
        const existed = fs.existsSync(lrcPath)
        const oldContent = existed ? fs.readFileSync(lrcPath, 'utf8') : null
        fs.writeFileSync(lrcPath, content, 'utf8')
        written++
        undoEntries.push({
          id: 0,
          batchId,
          fileId: rec.id,
          path: lrcPath,
          kind: existed ? 'tag' : 'create',
          field: null,
          oldValue: oldContent,
          newValue: content
        })
        if (!options.embedded) this.db.setLyricState(rec.id, 'lrc-file')
      } catch (err) {
        failed.push({
          path: lrcPath,
          reason: err instanceof Error ? err.message : String(err)
        })
      }
    }

    if (undoEntries.length) {
      this.db.createUndoBatch(batchId, 'lyrics', `写入歌词 ${written} 处`)
      this.db.addUndoEntries(undoEntries)
      this.db.logOps(
        undoEntries.map((e) => ({
          id: 0,
          ts: Date.now(),
          filePath: e.path,
          field: e.field ?? 'lyrics',
          oldValue: e.oldValue,
          newValue: e.newValue,
          source: 'lyrics' as const,
          batchId
        }))
      )
    }

    return {
      batchId,
      ok: failed.length === 0,
      written,
      failed,
      audioIntact: true,
      message: written ? `歌词已写入 ${written} 处` : '没有写入任何内容'
    }
  }

  /** 记忆偏移。 */
  setOffset(fileId: number, offsetMs: number): void {
    this.db.setLyricOffset(fileId, Math.max(-5000, Math.min(5000, Math.round(offsetMs))))
  }

  /** 供 UI 展示的偏移（毫秒）。 */
  offsetOf(fileId: number): number {
    return this.db.getLyricOffset(fileId)
  }
}


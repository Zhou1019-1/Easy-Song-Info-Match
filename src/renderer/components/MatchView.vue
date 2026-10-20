<script setup lang="ts">
/**
 * 匹配：横向候选对比表（候选为列、字段为行）+ 勾选式写回 + 写回前预览确认。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import type { ApplyFieldSelection } from '@shared/api'
import type { Candidate, CandidateSource, FieldSource, PreviewReport, TagValues } from '@shared/types'
import { CANDIDATE_SOURCE_LABELS } from '@shared/types'
import { safeCall } from '../lib/api'
import { toast } from '../lib/toast'
import { formatDuration, joinValues } from '../lib/format'
import { ensureSettings, matchResults, settings, trackCache } from '../lib/store'
import PreviewDialog from './PreviewDialog.vue'
import ConfirmDialog from './ConfirmDialog.vue'

interface MatchFieldDef {
  key: string
  label: string
  /** 是否可写回（时长/目录编号等仅展示） */
  writable: boolean
  get: (c: Candidate) => string[]
}

const MATCH_FIELDS: MatchFieldDef[] = [
  { key: 'title', label: '标题', writable: true, get: (c) => (c.title ? [c.title] : []) },
  { key: 'artist', label: '歌手', writable: true, get: (c) => c.artists },
  { key: 'album', label: '专辑', writable: true, get: (c) => (c.album ? [c.album] : []) },
  { key: 'albumartist', label: '专辑歌手', writable: true, get: (c) => c.albumArtists },
  { key: 'composer', label: '作曲家', writable: true, get: (c) => c.composers },
  { key: 'genre', label: '流派', writable: true, get: (c) => (c.genre ? [c.genre] : []) },
  { key: 'year', label: '年份', writable: true, get: (c) => (c.year ? [String(c.year)] : []) },
  { key: 'date', label: '日期', writable: true, get: (c) => (c.date ? [c.date] : []) },
  { key: 'track', label: '音轨号', writable: true, get: (c) => (c.trackNumber ? [String(c.trackNumber)] : []) },
  { key: 'disc', label: '碟号', writable: true, get: (c) => (c.discNumber ? [String(c.discNumber)] : []) },
  { key: 'totaldiscs', label: '总碟数', writable: true, get: (c) => (c.totalDiscs ? [String(c.totalDiscs)] : []) },
  { key: 'duration', label: '时长', writable: false, get: (c) => (c.duration != null ? [formatDuration(c.duration)] : []) },
  { key: 'label', label: '厂牌', writable: true, get: (c) => (c.label ? [c.label] : []) },
  { key: 'upc', label: 'UPC', writable: true, get: (c) => (c.upc ? [c.upc] : []) },
  { key: 'catalogNumber', label: '目录编号', writable: false, get: (c) => (c.catalogNumber ? [c.catalogNumber] : []) },
  { key: 'advisory', label: '分级', writable: true, get: (c) => (c.advisory && c.advisory !== 'none' ? [c.advisory] : []) },
  { key: 'copyright', label: '版权', writable: true, get: (c) => (c.copyright ? [c.copyright] : []) }
]

const SOURCE_FIELDS: Record<CandidateSource, FieldSource> = {
  musicbrainz: 'musicbrainz',
  itunes: 'itunes',
  plugin: 'plugin',
  local: 'filename'
}

const results = matchResults
const activeFileId = ref<number | null>(null)
const picks = reactive<Record<number, string>>({})
const checked = reactive<Record<number, string[]>>({})
const edits = reactive<Record<number, Record<string, string>>>({})
const currentTags = reactive<Record<number, TagValues>>({})

const activeResult = computed(() => results.value.find((r) => r.fileId === activeFileId.value) ?? null)
const candidates = computed<Candidate[]>(() => activeResult.value?.candidates ?? [])
const pickedId = computed(() => (activeFileId.value ? picks[activeFileId.value] : undefined))
const pickedCandidate = computed<Candidate | null>(() => candidates.value.find((c) => c.id === pickedId.value) ?? null)

const gridTemplate = computed(() => `190px repeat(${Math.max(candidates.value.length, 1)}, minmax(200px, 1fr))`)

const pickedCount = computed(() => results.value.filter((r) => picks[r.fileId]).length)

watch(
  results,
  (list) => {
    if (!list.length) {
      activeFileId.value = null
      return
    }
    if (!activeFileId.value || !list.some((r) => r.fileId === activeFileId.value)) {
      activeFileId.value = list[0].fileId
    }
  },
  { immediate: true }
)

watch(activeFileId, (id) => {
  if (id) void ensureTags(id)
})

onMounted(() => {
  void ensureSettings()
  for (const r of results.value) void ensureTags(r.fileId)
})

async function ensureTags(fileId: number): Promise<void> {
  if (currentTags[fileId]) return
  const rec = await safeCall((api) => api.libraryGet(fileId), null, '读取本地标签')
  if (rec) {
    currentTags[fileId] = rec.tags
    trackCache.set(rec.id, rec)
  }
}

function fileName(fileId: number): string {
  return trackCache.get(fileId)?.filename ?? `#${fileId}`
}

function pathOf(fileId: number): string {
  return trackCache.get(fileId)?.path ?? ''
}

function currentValues(fileId: number, field: string): string[] {
  return currentTags[fileId]?.[field] ?? []
}

function currentText(fileId: number, field: string): string {
  return joinValues(currentValues(fileId, field))
}

function isChecked(field: string): boolean {
  if (!activeFileId.value) return false
  return (checked[activeFileId.value] ?? []).includes(field)
}

function toggleField(field: string): void {
  const id = activeFileId.value
  if (!id) return
  const list = checked[id] ?? []
  const idx = list.indexOf(field)
  if (idx >= 0) list.splice(idx, 1)
  else list.push(field)
  checked[id] = list
}

function pick(candidateId: string): void {
  const id = activeFileId.value
  if (!id) return
  picks[id] = candidateId
  if (!checked[id]) checked[id] = []
}

/** 取候选字段值（手动编辑优先）。 */
function valueOf(fileId: number, field: MatchFieldDef, candidate: Candidate): string[] {
  const manual = edits[fileId]?.[field.key]
  if (manual !== undefined) {
    return manual
      .split('/')
      .map((s) => s.trim())
      .filter(Boolean)
  }
  return field.get(candidate)
}

function displayValue(fileId: number, field: MatchFieldDef, candidate: Candidate): string {
  return joinValues(valueOf(fileId, field, candidate))
}

function isDifferent(fileId: number, field: MatchFieldDef, candidate: Candidate): boolean {
  const a = valueOf(fileId, field, candidate).join(' / ')
  const b = currentText(fileId, field.key)
  if (!a) return false
  return a !== b
}

/** 字段级得分（来自候选的 scoreDetail）。 */
function subScore(candidate: Candidate, fieldKey: string): number | null {
  const d = candidate.scoreDetail
  if (!d) return null
  switch (fieldKey) {
    case 'title':
      return d.title
    case 'artist':
      return d.artist
    case 'album':
      return d.album
    case 'year':
      return d.year
    case 'duration':
      return d.duration
    default:
      return null
  }
}

function scoreClass(score: number): string {
  if (score >= 85) return 'high'
  if (score >= 60) return 'mid'
  return 'low'
}

function breakdown(candidate: Candidate): Array<{ label: string; value: number }> {
  const d = candidate.scoreDetail
  if (!d) return []
  return [
    { label: '标题', value: d.title },
    { label: '歌手', value: d.artist },
    { label: '专辑', value: d.album },
    { label: '时长', value: d.duration },
    { label: '年份', value: d.year }
  ]
}

function bestScore(fileId: number): number {
  const r = results.value.find((x) => x.fileId === fileId)
  if (!r || !r.candidates.length) return 0
  return Math.max(...r.candidates.map((c) => c.score))
}

/* ---------------- 手动编辑 ---------------- */

const editingField = ref<string | null>(null)
const editModel = ref('')

function startEdit(field: MatchFieldDef): void {
  const id = activeFileId.value
  if (!id || !pickedCandidate.value) return
  editingField.value = field.key
  editModel.value = edits[id]?.[field.key] ?? displayValue(id, field, pickedCandidate.value)
}

function commitEdit(): void {
  const id = activeFileId.value
  const key = editingField.value
  if (id != null && key) {
    if (!edits[id]) edits[id] = {}
    edits[id][key] = editModel.value
  }
  editingField.value = null
}

/* ---------------- 写回 ---------------- */

const preview = ref<PreviewReport | null>(null)
const pendingItems = ref<ApplyFieldSelection[]>([])
const previewMode = ref(false)

function buildItems(): ApplyFieldSelection[] {
  const items: ApplyFieldSelection[] = []
  for (const res of results.value) {
    const cid = picks[res.fileId]
    if (!cid) continue
    const candidate = res.candidates.find((c) => c.id === cid)
    if (!candidate) continue
    const fields: TagValues = {}
    const sources: Record<string, FieldSource> = {}
    for (const f of MATCH_FIELDS) {
      if (!f.writable) continue
      if (!isCheckedFor(res.fileId, f.key)) continue
      const vals = valueOf(res.fileId, f, candidate)
      if (!vals.length) continue
      fields[f.key] = vals
      sources[f.key] = edits[res.fileId]?.[f.key] !== undefined ? 'manual' : SOURCE_FIELDS[candidate.source]
    }
    if (!Object.keys(fields).length) continue
    items.push({ fileId: res.fileId, path: pathOf(res.fileId), fields, sources })
  }
  return items
}

function isCheckedFor(fileId: number, field: string): boolean {
  return (checked[fileId] ?? []).includes(field)
}

async function apply(): Promise<void> {
  const items = buildItems()
  if (!items.length) {
    toast.warn('请先为文件选择候选，并勾选要写回的字段')
    return
  }
  const res = await safeCall((api) => api.matchApplyPreview(items, false), null, '生成写回预览')
  if (!res) return
  pendingItems.value = items
  previewMode.value = false
  preview.value = res
}

async function confirmPreview(overwrite: boolean): Promise<void> {
  const target = overwrite
  if (target !== previewMode.value) {
    // 覆盖模式需重新生成预览（展示真实 old → new），并再次确认
    const res = await safeCall(
      (api) => api.matchApplyPreview(pendingItems.value, target),
      null,
      '生成覆盖预览'
    )
    if (!res) return
    previewMode.value = target
    preview.value = res
    return
  }
  const res = await safeCall(
    (api) => api.matchApplyExecute(pendingItems.value, target),
    null,
    '写回标签'
  )
  preview.value = null
  if (res) {
    toast.success(`写回完成：成功 ${res.written} 项，失败 ${res.failed.length} 项`)
    for (const f of res.failed) toast.error(`${f.path}：${f.reason}`)
    if (res.audioIntact) toast.info('音频数据区哈希未变')
  }
}

/* ---------------- 批量操作 ---------------- */

async function autoPickHighScore(): Promise<void> {
  const threshold = settings.value?.autoAcceptScore ?? 60
  let count = 0
  for (const res of results.value) {
    const best = res.candidates
      .filter((c) => c.score >= threshold)
      .sort((a, b) => b.score - a.score)[0]
    if (!best) continue
    picks[res.fileId] = best.id
    const list: string[] = []
    for (const f of MATCH_FIELDS) {
      if (!f.writable) continue
      const vals = f.get(best)
      if (!vals.length) continue
      if (vals.join(' / ') !== currentText(res.fileId, f.key)) list.push(f.key)
    }
    checked[res.fileId] = list
    count++
  }
  toast.success(`已为 ${count} 个文件预选高分候选（阈值 ${threshold} 分），确认无误后再写回`)
}

const clearDialog = ref(false)

async function clearPicks(): Promise<void> {
  clearDialog.value = true
}

async function doClearPicks(): Promise<void> {
  clearDialog.value = false
  for (const res of results.value) {
    await safeCall((api) => api.matchClear(res.fileId), null, '清空匹配')
  }
  toast.info('已标记为「都不用候选」')
  await refresh(true)
}

async function refresh(force: boolean): Promise<void> {
  const ids = results.value.map((r) => r.fileId)
  if (!ids.length) return
  const res = await safeCall((api) => api.matchQuery(ids, force), null, '查询匹配')
  if (!res) return
  results.value = res
}

function sourceLabel(c: Candidate): string {
  const base = CANDIDATE_SOURCE_LABELS[c.source] ?? c.source
  return c.pluginId ? `${base}（${c.pluginId}）` : base
}
</script>

<template>
  <div class="view match-view">
    <div class="toolbar">
      <div class="tb-group">
        <button class="btn primary" :disabled="!results.length" @click="refresh(true)">
          重新查询（忽略缓存）
        </button>
        <button class="btn" :disabled="!results.length" @click="autoPickHighScore">只采用高分项</button>
        <button class="btn" :disabled="!results.length" @click="clearPicks">都不用候选</button>
        <button class="btn primary" :disabled="!pickedCount" @click="apply">写回勾选字段</button>
      </div>
      <div class="tb-group right">
        <span class="counter">已选候选 {{ pickedCount }} / {{ results.length }} 个文件</span>
      </div>
    </div>

    <div v-if="results.length" class="file-strip">
      <button
        v-for="r in results"
        :key="r.fileId"
        class="file-chip"
        :class="{ active: r.fileId === activeFileId }"
        :title="trackCache.get(r.fileId)?.path ?? ''"
        @click="activeFileId = r.fileId"
      >
        {{ fileName(r.fileId) }}
        <span class="chip-score">{{ bestScore(r.fileId) }}</span>
      </button>
    </div>

    <div v-if="!results.length" class="empty">
      尚无匹配结果。<br />
      请在「音乐库」中勾选文件 → 点击「查询匹配」。
    </div>

    <div v-else class="match-scroll">
      <div v-if="!candidates.length" class="empty">
        该文件没有查到候选（来源可能全部失败），可稍后重试或手动填写。
      </div>
      <div v-else class="match-grid" :style="{ gridTemplateColumns: gridTemplate }">
        <div class="mg-cell mg-head mg-corner">字段 / 当前值</div>
        <div v-for="c in candidates" :key="c.id" class="mg-cell mg-head">
          <div class="cand-head">
            <label class="cand-pick">
              <input
                type="radio"
                :name="'cand-' + activeFileId"
                :checked="pickedId === c.id"
                @change="pick(c.id)"
              />
              采用此候选
            </label>
            <div class="cand-source">{{ sourceLabel(c) }}</div>
            <div class="cand-title" :title="c.title + ' — ' + c.artists.join(' / ')">
              {{ c.title }} — {{ c.artists.join(' / ') }}
            </div>
            <div class="cand-score" :class="scoreClass(c.score)">{{ c.score }} 分</div>
            <div class="cand-detail">
              <span v-for="d in breakdown(c)" :key="d.label">{{ d.label }} {{ d.value }}</span>
            </div>
          </div>
        </div>

        <template v-for="f in MATCH_FIELDS" :key="f.key">
          <div class="mg-cell mg-field">
            <label class="fld-check" :class="{ disabled: !pickedId }">
              <input
                type="checkbox"
                :disabled="!pickedId || !f.writable"
                :checked="isChecked(f.key)"
                @change="toggleField(f.key)"
              />
              <span>{{ f.label }}</span>
            </label>
            <div class="fld-current" :title="currentText(activeFileId ?? 0, f.key)">
              {{ currentText(activeFileId ?? 0, f.key) || '（空）' }}
            </div>
          </div>

          <div
            v-for="c in candidates"
            :key="f.key + '-' + c.id"
            class="mg-cell mg-value"
            :class="{
              diff: isDifferent(activeFileId ?? 0, f, c),
              same: !isDifferent(activeFileId ?? 0, f, c),
              picked: pickedId === c.id
            }"
          >
            <template v-if="editingField === f.key && pickedId === c.id">
              <input
                v-model="editModel"
                class="inline-edit"
                @blur="commitEdit"
                @keyup.enter="commitEdit"
              />
            </template>
            <template v-else>
              <span class="val-text" :title="displayValue(activeFileId ?? 0, f, c)">
                {{ displayValue(activeFileId ?? 0, f, c) || '—' }}
              </span>
              <span
                v-if="subScore(c, f.key) !== null"
                class="tag"
                :title="f.label + ' 维度得分'"
              >
                {{ subScore(c, f.key) }}
              </span>
              <button
                v-if="pickedId === c.id && f.writable"
                class="btn mini"
                title="手动修改该字段"
                @click="startEdit(f)"
              >
                改
              </button>
            </template>
          </div>
        </template>
      </div>
    </div>

    <PreviewDialog
      v-if="preview"
      :report="preview"
      title="写回预览（逐字段 old → new，确认后才会执行）"
      confirm-text="确认写回"
      @confirm="confirmPreview"
      @cancel="preview = null"
    />

    <ConfirmDialog
      v-if="clearDialog"
      title="都不用候选"
      message="将清空这些文件的匹配结果，文件保持未匹配状态（可稍后重新查询）。"
      confirm-text="确认"
      danger
      @confirm="doClearPicks"
      @cancel="clearDialog = false"
    />
  </div>
</template>

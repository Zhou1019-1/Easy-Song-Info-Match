<script setup lang="ts">
/**
 * 歌词：候选自选 + 落地方式（内嵌 / .lrc / 两者）+ 偏移 + 覆盖保护。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import type { LyricCandidate, LyricWriteOptions } from '@shared/types'
import { safeCall } from '../lib/api'
import { toast } from '../lib/toast'
import { similarity } from '../lib/format'
import { ensureSettings, lyricResults, settings, trackCache } from '../lib/store'
import ConfirmDialog from './ConfirmDialog.vue'

/** 标题相似度阈值（低于此值给出「可能不是同一首歌」提示）。 */
const TITLE_GUARD = 0.55

type Landing = 'embedded' | 'lrc' | 'both' | 'none'

const LANDING_LABELS: Record<Landing, string> = {
  embedded: '写内嵌歌词',
  lrc: '生成 .lrc',
  both: '两者都要',
  none: '不落地'
}

const results = lyricResults
const picks = reactive<Record<number, string>>({})
/** 落地方式：内嵌 / .lrc 两个勾选项，另有「两者都要」联动项。 */
const landing = reactive<Record<number, { embedded: boolean; lrc: boolean }>>({})
const offsets = reactive<Record<number, number>>({})
const overwriteFlags = reactive<Record<number, boolean>>({})

const confirmVisible = ref(false)
const confirmGroups = ref<
  Array<{
    landing: Landing
    overwrite: boolean
    offsetMs: number
    fileIds: number[]
    candidateIds: Record<number, string>
  }>
>([])

onMounted(() => {
  void ensureSettings()
})

function fileName(fileId: number): string {
  return trackCache.get(fileId)?.filename ?? `#${fileId}`
}

function trackTitle(fileId: number): string {
  const t = trackCache.get(fileId)?.tags
  return t?.title?.[0] ?? trackCache.get(fileId)?.filename ?? ''
}

function lyricState(fileId: number): string {
  const s = trackCache.get(fileId)?.lyricState ?? 'none'
  return s === 'none' ? '无歌词' : s
}

function hasLyrics(fileId: number): boolean {
  const s = trackCache.get(fileId)?.lyricState ?? 'none'
  return s !== 'none' && s !== 'pending'
}

function sourceLabel(c: LyricCandidate): string {
  if (c.source === 'plugin') return `音源插件${c.pluginId ? '（' + c.pluginId + '）' : ''}`
  if (c.source === 'local') return '本地文件'
  if (c.source === 'musicbrainz') return 'MusicBrainz'
  return '远程来源'
}

function previewLines(c: LyricCandidate): string {
  return c.content
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .slice(0, 8)
    .join('\n')
}

function titleSimilar(c: LyricCandidate, fileId: number): number {
  return similarity(c.title, trackTitle(fileId))
}

function titleOk(c: LyricCandidate, fileId: number): boolean {
  return titleSimilar(c, fileId) >= TITLE_GUARD
}

function coverageText(c: LyricCandidate): string {
  return `${Math.round(c.coverage * 100)}%`
}

function globalOffset(): number {
  return settings.value?.globalLyricOffset ?? 0
}

function offsetOf(fileId: number): number {
  return offsets[fileId] ?? globalOffset()
}

function pickCandidate(fileId: number, c: LyricCandidate): void {
  picks[fileId] = c.id
}

function setLanding(fileId: number, mode: Landing): void {
  landing[fileId] =
    mode === 'both'
      ? { embedded: true, lrc: true }
      : mode === 'embedded'
        ? { embedded: true, lrc: false }
        : mode === 'lrc'
          ? { embedded: false, lrc: true }
          : { embedded: false, lrc: false }
}

function landingOf(fileId: number): Landing {
  const l = landing[fileId]
  if (!l) return 'embedded'
  if (l.embedded && l.lrc) return 'both'
  if (l.embedded) return 'embedded'
  if (l.lrc) return 'lrc'
  return 'none'
}

const pickedCount = computed(() => results.value.filter((r) => picks[r.fileId]).length)

/** 按曲微调偏移（记忆）。 */
async function saveOffset(fileId: number): Promise<void> {
  const off = offsetOf(fileId)
  await safeCall((api) => api.lyricSetOffset(fileId, off), null, '保存歌词偏移')
  toast.success(`已记住《${fileName(fileId)}》的歌词偏移 ${off}ms`)
}

function buildGroups(): Array<{
  landing: Landing
  overwrite: boolean
  offsetMs: number
  fileIds: number[]
  candidateIds: Record<number, string>
}> {
  const map = new Map<
    string,
    { landing: Landing; overwrite: boolean; offsetMs: number; fileIds: number[]; candidateIds: Record<number, string> }
  >()
  for (const r of results.value) {
    const cid = picks[r.fileId]
    if (!cid) continue
    const mode = landingOf(r.fileId)
    if (mode === 'none') continue
    const ow = !!overwriteFlags[r.fileId] && hasLyrics(r.fileId)
    const off = offsetOf(r.fileId)
    const key = `${mode}|${ow}|${off}`
    let g = map.get(key)
    if (!g) {
      g = { landing: mode, overwrite: ow, offsetMs: off, fileIds: [], candidateIds: {} }
      map.set(key, g)
    }
    g.fileIds.push(r.fileId)
    g.candidateIds[r.fileId] = cid
  }
  return [...map.values()]
}

async function prepareWrite(): Promise<void> {
  const groups = buildGroups()
  if (!groups.length) {
    toast.warn('请先为每个文件选择一份歌词候选')
    return
  }
  confirmGroups.value = groups
  confirmVisible.value = true
}

async function doWrite(): Promise<void> {
  const groups = confirmGroups.value
  confirmVisible.value = false
  for (const g of groups) {
    const options: LyricWriteOptions = {
      embedded: g.landing === 'embedded' || g.landing === 'both',
      lrcFile: g.landing === 'lrc' || g.landing === 'both',
      overwrite: g.overwrite,
      offsetMs: g.offsetMs
    }
    const res = await safeCall(
      (api) => api.lyricWrite(g.fileIds, g.candidateIds, options),
      null,
      '写入歌词'
    )
    if (res) {
      toast.success(`歌词写入完成：成功 ${res.written} 项，失败 ${res.failed.length} 项`)
      for (const f of res.failed) toast.error(`${f.path}：${f.reason}`)
    }
  }
}
</script>

<template>
  <div class="view lyrics-view">
    <div class="toolbar">
      <div class="tb-group">
        <button class="btn primary" :disabled="!pickedCount" @click="prepareWrite">写入歌词</button>
      </div>
      <div class="tb-group right">
        <span class="counter">已选 {{ pickedCount }} / {{ results.length }} 个文件</span>
      </div>
    </div>

    <div v-if="!results.length" class="empty">
      尚无歌词候选。<br />
      请在「音乐库」中勾选文件 → 点击「歌词补齐」。
    </div>

    <div v-else class="lyric-scroll">
      <div v-for="r in results" :key="r.fileId" class="lyric-file">
        <div class="lyric-file-head">
          <span class="lyric-file-name" :title="trackCache.get(r.fileId)?.path ?? ''">
            {{ fileName(r.fileId) }}
          </span>
          <span class="tag">{{ trackTitle(r.fileId) }}</span>
          <span class="tag" :class="{ warn: hasLyrics(r.fileId) }">已有歌词：{{ lyricState(r.fileId) }}</span>
        </div>

        <div v-if="!r.candidates.length" class="cand-card">
          <span style="color: var(--text-faint)">没有查到歌词候选（可稍后重试，或使用音源插件补齐）。</span>
        </div>

        <div v-else class="cand-list">
          <label
            v-for="c in r.candidates"
            :key="c.id"
            class="cand-card"
            :class="{ active: picks[r.fileId] === c.id }"
          >
            <input
              type="radio"
              :name="'lyric-' + r.fileId"
              :checked="picks[r.fileId] === c.id"
              @change="pickCandidate(r.fileId, c)"
            />
            <div class="cand-body">
              <div class="cand-top">
                <span class="tag">{{ sourceLabel(c) }}</span>
                <span class="tag">评分 {{ c.score }}</span>
                <span class="tag" :class="{ warn: !c.timed }">
                  {{ c.timed ? '带时间轴' : '无时间轴' }}
                </span>
                <span class="tag">时间轴覆盖 {{ coverageText(c) }}</span>
                <span class="tag">{{ c.lineCount }} 行</span>
              </div>
              <div class="cand-title">{{ c.title }} — {{ c.artist }}</div>
              <div v-if="!titleOk(c, r.fileId)" class="cand-warn">
                ⚠ 标题相似度 {{ Math.round(titleSimilar(c, r.fileId) * 100) }}%，可能不是同一首歌，请人工确认
              </div>
              <pre class="lyric-preview">{{ previewLines(c) }}</pre>
            </div>
          </label>
        </div>

        <div class="lyric-options">
          <div class="opt-group">
            <span class="opt-label">落地方式</span>
            <label class="chk">
              <input
                type="checkbox"
                :checked="landingOf(r.fileId) === 'embedded' || landingOf(r.fileId) === 'both'"
                @change="setLanding(r.fileId, ($event.target as HTMLInputElement).checked ? 'embedded' : 'none')"
              />
              写内嵌歌词
            </label>
            <label class="chk">
              <input
                type="checkbox"
                :checked="landingOf(r.fileId) === 'lrc' || landingOf(r.fileId) === 'both'"
                @change="setLanding(r.fileId, ($event.target as HTMLInputElement).checked ? 'lrc' : 'none')"
              />
              生成 .lrc
            </label>
            <label class="chk">
              <input
                type="checkbox"
                :checked="landingOf(r.fileId) === 'both'"
                @change="setLanding(r.fileId, ($event.target as HTMLInputElement).checked ? 'both' : 'none')"
              />
              两者都要
            </label>
          </div>

          <div class="opt-group">
            <span class="opt-label">歌词偏移</span>
            <input
              type="number"
              step="50"
              min="-500"
              max="500"
              style="width: 92px"
              :value="offsetOf(r.fileId)"
              @input="offsets[r.fileId] = Number(($event.target as HTMLInputElement).value)"
            />
            <span>ms</span>
            <button class="btn mini" @click="saveOffset(r.fileId)">按曲记忆</button>
          </div>

          <div class="opt-group">
            <label class="chk">
              <input type="checkbox" v-model="overwriteFlags[r.fileId]" :disabled="!hasLyrics(r.fileId)" />
              覆盖已有歌词
            </label>
            <span v-if="!hasLyrics(r.fileId)" style="color: var(--text-faint)">（该文件暂无歌词，默认不覆盖）</span>
          </div>
        </div>
      </div>
    </div>

    <ConfirmDialog
      v-if="confirmVisible"
      title="写入歌词前确认"
      message="请确认将要写入的歌词内容与落地方式。"
      confirm-text="确认写入"
      @confirm="doWrite"
      @cancel="confirmVisible = false"
    >
      <div style="margin-top: 8px">
        <div v-for="(g, i) in confirmGroups" :key="i" class="issue-item">
          <div>
            <span class="tag">{{ LANDING_LABELS[g.landing] }}</span>
            <span class="tag">偏移 {{ g.offsetMs }}ms</span>
            <span class="tag" :class="{ warn: g.overwrite }">
              {{ g.overwrite ? '覆盖已有歌词' : '不覆盖' }}
            </span>
            <span class="tag">{{ g.fileIds.length }} 个文件</span>
          </div>
          <div style="color: var(--text-dim); margin-top: 3px">
            {{ g.fileIds.map((id) => fileName(id)).join('、') }}
          </div>
        </div>
      </div>
    </ConfirmDialog>
  </div>
</template>

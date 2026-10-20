<script setup lang="ts">
/**
 * 音乐库：虚拟滚动表格 + 批量操作工具栏 + 异常隔离清单。
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { COLUMN_LABELS, EDITABLE_FIELDS, FIELD_LABELS, TABLE_COLUMNS } from '@shared/fields'
import type { ApplyFieldSelection, LibraryQuery, MoveRule, RenameRule } from '@shared/api'
import type { LyricState, MatchState, PreviewReport, TaskInfo, TrackIssue, TrackRecord } from '@shared/types'
import { getApi, safeCall } from '../lib/api'
import { toast } from '../lib/toast'
import { LYRIC_STATE_LABELS, MATCH_STATE_LABELS, formatBytes, formatDuration, joinValues } from '../lib/format'
import { bumpLibraryVersion, libraryVersion, lyricResults, matchResults, selectedIds, trackCache } from '../lib/store'
import type { ViewKey } from '../lib/store'
import VirtualTable from './VirtualTable.vue'
import PreviewDialog from './PreviewDialog.vue'
import ConfirmDialog from './ConfirmDialog.vue'

const emit = defineEmits<{
  (e: 'navigate', view: ViewKey): void
}>()

const columns: readonly string[] = TABLE_COLUMNS

const SCAN_EXTENSIONS = [
  '.flac', '.mp3', '.m4a', '.aac', '.ogg', '.opus', '.ape', '.wav', '.aiff',
  '.aif', '.dsf', '.dff', '.wma', '.mpc', '.wv', '.tta'
]

/* ---------------- 查询与分页 ---------------- */

const query = reactive({
  keyword: '',
  sortBy: 'filename',
  sortDir: 'asc' as 'asc' | 'desc',
  matchState: '',
  lyricState: '',
  hasIssue: false
})

const pageSize = 300
const pages = reactive(new Map<number, TrackRecord[]>())
const loadingPages = new Set<number>()
const total = ref(0)
const loading = ref(false)
const stats = ref<{
  total: number
  byMatchState: Record<string, number>
  byLyricState: Record<string, number>
  issues: number
} | null>(null)
const issues = ref<Array<{ fileId: number; path: string; issues: TrackIssue[] }>>([])
const issuesOpen = ref(false)

function buildQuery(offset: number, limit: number): LibraryQuery {
  return {
    keyword: query.keyword.trim() || undefined,
    matchState: query.matchState || undefined,
    lyricState: query.lyricState || undefined,
    hasIssue: query.hasIssue || undefined,
    sortBy: query.sortBy,
    sortDir: query.sortDir,
    offset,
    limit
  }
}

async function loadPage(index: number, force = false): Promise<void> {
  if (loadingPages.has(index)) return
  if (!force && pages.has(index)) return
  loadingPages.add(index)
  try {
    const res = await safeCall(
      (api) => api.libraryList(buildQuery(index * pageSize, pageSize)),
      null,
      '加载曲库'
    )
    if (res) {
      pages.set(index, res.rows)
      total.value = res.total
      for (const r of res.rows) trackCache.set(r.id, r)
    }
  } finally {
    loadingPages.delete(index)
  }
}

async function loadStats(): Promise<void> {
  stats.value = await safeCall((api) => api.libraryStats(), null, '读取统计')
}

async function loadIssues(): Promise<void> {
  issues.value = await safeCall((api) => api.issuesList(300), [], '读取异常清单')
}

function resetAndLoad(): void {
  pages.clear()
  total.value = 0
  loading.value = true
  void loadPage(0, true).then(() => {
    loading.value = false
  })
  void loadStats()
}

function getRow(index: number): TrackRecord | undefined {
  const page = pages.get(Math.floor(index / pageSize))
  return page?.[index % pageSize]
}

function onRange(start: number, end: number): void {
  const p0 = Math.floor(start / pageSize)
  const p1 = Math.floor(end / pageSize)
  for (let p = p0; p <= p1; p++) void loadPage(p)
}

let keywordTimer: number | undefined
watch(
  () => query.keyword,
  () => {
    window.clearTimeout(keywordTimer)
    keywordTimer = window.setTimeout(resetAndLoad, 320)
  }
)

watch(
  () => [query.matchState, query.lyricState, query.hasIssue],
  () => resetAndLoad()
)

watch(
  () => [query.sortBy, query.sortDir],
  () => resetAndLoad()
)

watch(libraryVersion, () => {
  resetAndLoad()
  void loadIssues()
})

/* ---------------- 选择 ---------------- */

const selectedCount = computed(() => selectedIds.size)
const anchorIndex = ref(-1)

function isSelected(row: TrackRecord | undefined): boolean {
  return !!row && selectedIds.has(row.id)
}

function toggleRow(index: number): void {
  const row = getRow(index)
  if (!row) return
  if (selectedIds.has(row.id)) selectedIds.delete(row.id)
  else selectedIds.add(row.id)
  anchorIndex.value = index
}

function onRowClick(e: MouseEvent, index: number): void {
  const row = getRow(index)
  if (!row) return
  if (e.shiftKey && anchorIndex.value >= 0) {
    void rangeSelect(anchorIndex.value, index)
  } else if (e.ctrlKey || e.metaKey) {
    if (selectedIds.has(row.id)) selectedIds.delete(row.id)
    else selectedIds.add(row.id)
    anchorIndex.value = index
  } else {
    selectedIds.clear()
    selectedIds.add(row.id)
    anchorIndex.value = index
  }
}

async function rangeSelect(a: number, b: number): Promise<void> {
  const lo = Math.min(a, b)
  const hi = Math.max(a, b)
  const p0 = Math.floor(lo / pageSize)
  const p1 = Math.floor(hi / pageSize)
  for (let p = p0; p <= p1; p++) await loadPage(p)
  selectedIds.clear()
  for (let i = lo; i <= hi; i++) {
    const r = getRow(i)
    if (r) selectedIds.add(r.id)
  }
}

const allLoadedSelected = computed(() => {
  let n = 0
  let all = true
  for (const page of pages.values()) {
    for (const r of page) {
      n++
      if (!selectedIds.has(r.id)) all = false
    }
  }
  return n > 0 && all
})

function toggleSelectAll(): void {
  if (allLoadedSelected.value) {
    for (const page of pages.values()) for (const r of page) selectedIds.delete(r.id)
    return
  }
  for (const page of pages.values()) for (const r of page) selectedIds.add(r.id)
}

async function selectAllFiltered(): Promise<void> {
  const ids: number[] = []
  let offset = 0
  for (;;) {
    const res = await safeCall((api) => api.libraryList(buildQuery(offset, 2000)), null, '全选')
    if (!res) return
    for (const r of res.rows) {
      ids.push(r.id)
      trackCache.set(r.id, r)
    }
    offset += res.rows.length
    if (!res.rows.length || offset >= res.total) break
  }
  selectedIds.clear()
  for (const id of ids) selectedIds.add(id)
  toast.success(`已选中 ${ids.length} 项`)
}

/* ---------------- 单元格 ---------------- */

function cellText(row: TrackRecord | undefined, col: string): string {
  if (!row) return ''
  switch (col) {
    case 'filename':
      return row.filename
    case 'lyricState':
      return LYRIC_STATE_LABELS[row.lyricState] ?? row.lyricState
    case 'matchState':
      return MATCH_STATE_LABELS[row.matchState] ?? row.matchState
    default:
      return joinValues(row.tags[col])
  }
}

function cellTitle(row: TrackRecord | undefined, col: string): string {
  if (!row) return ''
  if (col === 'filename') {
    return `${row.path}\n${formatDuration(row.duration)} · ${formatBytes(row.size)} · ${row.ext}`
  }
  if (col === 'matchState' && row.issues.length) {
    return row.issues.map((i) => `${i.level}: ${i.message}`).join('\n')
  }
  return cellText(row, col)
}

function issueText(row: TrackRecord): string {
  return row.issues.map((i) => `${i.level}: ${i.message}`).join('\n')
}

function matchLabel(row: TrackRecord | undefined): string {
  const s = (row?.matchState ?? 'none') as MatchState
  return MATCH_STATE_LABELS[s] ?? s
}

function matchClass(row: TrackRecord | undefined): string {
  return `match-${(row?.matchState ?? 'none') as MatchState}`
}

function lyricLabel(row: TrackRecord | undefined): string {
  const s = (row?.lyricState ?? 'none') as LyricState
  return LYRIC_STATE_LABELS[s] ?? s
}

function lyricClass(row: TrackRecord | undefined): string {
  return (row?.lyricState ?? 'none') === 'none' ? 'lyric lyric-none' : 'lyric'
}

function toggleSort(col: string): void {
  if (query.sortBy === col) query.sortDir = query.sortDir === 'asc' ? 'desc' : 'asc'
  else {
    query.sortBy = col
    query.sortDir = 'asc'
  }
}

function sortInd(col: string): string {
  if (query.sortBy !== col) return ''
  return query.sortDir === 'asc' ? '▲' : '▼'
}

const statsText = computed(() => {
  const s = stats.value
  if (!s) return ''
  const pending = s.byMatchState?.pending ?? 0
  const matched = s.byMatchState?.matched ?? 0
  return `共 ${s.total} 首 · 待确认 ${pending} · 已匹配 ${matched} · 异常 ${s.issues}`
})

/* ---------------- 工具栏动作 ---------------- */

async function chooseFolder(): Promise<void> {
  const dirs = await safeCall((api) => api.pickDirectories(), [] as string[], '选择文件夹')
  if (!dirs.length) return
  const res = await safeCall(
    (api) =>
      api.scanStart({
        roots: dirs,
        recursive: true,
        followSymlinks: false,
        extensions: SCAN_EXTENSIONS,
        computeHash: true,
        parseCue: true
      }),
    null,
    '启动扫描'
  )
  if (res) {
    toast.success('扫描已开始，可在任务中心查看进度')
    emit('navigate', 'tasks')
  }
}

async function runMatch(): Promise<void> {
  const ids = [...selectedIds]
  if (!ids.length) return
  const res = await safeCall((api) => api.matchQuery(ids, false), null, '查询匹配')
  if (!res) return
  matchResults.value = res
  emit('navigate', 'match')
}

async function runLyrics(): Promise<void> {
  const ids = [...selectedIds]
  if (!ids.length) return
  const res = await safeCall((api) => api.lyricQuery(ids), null, '查询歌词')
  if (!res) return
  lyricResults.value = res
  emit('navigate', 'lyrics')
}

/* ---------------- 重命名 / 移动 / 清空 ---------------- */

const renameDialog = ref(false)
const renameTemplate = ref('{track} {title} - {artist}')
const moveDialog = ref(false)
const moveTemplate = ref('{artist}/{album}/{year}')
const moveMode = ref<'move' | 'copy'>('move')
const clearDialog = ref(false)
const clearFields = ref<string[]>(['album'])
const preview = ref<PreviewReport | null>(null)
const previewTitle = ref('写回预览')
const pendingAction = ref<'rename' | 'move' | 'clear' | null>(null)

const fieldChoices = EDITABLE_FIELDS.map((f) => ({ key: f, label: FIELD_LABELS[f] ?? f }))

function pathOf(fileId: number): string {
  return trackCache.get(fileId)?.path ?? ''
}

async function openRename(): Promise<void> {
  if (!selectedCount.value) return
  renameDialog.value = true
}

async function openMove(): Promise<void> {
  if (!selectedCount.value) return
  moveDialog.value = true
}

async function openClear(): Promise<void> {
  if (!selectedCount.value) return
  clearDialog.value = true
}

async function doRenamePreview(): Promise<void> {
  const ids = [...selectedIds]
  const rule: RenameRule = { template: renameTemplate.value }
  const res = await safeCall((api) => api.renamePreview(ids, rule), null, '重命名预览')
  if (!res) return
  renameDialog.value = false
  preview.value = res
  previewTitle.value = '重命名预览（确认后才会执行）'
  pendingAction.value = 'rename'
}

async function doMovePreview(): Promise<void> {
  const ids = [...selectedIds]
  const rule: MoveRule = { template: moveTemplate.value, mode: moveMode.value }
  const res = await safeCall((api) => api.movePreview(ids, rule), null, '归档移动预览')
  if (!res) return
  moveDialog.value = false
  preview.value = res
  previewTitle.value = '归档移动预览（确认后才会执行）'
  pendingAction.value = 'move'
}

async function doClearPreview(): Promise<void> {
  const ids = [...selectedIds]
  if (!clearFields.value.length) {
    toast.warn('请至少选择一个要清空的字段')
    return
  }
  const res = await safeCall(
    (api) => api.clearFieldsPreview(ids, clearFields.value),
    null,
    '清空字段预览'
  )
  if (!res) return
  clearDialog.value = false
  preview.value = res
  previewTitle.value = '清空字段预览（确认后才会执行）'
  pendingAction.value = 'clear'
}

async function confirmPreview(overwrite: boolean): Promise<void> {
  const action = pendingAction.value
  const ids = [...selectedIds]
  if (!action) return

  if (action === 'rename') {
    const api = getApi()
    if (!api?.renameExecute) {
      toast.error('主进程未提供重命名执行接口（renameExecute），无法执行')
      return
    }
    const res = await safeCall(
      (a) => a.renameExecute!(ids, { template: renameTemplate.value }),
      null,
      '执行重命名'
    )
    preview.value = null
    pendingAction.value = null
    if (res) {
      toast.success(`重命名完成：成功 ${res.written} 个，失败 ${res.failed.length} 个`)
      bumpLibraryVersion()
    }
    return
  }

  if (action === 'move') {
    const api = getApi()
    if (!api?.moveExecute) {
      toast.error('主进程未提供归档移动执行接口（moveExecute），无法执行')
      return
    }
    const res = await safeCall(
      (a) => a.moveExecute!(ids, { template: moveTemplate.value, mode: moveMode.value }),
      null,
      '执行归档移动'
    )
    preview.value = null
    pendingAction.value = null
    if (res) {
      toast.success(`归档移动完成：成功 ${res.written} 个，失败 ${res.failed.length} 个`)
      bumpLibraryVersion()
    }
    return
  }

  // 清空字段：走 matchApplyExecute（契约中唯一可执行字段写入的接口）
  const items: ApplyFieldSelection[] = ids.map((id) => ({
    fileId: id,
    path: pathOf(id),
    fields: {},
    sources: {},
    clearFields: [...clearFields.value]
  }))
  const res = await safeCall((api) => api.matchApplyExecute(items, overwrite), null, '清空字段')
  preview.value = null
  pendingAction.value = null
  if (res) {
    toast.success(`清空完成：${res.message}`)
    bumpLibraryVersion()
  }
}

function cancelPreview(): void {
  preview.value = null
  pendingAction.value = null
}

/* ---------------- 撤销 ---------------- */

const undoDialog = ref(false)
const undoEntries = ref<Array<{ batchId: string; opType: string; createdAt: number; count: number; undone: boolean }>>([])

async function openUndo(): Promise<void> {
  undoEntries.value = await safeCall((api) => api.undoList(), [], '读取撤销记录')
  undoDialog.value = true
}

async function doUndo(batchId: string): Promise<void> {
  const res = await safeCall((api) => api.undoApply(batchId), null, '撤销')
  if (res) {
    toast.success(res.message)
    undoEntries.value = await safeCall((api) => api.undoList(), [], '读取撤销记录')
    bumpLibraryVersion()
  }
}

/* ---------------- 任务订阅（扫描完成后刷新） ---------------- */

let unsubscribe: (() => void) | null = null

onMounted(() => {
  resetAndLoad()
  void loadIssues()
  const api = getApi()
  if (!api) return
  unsubscribe = api.onTaskUpdate((task: TaskInfo) => {
    if (task.type === 'scan' && (task.status === 'done' || task.status === 'failed')) {
      bumpLibraryVersion()
    }
  })
})

onBeforeUnmount(() => {
  unsubscribe?.()
  unsubscribe = null
})
</script>

<template>
  <div class="view library-view">
    <div class="toolbar">
      <div class="tb-group">
        <button class="btn primary" @click="chooseFolder">选择文件夹</button>
        <button class="btn" :disabled="!selectedCount" @click="runMatch">查询匹配</button>
        <button class="btn" :disabled="!selectedCount" @click="runLyrics">歌词补齐</button>
        <button class="btn" :disabled="!selectedCount" @click="openRename">重命名</button>
        <button class="btn" :disabled="!selectedCount" @click="openMove">归档移动</button>
        <button class="btn" :disabled="!selectedCount" @click="openClear">批量清空字段</button>
        <button class="btn" :disabled="!selectedCount" @click="openUndo">撤销</button>
      </div>
      <div class="tb-group right">
        <span class="counter">已选 {{ selectedCount }} 项</span>
        <button class="btn ghost" @click="selectAllFiltered">全选筛选结果</button>
        <button class="btn ghost" @click="selectedIds.clear()">取消选择</button>
      </div>
    </div>

    <div class="filterbar">
      <input
        class="search"
        v-model="query.keyword"
        type="search"
        placeholder="搜索文件名 / 标题 / 歌手 / 专辑…"
      />
      <select v-model="query.matchState" title="匹配状态">
        <option value="">全部匹配状态</option>
        <option v-for="(label, key) in MATCH_STATE_LABELS" :key="key" :value="key">{{ label }}</option>
      </select>
      <select v-model="query.lyricState" title="歌词状态">
        <option value="">全部歌词状态</option>
        <option v-for="(label, key) in LYRIC_STATE_LABELS" :key="key" :value="key">{{ label }}</option>
      </select>
      <label class="chk">
        <input type="checkbox" v-model="query.hasIssue" />
        仅看异常
      </label>
      <span class="stat-line">{{ statsText }}</span>
      <span v-if="loading" class="stat-line">加载中…</span>
    </div>

    <div class="table-wrap">
      <VirtualTable :total="total" :row-height="30" :get-row="getRow" @range="onRange">
        <template #header>
          <div class="lib-grid lib-head">
            <div class="cell chk-cell">
              <input type="checkbox" :checked="allLoadedSelected" @change="toggleSelectAll" />
            </div>
            <div
              v-for="col in columns"
              :key="col"
              class="cell head-cell sortable"
              :title="'按 ' + (COLUMN_LABELS[col] ?? col) + ' 排序'"
              @click="toggleSort(col)"
            >
              {{ COLUMN_LABELS[col] ?? col }}
              <span class="sort-ind">{{ sortInd(col) }}</span>
            </div>
          </div>
        </template>

        <template #default="{ row, index }">
          <div
            class="lib-grid lib-row"
            :class="{ selected: isSelected(row) }"
            @click="onRowClick($event, index)"
          >
            <div class="cell chk-cell">
              <input
                type="checkbox"
                :checked="isSelected(row)"
                @click.stop
                @change="toggleRow(index)"
              />
            </div>
            <div
              v-for="col in columns"
              :key="col"
              class="cell"
              :class="{ 'badge-cell': col === 'matchState' || col === 'lyricState' }"
              :title="cellTitle(row, col)"
            >
              <template v-if="col === 'matchState'">
                <span class="badge" :class="matchClass(row)">{{ matchLabel(row) }}</span>
                <span v-if="row && row.issues.length" class="badge issue" :title="issueText(row)">
                  异常
                </span>
              </template>
              <template v-else-if="col === 'lyricState'">
                <span class="badge" :class="lyricClass(row)">{{ lyricLabel(row) }}</span>
              </template>
              <template v-else>{{ cellText(row, col) }}</template>
            </div>
          </div>
        </template>
      </VirtualTable>

      <div v-if="!total && !loading" class="empty">
        曲库为空。点击「选择文件夹」扫描本地音频文件；<br />
        解析失败或存在异常的文件不会丢失，会在下方「异常清单」中列出。
      </div>
    </div>

    <div class="issues-panel">
      <div class="issues-head" @click="issuesOpen = !issuesOpen">
        <span>{{ issuesOpen ? '▾' : '▸' }}</span>
        <span>异常清单（{{ issues.length }}）</span>
        <span style="color: var(--text-faint)">解析失败 / 标签与文件名矛盾 / 无法确定歌手</span>
      </div>
      <div v-if="issuesOpen" class="issue-list">
        <div v-if="!issues.length" class="issue-msg info">暂无异常记录。</div>
        <div v-for="it in issues" :key="it.fileId" class="issue-item">
          <div class="issue-path" :title="it.path">{{ it.path }}</div>
          <div
            v-for="(is, i) in it.issues"
            :key="i"
            class="issue-msg"
            :class="is.level"
          >
            [{{ is.code }}] {{ is.message }}{{ is.detail ? ' — ' + is.detail : '' }}
          </div>
        </div>
      </div>
    </div>

    <!-- 重命名 -->
    <ConfirmDialog
      v-if="renameDialog"
      title="按标签重命名"
      message="使用模板生成新文件名，可用变量：{track} {title} {artist} {album} {year}。"
      confirm-text="生成预览"
      @confirm="doRenamePreview"
      @cancel="renameDialog = false"
    >
      <div style="margin-top: 8px">
        <input
          v-model="renameTemplate"
          class="input"
          style="width: 100%"
          placeholder="{track} {title} - {artist}"
        />
      </div>
    </ConfirmDialog>

    <!-- 归档移动 -->
    <ConfirmDialog
      v-if="moveDialog"
      title="按标签归档移动"
      message="可用变量：{artist} {album} {year} {title}。同名文件将自动加序号，绝不覆盖。"
      confirm-text="生成预览"
      @confirm="doMovePreview"
      @cancel="moveDialog = false"
    >
      <div style="margin-top: 8px; display: flex; gap: 8px; align-items: center">
        <input v-model="moveTemplate" class="input" style="flex: 1" placeholder="{artist}/{album}/{year}" />
        <label class="chk">
          <input type="radio" value="move" v-model="moveMode" /> 移动
        </label>
        <label class="chk">
          <input type="radio" value="copy" v-model="moveMode" /> 复制
        </label>
      </div>
    </ConfirmDialog>

    <!-- 清空字段 -->
    <ConfirmDialog
      v-if="clearDialog"
      title="批量清空字段"
      message="勾选要清空的字段，清空操作同样可撤销。"
      confirm-text="生成预览"
      @confirm="doClearPreview"
      @cancel="clearDialog = false"
    >
      <div
        style="margin-top: 8px; max-height: 260px; overflow: auto; display: grid; grid-template-columns: 1fr 1fr; gap: 4px 12px"
      >
        <label v-for="f in fieldChoices" :key="f.key" class="chk">
          <input type="checkbox" :value="f.key" v-model="clearFields" />
          {{ f.label }}
        </label>
      </div>
    </ConfirmDialog>

    <!-- 撤销 -->
    <ConfirmDialog
      v-if="undoDialog"
      title="撤销记录"
      message="选择一次批量操作进行撤销。"
      confirm-text="关闭"
      @confirm="undoDialog = false"
      @cancel="undoDialog = false"
    >
      <div style="margin-top: 8px; max-height: 300px; overflow: auto">
        <div v-if="!undoEntries.length" class="issue-msg info">暂无撤销记录。</div>
        <div
          v-for="u in undoEntries"
          :key="u.batchId"
          style="display: flex; align-items: center; gap: 8px; padding: 4px 0; border-bottom: 1px solid var(--border)"
        >
          <span class="tag">{{ u.opType }}</span>
          <span style="flex: 1; color: var(--text-dim)">
            {{ u.count }} 项 · {{ new Date(u.createdAt).toLocaleString() }}
          </span>
          <button class="btn mini" :disabled="u.undone" @click="doUndo(u.batchId)">
            {{ u.undone ? '已撤销' : '撤销' }}
          </button>
        </div>
      </div>
    </ConfirmDialog>

    <PreviewDialog
      v-if="preview"
      :report="preview"
      :title="previewTitle"
      @confirm="confirmPreview"
      @cancel="cancelPreview"
    />
  </div>
</template>

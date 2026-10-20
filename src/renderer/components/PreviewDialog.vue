<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { PreviewReport } from '@shared/types'
import { FIELD_SOURCE_LABELS } from '@shared/types'
import ModalShell from './ModalShell.vue'

const props = defineProps<{
  report: PreviewReport | null
  title?: string
  confirmText?: string
}>()

const emit = defineEmits<{
  (e: 'confirm', overwrite: boolean): void
  (e: 'cancel'): void
}>()

const overwrite = ref(false)

watch(
  () => props.report,
  () => {
    overwrite.value = false
  }
)

/** 存在旧值（非空）的字段：覆盖模式才写入。 */
const needsOverwrite = computed(() =>
  (props.report?.items ?? []).some((i) => i.diffs.some((d) => !!d.oldValue))
)

const canConfirm = computed(() => !needsOverwrite.value || overwrite.value)

const changedItems = computed(() => (props.report?.items ?? []).filter((i) => i.diffs.length > 0))

function statusLabel(s: string): string {
  switch (s) {
    case 'changed':
      return '将变更'
    case 'unchanged':
      return '无变化'
    case 'failed':
      return '失败'
    default:
      return '跳过'
  }
}
</script>

<template>
  <ModalShell
    :title="title ?? '写回预览（确认后才会执行）'"
    width="900px"
    @close="emit('cancel')"
  >
    <template v-if="report">
      <div class="warn-list" v-if="report.warnings.length">
        <strong>注意</strong>
        <ul>
          <li v-for="(w, i) in report.warnings" :key="i">{{ w }}</li>
        </ul>
      </div>

      <div style="margin-bottom: 8px; color: var(--text-dim)">
        共 {{ report.summary.total }} 项 · 将变更 {{ report.summary.changed }} · 无变化
        {{ report.summary.unchanged }} · 失败 {{ report.summary.failed }} · 跳过
        {{ report.summary.skipped }}
      </div>

      <div v-if="!changedItems.length" style="color: var(--text-faint)">没有任何字段会发生变化。</div>

      <table v-else class="diff-table">
        <thead>
          <tr>
            <th style="width: 26%">文件</th>
            <th style="width: 12%">字段</th>
            <th style="width: 24%">旧值</th>
            <th style="width: 24%">新值</th>
            <th style="width: 14%">来源</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="item in changedItems" :key="item.fileId">
            <tr v-if="item.newPath">
              <td :title="item.path">{{ item.filename }}</td>
              <td colspan="3">
                <span class="diff-old">{{ item.path }}</span>
                → <span class="diff-new">{{ item.newPath }}</span>
              </td>
              <td>—</td>
            </tr>
            <tr v-if="item.status === 'failed' || item.status === 'skipped'">
              <td :title="item.path">{{ item.filename }}</td>
              <td colspan="3" :style="{ color: item.status === 'failed' ? '#ff8b83' : 'var(--text-dim)' }">
                {{ statusLabel(item.status) }}{{ item.message ? '：' + item.message : '' }}
              </td>
              <td>—</td>
            </tr>
            <tr v-for="d in item.diffs" :key="d.field">
              <td :title="item.path">{{ item.filename }}</td>
              <td>{{ d.label }}</td>
              <td class="diff-old">{{ d.oldValue ?? '（空）' }}</td>
              <td class="diff-new">{{ d.newValue ?? '（清空）' }}</td>
              <td>{{ FIELD_SOURCE_LABELS[d.source] ?? d.source }}</td>
            </tr>
          </template>
        </tbody>
      </table>
    </template>

    <template #foot>
      <label v-if="needsOverwrite" class="chk spacer" style="margin-right: auto">
        <input type="checkbox" v-model="overwrite" />
        覆盖已有值（覆盖模式，将重新生成预览）
      </label>
      <span v-else class="spacer">本操作不改动已有值</span>
      <button class="btn" @click="emit('cancel')">取消</button>
      <button class="btn primary" :disabled="!canConfirm" @click="emit('confirm', overwrite)">
        {{ confirmText ?? '确认执行' }}
      </button>
    </template>
  </ModalShell>
</template>

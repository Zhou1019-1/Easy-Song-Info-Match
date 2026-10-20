<script setup lang="ts">
/**
 * 任务中心：批量操作（扫描 / 写回 / 歌词 / 移动…）的实时进度。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { TaskInfo } from '@shared/types'
import { getApi, safeCall } from '../lib/api'
import { toast } from '../lib/toast'
import { formatDateTime } from '../lib/format'

const tasks = ref<TaskInfo[]>([])
let unsubscribe: (() => void) | null = null

function upsert(task: TaskInfo): void {
  const i = tasks.value.findIndex((t) => t.id === task.id)
  if (i >= 0) tasks.value[i] = task
  else tasks.value = [task, ...tasks.value]
}

async function load(): Promise<void> {
  tasks.value = await safeCall((api) => api.taskList(), [], '读取任务列表')
}

onMounted(() => {
  void load()
  const api = getApi()
  if (!api) {
    toast.warn('主进程未就绪，任务列表为空')
    return
  }
  unsubscribe = api.onTaskUpdate((task: TaskInfo) => upsert(task))
})

onBeforeUnmount(() => {
  unsubscribe?.()
  unsubscribe = null
})

async function cancel(t: TaskInfo): Promise<void> {
  await safeCall((api) => api.taskCancel(t.id), null, '取消任务')
  toast.info(`已请求取消：${t.title}`)
}

function percent(t: TaskInfo): number {
  if (t.total > 0) return Math.max(0, Math.min(100, Math.round((t.progress / t.total) * 100)))
  if (t.status === 'done') return 100
  if (t.status === 'running') return 35
  return 0
}

function statusLabel(s: TaskInfo['status']): string {
  switch (s) {
    case 'queued':
      return '排队中'
    case 'running':
      return '进行中'
    case 'done':
      return '已完成'
    case 'failed':
      return '失败'
    default:
      return '已取消'
  }
}
</script>

<template>
  <div class="view tasks-view">
    <div class="toolbar">
      <div class="tb-group">
        <button class="btn" @click="load">刷新</button>
      </div>
      <div class="tb-group right">
        <span class="counter">共 {{ tasks.length }} 个任务</span>
      </div>
    </div>

    <div class="task-list">
      <div v-if="!tasks.length" class="empty">暂无任务。扫描、写回歌词、批量改名等操作都会在这里显示进度。</div>

      <div v-for="t in tasks" :key="t.id" class="task">
        <div class="t-head">
          <span class="t-title">{{ t.title }}</span>
          <span class="tag">{{ t.type }}</span>
          <span class="t-status" :class="t.status">{{ statusLabel(t.status) }}</span>
          <span style="flex: 1" />
          <span class="tag">{{ formatDateTime(t.createdAt) }}</span>
          <button
            v-if="t.status === 'running' || t.status === 'queued'"
            class="btn mini danger"
            @click="cancel(t)"
          >
            取消
          </button>
        </div>
        <div class="progress">
          <div class="bar" :style="{ width: percent(t) + '%' }" />
        </div>
        <div class="t-meta">
          <span v-if="t.total > 0">{{ t.progress }} / {{ t.total }}</span>
          <span v-if="t.message"> · {{ t.message }}</span>
        </div>
        <div v-if="t.error" class="t-error">{{ t.error }}</div>
      </div>
    </div>
  </div>
</template>

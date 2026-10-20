<script setup lang="ts">
/**
 * 插件：用户自行导入的音源插件（洛雪格式 .js）管理。
 */
import { onMounted, reactive, ref } from 'vue'
import type { PluginInfo } from '@shared/types'
import { safeCall } from '../lib/api'
import { toast } from '../lib/toast'
import { formatDateTime } from '../lib/format'
import ConfirmDialog from './ConfirmDialog.vue'

const plugins = ref<PluginInfo[]>([])
const loading = ref(false)
const rateDraft = reactive<Record<string, number>>({})
const openLog = ref<string | null>(null)
const deleteTarget = ref<PluginInfo | null>(null)

async function load(): Promise<void> {
  loading.value = true
  const list = await safeCall((api) => api.pluginList(), [], '读取插件列表')
  plugins.value = list
  for (const p of list) {
    if (rateDraft[p.id] === undefined) rateDraft[p.id] = p.rateLimit
  }
  loading.value = false
}

onMounted(() => {
  void load()
})

async function importPlugin(): Promise<void> {
  const files = await safeCall((api) => api.pickFiles(), [] as string[], '选择插件文件')
  if (!files.length) return
  let ok = 0
  for (const f of files) {
    const res = await safeCall((api) => api.pluginImport(f), null, `导入 ${f}`)
    if (res) {
      ok++
      if (res.loadError) toast.warn(`${res.name} 导入成功但不兼容：${res.loadError}`)
    }
  }
  if (ok) toast.success(`已导入 ${ok} 个插件`)
  await load()
}

async function toggleEnabled(p: PluginInfo, e: Event): Promise<void> {
  const target = (e.target as HTMLInputElement).checked
  const list = await safeCall((api) => api.pluginSetEnabled(p.id, target), null, '切换插件状态')
  if (list) plugins.value = list
}

async function saveRate(p: PluginInfo): Promise<void> {
  const per = Number(rateDraft[p.id])
  if (!Number.isFinite(per) || per < 0) {
    toast.warn('限速必须是不小于 0 的数字')
    return
  }
  const list = await safeCall((api) => api.pluginSetRateLimit(p.id, per), null, '保存限速')
  if (list) {
    plugins.value = list
    toast.success(`${p.name} 限速已设为 ${per} 次/分钟`)
  }
}

async function confirmDelete(): Promise<void> {
  const p = deleteTarget.value
  deleteTarget.value = null
  if (!p) return
  const list = await safeCall((api) => api.pluginDelete(p.id), null, '删除插件')
  if (list) {
    plugins.value = list
    toast.success(`已删除插件 ${p.name}`)
  }
}

async function openPluginDir(): Promise<void> {
  await safeCall((api) => api.pluginOpenDir(), null, '打开插件目录')
}

function logText(p: PluginInfo): string {
  if (!p.calls.length) return '暂无调用记录'
  return p.calls
    .slice()
    .reverse()
    .map((c) => `${formatDateTime(c.ts)}  ${c.fn}  ${c.ok ? '成功' : '失败'}  ${c.durationMs}ms${c.message ? '  ' + c.message : ''}`)
    .join('\n')
}
</script>

<template>
  <div class="view plugins-view">
    <div class="disclaimer">
      本应用不内置任何音乐音源、不获取 / 不分发音频数据，音源由用户自行导入且合法性自负。
      导入的插件仅在受限沙箱中运行，插件返回的所有数据仍需用户确认后才会写入文件。
    </div>

    <div class="toolbar">
      <div class="tb-group">
        <button class="btn primary" @click="importPlugin">导入音源插件</button>
        <button class="btn" @click="openPluginDir">打开插件目录</button>
        <button class="btn ghost" @click="load">刷新</button>
      </div>
      <div class="tb-group right">
        <span class="counter">共 {{ plugins.length }} 个插件</span>
      </div>
    </div>

    <div class="plugin-list">
      <div v-if="!plugins.length && !loading" class="empty">
        尚未导入任何音源插件。<br />
        插件用于在国内平台（酷狗 / 酷我 / 咪咕 / QQ / 网易）补齐元数据与歌词，缺失时 MusicBrainz / iTunes 仍可独立使用。
      </div>

      <div v-for="p in plugins" :key="p.id" class="plugin-card">
        <div class="p-head">
          <input type="checkbox" :checked="p.enabled" @change="toggleEnabled(p, $event)" />
          <span class="p-name">{{ p.name }}</span>
          <span class="p-ver">v{{ p.version }}</span>
          <span class="tag">{{ p.format === 'lx' ? '洛雪格式' : '未知格式' }}</span>
          <span class="tag" :class="{ warn: !p.loadOk }">{{ p.loadOk ? '加载正常' : '加载异常' }}</span>
          <span style="flex: 1" />
          <span class="tag">导入于 {{ formatDateTime(p.importedAt) }}</span>
          <button class="btn danger mini" @click="deleteTarget = p">删除</button>
        </div>

        <div class="p-meta">
          <span>声明来源：{{ p.sources.length ? p.sources.join('、') : '（未声明）' }}</span>
          <span>音质：{{ p.qualitys.length ? p.qualitys.join('、') : '（未声明）' }}</span>
          <span>调用次数：{{ p.calls.length }}</span>
        </div>

        <div class="p-meta">
          <span class="opt-label">限速</span>
          <input
            type="number"
            min="0"
            style="width: 90px"
            :value="rateDraft[p.id]"
            @input="rateDraft[p.id] = Number(($event.target as HTMLInputElement).value)"
          />
          <span>次/分钟</span>
          <button class="btn mini" @click="saveRate(p)">保存</button>
        </div>

        <div v-if="p.loadError" class="p-error">
          <strong>不兼容提示：</strong>{{ p.loadError }}
        </div>
        <div v-else-if="p.format === 'unknown'" class="p-error">
          <strong>不兼容提示：</strong>无法识别插件格式，musicSearch / musicUrl / lyric / albumArt 接口可能无法按洛雪约定工作。
        </div>

        <div class="p-meta" style="margin-top: 6px">
          <button class="btn mini ghost" @click="openLog = openLog === p.id ? null : p.id">
            {{ openLog === p.id ? '收起调用日志' : '查看调用日志' }}
          </button>
        </div>
        <div v-if="openLog === p.id" class="log-list">
          <div class="log-row" style="white-space: pre-wrap">{{ logText(p) }}</div>
        </div>
      </div>
    </div>

    <ConfirmDialog
      v-if="deleteTarget"
      title="删除插件"
      :message="`确定删除插件「${deleteTarget.name}」吗？`"
      detail="删除后该插件将不再参与查询与歌词补齐，已写入的标签不受影响。"
      confirm-text="删除"
      danger
      @confirm="confirmDelete"
      @cancel="deleteTarget = null"
    />
  </div>
</template>

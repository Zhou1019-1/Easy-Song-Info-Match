<script setup lang="ts">
/**
 * 设置：阈值、限速、歌词偏移、保护艺名、数据目录。
 */
import { onMounted, reactive, ref } from 'vue'
import type { SettingsDto } from '@shared/api'
import { getApi, safeCall } from '../lib/api'
import { toast } from '../lib/toast'
import { ensureSettings, settings } from '../lib/store'

const draft = reactive({
  autoAcceptScore: 60,
  globalLyricOffset: 0,
  mbRateLimit: 1,
  itunesRateLimit: 5,
  protectedArtists: '',
  disclaimerAccepted: false
})

const current = ref<SettingsDto | null>(null)
const saving = ref(false)

function fill(s: SettingsDto): void {
  current.value = s
  draft.autoAcceptScore = s.autoAcceptScore
  draft.globalLyricOffset = s.globalLyricOffset
  draft.mbRateLimit = s.mbRateLimit
  draft.itunesRateLimit = s.itunesRateLimit
  draft.protectedArtists = s.protectedArtists.join('\n')
  draft.disclaimerAccepted = s.disclaimerAccepted
}

onMounted(async () => {
  await ensureSettings()
  if (settings.value) fill(settings.value)
  const s = await safeCall((api) => api.settingsGet(), null, '读取设置')
  if (s) {
    fill(s)
    settings.value = s
  }
})

async function save(): Promise<void> {
  saving.value = true
  const patch: Partial<SettingsDto> = {
    autoAcceptScore: Number(draft.autoAcceptScore),
    globalLyricOffset: Number(draft.globalLyricOffset),
    mbRateLimit: Number(draft.mbRateLimit),
    itunesRateLimit: Number(draft.itunesRateLimit),
    protectedArtists: draft.protectedArtists
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean),
    disclaimerAccepted: draft.disclaimerAccepted
  }
  const s = await safeCall((api) => api.settingsSet(patch), null, '保存设置')
  saving.value = false
  if (s) {
    fill(s)
    settings.value = s
    toast.success('设置已保存')
  }
}

async function openDataDir(): Promise<void> {
  const api = getApi()
  if (!api?.openDataDir) {
    toast.error('主进程未提供打开数据目录接口（openDataDir）')
    return
  }
  await safeCall((a) => a.openDataDir!(), null, '打开数据目录')
}

async function openPluginDir(): Promise<void> {
  await safeCall((api) => api.pluginOpenDir(), null, '打开插件目录')
}
</script>

<template>
  <div class="view settings-view">
    <div class="toolbar">
      <div class="tb-group">
        <button class="btn primary" :disabled="saving" @click="save">保存设置</button>
        <button class="btn ghost" @click="openDataDir">打开数据目录</button>
        <button class="btn ghost" @click="openPluginDir">打开插件目录</button>
      </div>
    </div>

    <div class="form">
      <div class="form-row">
        <div class="label">自动采纳阈值<small>低于此分的候选进入「待确认」，不自动写入</small></div>
        <div class="ctl">
          <input type="number" min="0" max="100" style="width: 90px" v-model.number="draft.autoAcceptScore" />
          <span>分</span>
        </div>
      </div>

      <div class="form-row">
        <div class="label">MusicBrainz 限速<small>每秒请求上限（超出自动排队退避）</small></div>
        <div class="ctl">
          <input type="number" min="0" max="20" style="width: 90px" v-model.number="draft.mbRateLimit" />
          <span>次/秒</span>
        </div>
      </div>

      <div class="form-row">
        <div class="label">iTunes 限速<small>每秒请求上限</small></div>
        <div class="ctl">
          <input type="number" min="0" max="50" style="width: 90px" v-model.number="draft.itunesRateLimit" />
          <span>次/秒</span>
        </div>
      </div>

      <div class="form-row">
        <div class="label">全局歌词偏移<small>写入歌词时统一应用的偏移</small></div>
        <div class="ctl">
          <input type="number" step="50" min="-500" max="500" style="width: 90px" v-model.number="draft.globalLyricOffset" />
          <span>ms（±0.5s）</span>
        </div>
      </div>

      <div class="form-row">
        <div class="label">保护艺名<small>每行一个，禁止被拆分（如 AC/DC、Fujiya & Miyagi）</small></div>
        <div class="ctl" style="flex-direction: column; align-items: stretch">
          <textarea v-model="draft.protectedArtists" placeholder="AC/DC&#10;K/DA&#10;Fujiya & Miyagi" />
        </div>
      </div>

      <div class="form-row">
        <div class="label">数据目录<small>SQLite 缓存、操作日志、撤销记录</small></div>
        <div class="ctl">
          <span class="path-text">{{ current?.dataDir ?? '（未读取）' }}</span>
          <span class="tag">{{ current?.portable ? '便携模式' : '常规模式' }}</span>
        </div>
      </div>

      <div class="form-row">
        <div class="label">插件目录<small>用户导入的音源插件存放位置</small></div>
        <div class="ctl">
          <span class="path-text">{{ current?.pluginDir ?? '（未读取）' }}</span>
        </div>
      </div>

      <div class="form-row">
        <div class="label">免责声明<small>本应用不内置音源、不获取或分发音频数据</small></div>
        <div class="ctl">
          <label class="chk">
            <input type="checkbox" v-model="draft.disclaimerAccepted" />
            我已知悉并接受上述声明，音源合法性由用户自行负责
          </label>
        </div>
      </div>
    </div>
  </div>
</template>

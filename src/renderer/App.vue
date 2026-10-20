<script setup lang="ts">
/**
 * SongMatch 渲染层入口：左侧导航 + 五大视图。
 */
import LibraryView from './components/LibraryView.vue'
import MatchView from './components/MatchView.vue'
import LyricsView from './components/LyricsView.vue'
import PluginsView from './components/PluginsView.vue'
import TasksView from './components/TasksView.vue'
import SettingsView from './components/SettingsView.vue'
import ToastHost from './components/ToastHost.vue'
import { activeView } from './lib/store'
import type { ViewKey } from './lib/store'

const navItems: Array<{ key: ViewKey; label: string; icon: string }> = [
  { key: 'library', label: '音乐库', icon: '▤' },
  { key: 'match', label: '匹配', icon: '⇄' },
  { key: 'lyrics', label: '歌词', icon: '♪' },
  { key: 'plugins', label: '插件', icon: '⬡' },
  { key: 'tasks', label: '任务中心', icon: '◷' },
  { key: 'settings', label: '设置', icon: '⚙' }
]

function onNavigate(view: ViewKey): void {
  activeView.value = view
}
</script>

<template>
  <div class="app">
    <aside class="sidebar">
      <div class="brand">
        SongMatch
        <small>多来源歌曲信息自选匹配</small>
      </div>
      <nav class="nav">
        <button
          v-for="item in navItems"
          :key="item.key"
          class="nav-item"
          :class="{ active: activeView === item.key }"
          @click="activeView = item.key"
        >
          <span class="nav-icon">{{ item.icon }}</span>
          <span>{{ item.label }}</span>
        </button>
      </nav>
      <div class="side-foot">
        只改元数据，不动音频流；<br />所有写入均可预览、可撤销。
      </div>
    </aside>

    <main class="content">
      <LibraryView v-if="activeView === 'library'" @navigate="onNavigate" />
      <MatchView v-else-if="activeView === 'match'" />
      <LyricsView v-else-if="activeView === 'lyrics'" />
      <PluginsView v-else-if="activeView === 'plugins'" />
      <TasksView v-else-if="activeView === 'tasks'" />
      <SettingsView v-else />
    </main>

    <ToastHost />
  </div>
</template>

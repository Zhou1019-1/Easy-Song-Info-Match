/**
 * 跨视图共享的少量状态（不引入任何状态库）。
 *
 * 音乐库的「已选文件」需要在 音乐库 / 匹配 / 歌词 三个视图之间共享，
 * 因此放在模块级 reactive 对象里。
 */
import { reactive, ref } from 'vue'
import type { LyricCandidate, TrackRecord } from '@shared/types'
import type { MatchQueryResult, SettingsDto } from '@shared/api'
import { safeCall } from './api'

export type ViewKey = 'library' | 'match' | 'lyrics' | 'plugins' | 'tasks' | 'settings'

/** 当前视图。 */
export const activeView = ref<ViewKey>('library')

/** 当前选中的文件 id（跨视图共享）。 */
export const selectedIds = reactive(new Set<number>())

/** 已加载过的曲目记录缓存（按 id），供匹配/歌词视图显示文件名与路径。 */
export const trackCache = reactive(new Map<number, TrackRecord>())

/** 匹配查询结果。 */
export const matchResults = ref<MatchQueryResult[]>([])

/** 歌词查询结果。 */
export const lyricResults = ref<Array<{ fileId: number; candidates: LyricCandidate[] }>>([])

/** 全局设置。 */
export const settings = ref<SettingsDto | null>(null)

/** 曲库版本号：+1 触发音乐库重新加载。 */
export const libraryVersion = ref(0)

export function bumpLibraryVersion(): void {
  libraryVersion.value++
}

export function clearSelection(): void {
  selectedIds.clear()
}

export function trackOf(fileId: number): TrackRecord | undefined {
  return trackCache.get(fileId)
}

let settingsPromise: Promise<void> | null = null

/** 按需加载一次全局设置（多个视图共享同一份）。 */
export function ensureSettings(): Promise<void> {
  if (settings.value) return Promise.resolve()
  if (!settingsPromise) {
    settingsPromise = safeCall(
      (api) => api.settingsGet(),
      null,
      '读取设置'
    )
      .then((s) => {
        if (s) settings.value = s
      })
      .finally(() => {
        settingsPromise = null
      })
  }
  return settingsPromise
}

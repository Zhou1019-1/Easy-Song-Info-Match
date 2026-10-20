/**
 * 预加载脚本：把主进程能力以白名单方式暴露给渲染进程。
 *
 * 渲染进程没有 Node 权限，只能调用这里显式列出的方法。
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { SongMatchApi } from '@shared/api'
import type { TaskInfo } from '@shared/types'

/** 与主进程 IPC 频道一一对应。 */
const CHANNELS = [
  'libraryList',
  'libraryGet',
  'libraryStats',
  'scanStart',
  'scanCancel',
  'scanPreviewRoots',
  'taskList',
  'taskCancel',
  'matchQuery',
  'matchApplyPreview',
  'matchApplyExecute',
  'matchClear',
  'lyricQuery',
  'lyricWrite',
  'lyricSetOffset',
  'renamePreview',
  'movePreview',
  'aliasPreview',
  'clearFieldsPreview',
  'renameExecute',
  'moveExecute',
  'undoList',
  'undoApply',
  'opLogList',
  'opLogExportCsv',
  'undoEntries',
  'pluginList',
  'pluginImport',
  'pluginSetEnabled',
  'pluginDelete',
  'pluginSetRateLimit',
  'pluginCall',
  'pluginOpenDir',
  'aliasList',
  'aliasSave',
  'aliasImport',
  'aliasExport',
  'settingsGet',
  'settingsSet',
  'issuesList',
  'pickDirectories',
  'pickFiles',
  'openDataDir',
  'appInfo'
] as const

type Channel = (typeof CHANNELS)[number]

const api = {} as Record<string, unknown>

for (const channel of CHANNELS) {
  api[channel] = (...args: unknown[]): Promise<unknown> =>
    ipcRenderer.invoke(channel as Channel, ...args)
}

api.onTaskUpdate = (cb: (task: TaskInfo) => void): (() => void) => {
  const listener = (_e: IpcRendererEvent, task: TaskInfo): void => cb(task)
  ipcRenderer.on('task:update', listener)
  return () => {
    ipcRenderer.removeListener('task:update', listener)
  }
}

contextBridge.exposeInMainWorld('songmatch', api as unknown as SongMatchApi)

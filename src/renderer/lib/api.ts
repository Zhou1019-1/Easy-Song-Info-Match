/**
 * 渲染进程访问主进程 API 的唯一入口。
 *
 * 主进程可能尚未就绪（开发期 / preload 缺失），此时所有调用都不得抛异常，
 * 而是给出友好的提示并返回兜底值，保证界面仍可渲染。
 */
import type { SongMatchApi } from '@shared/api'
import { toast } from './toast'

/**
 * 渲染进程使用的主进程 API。
 * 契约已包含重命名/归档移动的执行接口与「打开数据目录」，此处与契约保持一致。
 */
export type ExtendedSongMatchApi = SongMatchApi

export function getApi(): ExtendedSongMatchApi | null {
  const w = window as unknown as { songmatch?: ExtendedSongMatchApi }
  return w.songmatch ?? null
}

export function apiReady(): boolean {
  return getApi() !== null
}

export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  try {
    return JSON.stringify(e)
  } catch {
    return String(e)
  }
}

/** 调用主进程 API；失败时以 toast 提示并返回兜底值，绝不抛出。 */
export async function safeCall<T>(
  fn: (api: ExtendedSongMatchApi) => Promise<T>,
  fallback: T,
  label = '操作'
): Promise<T> {
  const api = getApi()
  if (!api) {
    toast.error(`主进程未就绪，${label}未执行`)
    return fallback
  }
  try {
    return await fn(api)
  } catch (e) {
    toast.error(`${label}失败：${errorText(e)}`)
    return fallback
  }
}

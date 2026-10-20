/**
 * 插件宿主 <-> 插件工作线程之间的消息契约。
 *
 * 说明：
 *  - 本程序不含任何音乐平台音源实现，只托管用户导入的音源插件脚本；
 *  - 插件在独立工作线程 + node:vm 沙箱中运行，崩溃/死循环不会波及主进程；
 *  - 一切"宿主无法支持"的差异都必须通过 incompatibilities（中文）显式上报，禁止悄悄吞掉。
 */

/** 插件可被宿主调用的能力。 */
export type PluginFn = 'search' | 'lyric' | 'albumArt' | 'url'

/** 插件加载结果。 */
export interface PluginLoadResult {
  ok: boolean
  id: string
  name: string
  version: string
  description?: string
  author?: string
  homepage?: string
  /** 插件声明支持的源码 key（kw/kg/tx/wy/mg/local 等） */
  sources: string[]
  /** 插件声明支持的音质（已按白名单过滤） */
  qualitys: string[]
  /** lx = 洛雪事件协议，fn = 函数式协议，unknown = 无法识别 */
  format: 'lx' | 'fn' | 'unknown'
  /** 与宿主协议不兼容之处（中文说明，直接展示给用户） */
  incompatibilities: string[]
  error?: string
}

/** 插件调用结果。 */
export interface PluginCallResult {
  ok: boolean
  fn: PluginFn
  /** 归一化后的数据（search 返回 { list, total, limit, page }；lyric 返回 { lyric, translation, timed }；albumArt/url 返回 { url }） */
  data?: unknown
  error?: string
  durationMs: number
  incompatibilities: string[]
}

/** 工作线程请求。 */
export type PluginWorkerRequest =
  | { id: string; type: 'load'; scriptPath: string }
  | {
      id: string
      type: 'call'
      scriptPath: string
      fn: PluginFn
      keyword?: string
      page?: number
      size?: number
      musicInfo?: Record<string, unknown>
      quality?: string
      source?: string
    }

/** 工作线程应答。 */
export type PluginWorkerResponse =
  | { id: string; type: 'load'; result: PluginLoadResult }
  | { id: string; type: 'call'; result: PluginCallResult }
  | { id: string; type: 'error'; error: string }

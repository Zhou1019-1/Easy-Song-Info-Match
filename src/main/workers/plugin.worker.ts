/**
 * 插件工作线程：在独立线程中运行用户导入的音源插件。
 *
 * 主进程通过 postMessage 投递 { id, type, ... } 请求，本线程必须永远用同一个 id 回一条应答，
 * 且不允许把异常抛到消息回调之外（否则主进程只会等到超时）。
 */
import path from 'node:path'
import { parentPort } from 'node:worker_threads'
import { PluginLoadError, loadPlugin, type LoadedPlugin } from '../plugins/lxRuntime'
import type {
  PluginCallResult,
  PluginLoadResult,
  PluginWorkerRequest,
  PluginWorkerResponse
} from '../plugins/protocol'

/** 已加载的插件缓存（按脚本路径）。 */
const cache = new Map<string, LoadedPlugin>()

/** 错误转文本。 */
function errorText(err: unknown): string {
  if (err instanceof Error) return err.message || err.name
  return String(err)
}

/** 脚本路径的兜底 id。 */
function fallbackId(scriptPath: string): string {
  return 'plg_' + Buffer.from(path.resolve(scriptPath)).toString('hex').slice(0, 12)
}

/** 加载（并缓存）插件脚本。 */
async function doLoad(scriptPath: string): Promise<PluginLoadResult> {
  const cached = cache.get(scriptPath)
  if (cached) {
    cached.dispose()
    cache.delete(scriptPath)
  }
  try {
    const plugin = await loadPlugin({ scriptPath })
    cache.set(scriptPath, plugin)
    return {
      ok: true,
      id: plugin.id,
      name: plugin.name,
      version: plugin.version,
      description: plugin.description,
      author: plugin.author,
      homepage: plugin.homepage,
      sources: plugin.sources,
      qualitys: plugin.qualitys,
      format: plugin.format,
      incompatibilities: plugin.incompatibilities
    }
  } catch (err) {
    if (err instanceof PluginLoadError) {
      return {
        ok: false,
        id: err.partial.id ?? fallbackId(scriptPath),
        name: err.partial.name ?? path.basename(scriptPath),
        version: err.partial.version ?? '0.0.0',
        sources: err.partial.sources ?? [],
        qualitys: err.partial.qualitys ?? [],
        format: err.partial.format ?? 'unknown',
        incompatibilities: err.incompatibilities,
        error: err.message
      }
    }
    throw err
  }
}

/** 调用插件能力（未加载时先加载）。 */
async function doCall(req: Extract<PluginWorkerRequest, { type: 'call' }>): Promise<PluginCallResult> {
  let plugin = cache.get(req.scriptPath)
  if (!plugin) {
    const load = await doLoad(req.scriptPath)
    if (!load.ok) {
      return {
        ok: false,
        fn: req.fn,
        error: load.error ?? '插件加载失败',
        durationMs: 0,
        incompatibilities: load.incompatibilities
      }
    }
    plugin = cache.get(req.scriptPath)
  }
  if (!plugin) {
    return { ok: false, fn: req.fn, error: '插件未加载', durationMs: 0, incompatibilities: [] }
  }
  return plugin.call(req.fn, {
    keyword: req.keyword,
    page: req.page,
    size: req.size,
    musicInfo: req.musicInfo,
    quality: req.quality,
    source: req.source
  })
}

/** 统一处理请求，永远回复同 id 的应答。 */
async function handleRequest(req: PluginWorkerRequest): Promise<void> {
  const port = parentPort
  if (!port) return
  try {
    if (req.type === 'load') {
      const result = await doLoad(req.scriptPath)
      const response: PluginWorkerResponse = { id: req.id, type: 'load', result }
      port.postMessage(response)
      return
    }
    const result = await doCall(req)
    const response: PluginWorkerResponse = { id: req.id, type: 'call', result }
    port.postMessage(response)
  } catch (err) {
    const response: PluginWorkerResponse = { id: req.id, type: 'error', error: errorText(err) }
    port.postMessage(response)
  }
}

parentPort?.on('message', (req: PluginWorkerRequest) => {
  void handleRequest(req)
})

parentPort?.on('close', () => {
  for (const plugin of cache.values()) plugin.dispose()
  cache.clear()
  parentPort?.unref()
})

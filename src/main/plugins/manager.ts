/**
 * 插件管理器：导入 / 启停 / 删除 / 限速 / 调用，全部通过独立工作线程执行，
 * 插件崩溃或死循环不会影响主程序。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { Worker } from 'node:worker_threads'
import type { PluginInfo } from '@shared/types'
import type { PluginCallRequest, PluginCallResponse } from '@shared/api'
import type { Db } from '../db'
import type {
  PluginCallResult,
  PluginFn,
  PluginLoadResult,
  PluginWorkerRequest,
  PluginWorkerResponse
} from './protocol'

/** 插件脚本允许的扩展名。 */
const ALLOWED_EXT = new Set(['.js', '.mjs', '.cjs'])

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message || err.name
  return String(err)
}

/** 对联合类型逐成员做 Omit（直接 Omit 会把联合压成公共字段）。 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

export class PluginManager {
  private worker: Worker | null = null
  private seq = 0
  private readonly pending = new Map<
    string,
    { resolve: (r: PluginWorkerResponse) => void; reject: (e: Error) => void }
  >()
  /** 每个插件的调用时间戳（用于限速）。 */
  private readonly callTimes = new Map<string, number[]>()

  constructor(
    private readonly db: Db,
    private readonly pluginDir: string
  ) {
    this.ensureWorker()
  }

  /* -------------------- 工作线程 -------------------- */

  private ensureWorker(): void {
    if (this.worker) return
    const workerPath = path.join(__dirname, 'workers', 'plugin.js')
    this.worker = new Worker(workerPath)
    this.worker.on('message', (res: PluginWorkerResponse) => {
      const p = this.pending.get(res.id)
      if (!p) return
      this.pending.delete(res.id)
      p.resolve(res)
    })
    this.worker.on('error', (err) => {
      for (const [, p] of this.pending) p.reject(err)
      this.pending.clear()
      this.worker = null
    })
    this.worker.on('exit', () => {
      this.worker = null
    })
    this.worker.unref()
  }

  private request(req: DistributiveOmit<PluginWorkerRequest, 'id'>): Promise<PluginWorkerResponse> {
    this.ensureWorker()
    if (!this.worker) throw new Error('插件工作线程未启动')
    const id = `p${++this.seq}`
    return new Promise<PluginWorkerResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error('插件调用超时（30 秒）'))
        }
      }, 30000)
      timer.unref?.()
      this.worker!.postMessage({ ...req, id } as PluginWorkerRequest)
    })
  }

  /* -------------------- 列表 -------------------- */

  list(): PluginInfo[] {
    const rows = this.db.listPluginMeta()
    return rows.map((r) => {
      const id = String(r.id)
      return {
        id,
        name: String(r.name ?? ''),
        version: String(r.version ?? ''),
        path: String(r.path ?? ''),
        enabled: Number(r.enabled ?? 1) === 1,
        sources: safeArray(r.sources),
        qualitys: safeArray(r.qualitys),
        format: (r.format as PluginInfo['format']) ?? 'unknown',
        importedAt: Number(r.imported_at ?? 0),
        loadOk: Number(r.load_ok ?? 0) === 1,
        loadError: (r.load_error as string) ?? undefined,
        incompatibilities: safeArray(r.incompatibilities),
        rateLimit: Number(r.rate_limit ?? 60),
        calls: this.db.pluginCalls(id)
      }
    })
  }

  /* -------------------- 导入 -------------------- */

  async import(filePath: string): Promise<PluginInfo> {
    const ext = path.extname(filePath).toLowerCase()
    if (!ALLOWED_EXT.has(ext)) {
      throw new Error(`不支持的插件文件类型：${ext}（仅支持 .js / .mjs / .cjs）`)
    }
    if (!fs.existsSync(filePath)) {
      throw new Error(`插件文件不存在：${filePath}`)
    }

    fs.mkdirSync(this.pluginDir, { recursive: true })
    const base = path.basename(filePath).replace(/[^\w.-]/g, '_')
    const dest = path.join(this.pluginDir, base)
    let target = dest
    if (fs.existsSync(dest) && fs.readFileSync(dest).equals(fs.readFileSync(filePath))) {
      // 同一文件，保留原 id
    } else if (fs.existsSync(dest)) {
      const stem = base.slice(0, base.length - ext.length)
      target = path.join(this.pluginDir, `${stem}-${crypto.randomBytes(3).toString('hex')}${ext}`)
    }
    if (target !== filePath) fs.copyFileSync(filePath, target)

    const id = 'plg_' + crypto.createHash('sha1').update(target).digest('hex').slice(0, 12)
    const load = await this.loadInfo(target)
    const existing = this.db.listPluginMeta().find((r) => r.id === id)
    this.db.upsertPluginMeta({
      id,
      name: load.name || base,
      version: load.version,
      path: target,
      enabled: existing ? existing.enabled : 1,
      sources: load.sources,
      qualitys: load.qualitys,
      format: load.format === 'fn' ? 'unknown' : load.format,
      imported_at: Number(existing?.imported_at ?? Date.now()),
      load_ok: load.ok ? 1 : 0,
      load_error: load.error ?? null,
      incompatibilities: load.incompatibilities,
      rate_limit: Number(existing?.rate_limit ?? 60)
    })
    const list = this.list()
    const info = list.find((p) => p.id === id)
    if (!info) throw new Error('插件导入后无法读取元信息')
    return info
  }

  private async loadInfo(scriptPath: string): Promise<PluginLoadResult> {
    try {
      const res = await this.request({ type: 'load', scriptPath })
      if (res.type === 'load') return res.result
      return {
        ok: false,
        id: '',
        name: '',
        version: '',
        sources: [],
        qualitys: [],
        format: 'unknown',
        incompatibilities: [],
        error: res.type === 'error' ? res.error : '插件返回了非预期的结果类型'
      }
    } catch (err) {
      return {
        ok: false,
        id: '',
        name: '',
        version: '',
        sources: [],
        qualitys: [],
        format: 'unknown',
        incompatibilities: [],
        error: errorText(err)
      }
    }
  }

  /* -------------------- 启停 / 删除 / 限速 -------------------- */

  setEnabled(id: string, enabled: boolean): PluginInfo[] {
    this.db.setPluginEnabled(id, enabled)
    return this.list()
  }

  setRateLimit(id: string, perMinute: number): PluginInfo[] {
    this.db.setPluginRateLimit(id, Math.max(1, Math.min(600, perMinute)))
    return this.list()
  }

  delete(id: string): PluginInfo[] {
    const info = this.list().find((p) => p.id === id)
    if (!info) throw new Error('插件不存在')
    this.db.deletePluginMeta(id)
    try {
      if (info.path.startsWith(this.pluginDir) && fs.existsSync(info.path)) {
        fs.unlinkSync(info.path)
      }
    } catch {
      /* 文件删除失败不阻断元信息删除 */
    }
    this.callTimes.delete(id)
    return this.list()
  }

  /* -------------------- 调用 -------------------- */

  async call(req: PluginCallRequest): Promise<PluginCallResponse> {
    const info = this.list().find((p) => p.id === req.pluginId)
    if (!info) {
      return { ok: false, error: '插件不存在', durationMs: 0 }
    }
    if (!info.enabled) {
      return { ok: false, error: '插件已被停用', durationMs: 0 }
    }
    if (!this.checkRate(info.id, info.rateLimit)) {
      return {
        ok: false,
        error: `已触发限速（每分钟最多 ${info.rateLimit} 次调用），请稍后再试`,
        durationMs: 0
      }
    }

    const started = Date.now()
    try {
      const res = await this.request({
        type: 'call',
        scriptPath: info.path,
        fn: req.fn as PluginFn,
        keyword: req.keyword,
        page: req.page,
        size: req.size,
        musicInfo: req.musicInfo,
        quality: req.quality,
        source: req.source
      })
      if (res.type === 'error') {
        this.db.addPluginCall(info.id, req.fn, false, Date.now() - started, res.error)
        return { ok: false, error: res.error, durationMs: Date.now() - started }
      }
      if (res.type !== 'call') {
        const message = '插件返回了非预期的结果类型'
        this.db.addPluginCall(info.id, req.fn, false, Date.now() - started, message)
        return { ok: false, error: message, durationMs: Date.now() - started }
      }
      const result = res.result
      this.db.addPluginCall(
        info.id,
        req.fn,
        result.ok,
        result.durationMs,
        result.error ?? result.incompatibilities.join('；')
      )
      return {
        ok: result.ok,
        data: result.data,
        error: result.error,
        durationMs: result.durationMs
      }
    } catch (err) {
      const message = errorText(err)
      this.db.addPluginCall(info.id, req.fn, false, Date.now() - started, message)
      return { ok: false, error: message, durationMs: Date.now() - started }
    }
  }

  /** 限速检查：滑动窗口 60 秒。 */
  private checkRate(id: string, perMinute: number): boolean {
    const now = Date.now()
    const list = (this.callTimes.get(id) ?? []).filter((t) => now - t < 60000)
    if (list.length >= perMinute) {
      this.callTimes.set(id, list)
      return false
    }
    list.push(now)
    this.callTimes.set(id, list)
    return true
  }

  dispose(): void {
    void this.worker?.terminate()
    this.worker = null
  }
}

function safeArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x))
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v)
      return Array.isArray(parsed) ? parsed.map((x) => String(x)) : []
    } catch {
      return []
    }
  }
  return []
}

export type { PluginCallResult }

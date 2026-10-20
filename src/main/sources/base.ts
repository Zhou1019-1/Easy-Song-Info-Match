/**
 * 多来源元数据适配器的公共契约与网络工具。
 *
 * 设计原则（对齐产品硬性要求）：
 *   1. 永不编造数据：字段缺失一律留 null / 空数组，不做推测填充。
 *   2. 永不静默吞错：请求失败必须返回可展示的 message，由 UI 显示「XX 失败：原因」。
 *   3. 必须可离线重跑：每次成功查询都写缓存，网络失败时回落到缓存并标记 fromCache。
 *
 * 本模块不依赖 electron / better-sqlite3，可在纯 Node 环境下单测。
 */
import type { Candidate, CandidateSource } from '@shared/types'

/** 一次来源查询的输入。 */
export interface SourceQuery {
  /** 搜索关键词（通常是 "歌名 歌手"） */
  keyword: string
  title: string
  artists: string[]
  album?: string | null
  /** 秒 */
  duration?: number | null
  year?: number | null
  /** 本地文件路径（local 线索用；其它来源忽略） */
  path?: string | null
  /** 页码，从 0 开始；用于 offset = page * 每页条数 */
  page?: number
}

/** 运行环境上下文（由主进程注入，便于测试替换）。 */
export interface SourceContext {
  /** 每分钟最多请求次数（MusicBrainz 官方要求 <=1 req/s，这里用 60/min 并在实现里加最小间隔） */
  rateLimitPerMinute: number
  cacheGet(key: string): { value: unknown; ts: number } | null
  cacheSet(key: string, value: unknown, ttlMs?: number): void
  log(message: string): void
}

/** 来源查询结果。 */
export interface SourceResult {
  candidates: Candidate[]
  fromCache: boolean
  message?: string
}

/** 来源适配器。 */
export interface SourceAdapter {
  id: CandidateSource
  name: string
  /** 离线时是否仍可给出结果（仅靠缓存） */
  offlineCapable: boolean
  query(q: SourceQuery, ctx: SourceContext): Promise<SourceResult>
}

/** fetchJson 的可选参数。 */
export interface FetchJsonInit {
  headers?: Record<string, string>
  timeoutMs?: number
  method?: string
  body?: string
}

/** fetchJson 的返回结构。 */
export interface FetchJsonResult {
  ok: boolean
  status: number
  data: unknown
  error?: string
}

/** 默认超时（毫秒）。 */
export const DEFAULT_TIMEOUT_MS = 15000

/**
 * 发起一次 JSON 请求。
 *
 * 约定：永远不抛异常。网络失败 / 超时返回 `{ ok: false, error }`，
 * 由调用方决定如何向用户展示（禁止静默吞错）。
 */
export async function fetchJson(
  url: string,
  init: FetchJsonInit = {}
): Promise<FetchJsonResult> {
  const timeoutMs = init.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: init.method ?? 'GET',
      headers: init.headers,
      body: init.body,
      signal: controller.signal
    })
    const text = await res.text()
    let data: unknown = null
    if (text) {
      try {
        data = JSON.parse(text)
      } catch {
        // 不是 JSON 就原样保留文本，交给调用方判断
        data = text
      }
    }
    if (!res.ok) {
      const statusText = res.statusText ? ` ${res.statusText}` : ''
      return {
        ok: false,
        status: res.status,
        data,
        error: `HTTP ${res.status}${statusText}`
      }
    }
    return { ok: true, status: res.status, data }
  } catch (err) {
    const aborted = controller.signal.aborted
    const msg = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      status: 0,
      data: null,
      error: aborted ? `请求超时（${timeoutMs}ms）` : `网络请求失败：${msg}`
    }
  } finally {
    clearTimeout(timer)
  }
}

/** 休眠指定毫秒。 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 判断一个未知值是否为普通对象（非数组、非 null）。
 */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * 安全取字符串：非字符串 / 空串一律返回 null（不编造、不转换脏数据）。
 */
export function str(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  return s ? s : null
}

/**
 * 安全取整数：非有限数 / 非数返回 null。
 */
export function num(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  return v
}

/**
 * 从字符串里提取 4 位年份（如 "2001-01-01" -> 2001），没有则返回 null。
 */
export function yearOf(v: string | null): number | null {
  if (!v) return null
  const m = /(\d{4})/.exec(v)
  if (!m) return null
  const y = Number(m[1])
  return Number.isFinite(y) ? y : null
}

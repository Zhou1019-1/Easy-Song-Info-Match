/**
 * 用户音源插件宿主：洛雪（lx-music 事件协议）+ 函数式协议的沙箱运行时。
 *
 * 硬性规则（与产品规范一致）：
 *  1. 本程序不含任何平台音源代码，只托管用户导入的插件脚本；
 *  2. 插件在 node:vm 沙箱里执行：脚本加载 5s 超时、单次调用 10s 超时，插件崩溃/死循环不影响主进程；
 *  3. 一切"宿主不支持"的差异都写进 incompatibilities（中文），由界面展示，禁止悄悄吞掉；
 *  4. 除注入的 lx.request 外没有任何网络出口，且该请求有超时与响应体积上限。
 *
 * 该模块不依赖 electron，可在普通 Node 下直接测试。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import vm from 'node:vm'
import zlib from 'node:zlib'
import { URL, URLSearchParams } from 'node:url'
import type { PluginLyricResult, PluginSearchResult } from '../../shared/types'
import type { PluginCallResult, PluginFn, PluginLoadResult } from './protocol'

/** 宿主支持的音质白名单（与洛雪保持一致）。 */
const QUALITY_WHITELIST = ['128k', '320k', 'flac', 'flac24bit']

/** 脚本加载超时（毫秒）。 */
const DEFAULT_LOAD_TIMEOUT_MS = 5000

/** 单次调用超时（毫秒）。 */
const DEFAULT_CALL_TIMEOUT_MS = 10000

/** lx.request 默认超时（毫秒）。 */
const DEFAULT_REQUEST_TIMEOUT_MS = 10000

/** lx.request 响应体上限（8MB）。 */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024

/** 播放地址长度上限。 */
const MAX_URL_LENGTH = 2048

/** 写入 lx.version 的宿主版本。 */
const HOST_VERSION = '1.0.0'

/** 洛雪事件名。 */
const EVENT_REQUEST = 'request'
const EVENT_INITED = 'inited'

/** 洛雪 lx 对象里存在、但本宿主明确不支持的成员。 */
const UNSUPPORTED_LX_KEYS = ['currentMusicInfo', 'log', 'apiCaller']

/** 沙箱内调用插件函数的桥接函数名（每次调用前都会被宿主重置，防止插件劫持）。 */
const BRIDGE_NAME = '__lxHostCall'

/** 插件调用参数。 */
export interface PluginCallArgs {
  keyword?: string
  page?: number
  size?: number
  musicInfo?: Record<string, unknown>
  quality?: string
  source?: string
}

/** 加载参数。 */
export interface LoadOptions {
  scriptPath: string
  /** 脚本加载超时，默认 5000ms */
  timeoutMs?: number
}

/** 已加载的插件实例。 */
export interface LoadedPlugin {
  id: string
  name: string
  version: string
  description?: string
  author?: string
  homepage?: string
  sources: string[]
  qualitys: string[]
  format: 'lx' | 'fn' | 'unknown'
  incompatibilities: string[]
  /** 执行一次调用 */
  call(fn: PluginFn, args: PluginCallArgs): Promise<PluginCallResult>
  /** 释放（清掉定时器、断开未完成的请求） */
  dispose(): void
}

/** 插件加载失败（携带已探测到的不兼容点，便于界面展示）。 */
export class PluginLoadError extends Error {
  readonly incompatibilities: string[]
  readonly partial: Partial<PluginLoadResult>

  constructor(message: string, partial: Partial<PluginLoadResult> = {}) {
    super(message)
    this.name = 'PluginLoadError'
    this.incompatibilities = partial.incompatibilities ?? []
    this.partial = partial
  }
}

/** 插件调用超时。 */
export class PluginTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PluginTimeoutError'
  }
}

/** lx.request 的请求参数。 */
interface LxRequestOptions {
  method?: string
  timeout?: number
  headers?: Record<string, string>
  body?: string | Uint8Array
  form?: Record<string, string>
  formData?: Record<string, string>
}

/** lx.request 的应答对象。 */
interface LxResponse {
  statusCode: number
  statusMessage: string
  headers: Record<string, string | string[] | undefined>
  bytes: number
  raw: Buffer
  body: unknown
}

/** lx.request 的回调签名：cb(err, resp, body)。 */
type LxRequestCallback = (err: Error | null, resp?: LxResponse, body?: unknown) => void

/** 沙箱内可被宿主调用的插件函数。 */
type SandboxHandler = (...args: unknown[]) => unknown

/** 脚本头部注释里声明的元信息。 */
interface ScriptHeader {
  name?: string
  description?: string
  version?: string
  author?: string
  homepage?: string
}

/** 转成可读文本。 */
function toText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

/** 是否是普通对象。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** 错误转文本。 */
function errorText(err: unknown): string {
  if (err instanceof Error) return err.message || err.name
  return String(err)
}

/** 是否是 thenable。 */
function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    !!value &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

/** 是否是 vm 脚本执行超时。 */
function isVmTimeout(err: unknown): boolean {
  if (err instanceof PluginTimeoutError) return true
  const code = (err as { code?: string } | null)?.code
  if (code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') return true
  return /Script execution timed out/i.test(errorText(err))
}

/** 解析脚本头部注释里的 @name/@version 等元信息。 */
function parseHeader(code: string): ScriptHeader {
  const header: ScriptHeader = {}
  const block = /^\s*\/\*\*([\s\S]*?)\*\//.exec(code)
  if (!block) return header
  for (const line of block[1].split(/\r?\n/)) {
    const kv = /@(\w+)\s+(.+?)\s*$/.exec(line)
    if (!kv) continue
    const key = kv[1].toLowerCase()
    const value = kv[2].trim()
    if (key === 'name') header.name = value
    else if (key === 'description') header.description = value
    else if (key === 'version') header.version = value
    else if (key === 'author') header.author = value
    else if (key === 'homepage') header.homepage = value
  }
  return header
}

/** 是否是 http(s) 地址。 */
function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

/** 歌词是否带时间轴。 */
function hasTimeAxis(text: string): boolean {
  return /\[\d{1,2}:\d{1,2}(?:[.:]\d{1,3})?\]/.test(text)
}

/** 归一化歌手字段（可能是数组）。 */
function normalizeSinger(value: unknown): string {
  if (Array.isArray(value)) return value.map((v) => toText(v)).filter(Boolean).join(' / ')
  return toText(value)
}

/** 从插件返回值里取出播放地址。 */
function extractUrl(raw: unknown): string {
  if (typeof raw === 'string') return raw.trim()
  if (isPlainObject(raw)) return toText(raw.url).trim()
  return ''
}

/** 给 Promise 加墙钟兜底。 */
function withDeadline<T>(promise: PromiseLike<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new PluginTimeoutError(`插件执行超时（超过 ${ms}ms 已被中断）`))
    }, ms)
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

/** 构造 lx.utils（只拷贝需要的函数引用，不把整个 node:zlib 暴露给沙箱）。 */
function createLxUtils(): Record<string, unknown> {
  const toBuf = (data: string | Uint8Array): Buffer =>
    typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data)
  return {
    buffer: {
      base64ToBuffer: (data: string): Buffer => Buffer.from(data, 'base64'),
      bufferToBase64: (data: Uint8Array): string => Buffer.from(data).toString('base64'),
      hexToBuffer: (data: string): Buffer => Buffer.from(data, 'hex'),
      bufferToHex: (data: Uint8Array): string => Buffer.from(data).toString('hex'),
      stringToBuffer: (data: string): Buffer => Buffer.from(data, 'utf8'),
      bufferToString: (data: Uint8Array): string => Buffer.from(data).toString('utf8'),
      base64ToString: (data: string): string => Buffer.from(data, 'base64').toString('utf8'),
      stringToBase64: (data: string): string => Buffer.from(data, 'utf8').toString('base64')
    },
    crypto: {
      md5: (data: string | Uint8Array): string => crypto.createHash('md5').update(toBuf(data)).digest('hex'),
      sha1: (data: string | Uint8Array): string => crypto.createHash('sha1').update(toBuf(data)).digest('hex'),
      sha256: (data: string | Uint8Array): string =>
        crypto.createHash('sha256').update(toBuf(data)).digest('hex'),
      md5Buffer: (data: string | Uint8Array): Buffer =>
        crypto.createHash('md5').update(toBuf(data)).digest(),
      sha1Buffer: (data: string | Uint8Array): Buffer =>
        crypto.createHash('sha1').update(toBuf(data)).digest()
    },
    zlib: {
      inflate: (data: Uint8Array): Buffer => zlib.inflateSync(Buffer.from(data)),
      deflate: (data: Uint8Array): Buffer => zlib.deflateSync(Buffer.from(data)),
      unzip: (data: Uint8Array): Buffer => zlib.unzipSync(Buffer.from(data)),
      gzip: (data: Uint8Array): Buffer => zlib.gzipSync(Buffer.from(data)),
      inflateRaw: (data: Uint8Array): Buffer => zlib.inflateRawSync(Buffer.from(data)),
      deflateRaw: (data: Uint8Array): Buffer => zlib.deflateRawSync(Buffer.from(data))
    }
  }
}

/** 插件宿主（单个插件实例的运行时状态）。 */
class PluginHost {
  readonly id: string
  private readonly resolvedPath: string
  private readonly code: string
  private readonly header: ScriptHeader
  private readonly sandbox: Record<string, unknown>
  private readonly context: vm.Context
  private readonly handlers = new Map<string, SandboxHandler>()
  private readonly sandboxHandlers: Record<string, SandboxHandler> = {}
  private readonly timers = new Set<NodeJS.Timeout>()
  private readonly pendingRequests = new Set<http.ClientRequest>()
  private readonly incompatibilities: string[] = []
  private initedPayload: Record<string, unknown> | null = null
  private moduleExports: Record<string, unknown> | null = null
  private format: 'lx' | 'fn' | 'unknown' = 'unknown'
  private poisoned = false
  private disposed = false
  private name = ''
  private version = '0.0.0'
  private description: string | undefined
  private author: string | undefined
  private homepage: string | undefined
  private sources: string[] = []
  private qualitys: string[] = []

  constructor(opts: LoadOptions) {
    this.resolvedPath = path.resolve(opts.scriptPath)
    this.id = 'plg_' + crypto.createHash('sha1').update(this.resolvedPath).digest('hex').slice(0, 12)
    try {
      this.code = fs.readFileSync(this.resolvedPath, 'utf8')
    } catch (err) {
      throw new PluginLoadError(`插件加载失败：无法读取脚本文件（${errorText(err)}）`, {
        id: this.id,
        name: path.basename(this.resolvedPath)
      })
    }
    this.header = parseHeader(this.code)
    this.name = this.header.name ?? path.basename(this.resolvedPath)
    this.sandbox = this.buildSandbox()
    this.context = vm.createContext(this.sandbox, {
      codeGeneration: { strings: false, wasm: false }
    })
    // codeGeneration 只让 WebAssembly 的编译失效，符号本身还在，这里显式遮蔽掉。
    // 单独跑一次脚本，避免污染用户脚本的指令序言（'use strict'）与行号。
    vm.runInContext('var WebAssembly = undefined;', this.context, { timeout: 1000 })
  }

  /** 运行脚本并解析出协议与元信息。 */
  load(timeoutMs: number): void {
    this.scanSource()
    const moduleCarrier: { exports: unknown } = { exports: {} }
    this.sandbox.module = moduleCarrier
    this.sandbox.exports = moduleCarrier.exports
    try {
      vm.runInContext(this.code, this.context, { timeout: timeoutMs, displayErrors: true })
    } catch (err) {
      const message = errorText(err)
      if (isVmTimeout(err)) {
        throw new PluginLoadError(`插件加载失败：脚本执行超时（超过 ${timeoutMs}ms 已被中断）`, {
          id: this.id,
          name: this.name,
          version: this.version,
          format: 'unknown',
          incompatibilities: [...this.incompatibilities]
        })
      }
      if (/require is not defined|process is not defined/i.test(message)) {
        this.addIncompatibility('脚本尝试访问 require/process，已被沙箱拒绝')
      }
      throw new PluginLoadError(`插件加载失败：${message}`, {
        id: this.id,
        name: this.name,
        version: this.version,
        format: 'unknown',
        incompatibilities: [...this.incompatibilities]
      })
    }
    const exported = moduleCarrier.exports
    if (isPlainObject(exported) && Object.keys(exported).length > 0) this.moduleExports = exported
    this.resolveProtocol()
  }

  /** 暴露给外部的插件描述。 */
  toLoadedPlugin(): LoadedPlugin {
    const host = this
    return {
      id: this.id,
      name: this.name,
      version: this.version,
      description: this.description,
      author: this.author,
      homepage: this.homepage,
      sources: [...this.sources],
      qualitys: [...this.qualitys],
      format: this.format,
      incompatibilities: [...this.incompatibilities],
      call: (fn: PluginFn, args: PluginCallArgs) => host.call(fn, args),
      dispose: () => host.dispose()
    }
  }

  /** 调用插件能力。 */
  async call(fn: PluginFn, args: PluginCallArgs): Promise<PluginCallResult> {
    const started = Date.now()
    const extra: string[] = []
    if (this.disposed) return this.fail(fn, '插件已被释放', started, extra)
    if (this.poisoned) {
      return this.fail(fn, '插件上下文已失效（上次调用超时已被中断），请重新导入插件', started, extra)
    }
    try {
      switch (fn) {
        case 'search':
          return await this.callSearch(args, extra, started)
        case 'lyric':
          return await this.callLyric(args, extra, started)
        case 'albumArt':
          return await this.callAlbumArt(args, extra, started)
        case 'url':
          return await this.callUrl(args, extra, started)
        default:
          return this.fail(fn, `未知的调用类型：${String(fn)}`, started, extra)
      }
    } catch (err) {
      return this.fail(fn, errorText(err), started, extra)
    }
  }

  /** 释放资源。 */
  dispose(): void {
    this.disposed = true
    for (const timer of this.timers) clearTimeout(timer)
    for (const timer of this.timers) clearInterval(timer)
    this.timers.clear()
    for (const request of this.pendingRequests) {
      try {
        request.destroy()
      } catch {
        /* ignore */
      }
    }
    this.pendingRequests.clear()
    this.handlers.clear()
    for (const key of Object.keys(this.sandboxHandlers)) delete this.sandboxHandlers[key]
  }

  // ---------------------------------------------------------------- 内部实现

  /** 构造沙箱全局对象：只放行必要能力。 */
  private buildSandbox(): Record<string, unknown> {
    const sandbox: Record<string, unknown> = {}
    sandbox.console = this.createConsole()
    sandbox.setTimeout = (fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]): NodeJS.Timeout => {
      const handle = setTimeout(() => {
        this.timers.delete(handle)
        fn(...args)
      }, ms)
      this.timers.add(handle)
      return handle
    }
    sandbox.clearTimeout = (handle: NodeJS.Timeout): void => {
      this.timers.delete(handle)
      clearTimeout(handle)
    }
    sandbox.setInterval = (fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]): NodeJS.Timeout => {
      const handle = setInterval(() => fn(...args), ms)
      this.timers.add(handle)
      return handle
    }
    sandbox.clearInterval = (handle: NodeJS.Timeout): void => {
      this.timers.delete(handle)
      clearInterval(handle)
    }
    sandbox.queueMicrotask = (fn: () => void): void => {
      queueMicrotask(fn)
    }
    sandbox.URL = URL
    sandbox.URLSearchParams = URLSearchParams
    sandbox.TextEncoder = TextEncoder
    sandbox.TextDecoder = TextDecoder
    sandbox.atob = (data: string): string => Buffer.from(data, 'base64').toString('binary')
    sandbox.btoa = (data: string): string => Buffer.from(data, 'binary').toString('base64')
    sandbox.__lxHostHandlers = this.sandboxHandlers
    sandbox.lx = this.createLxObject()
    return sandbox
  }

  /** 插件里的 console：带上前缀，避免和宿主输出混淆。 */
  private createConsole(): Record<string, (...args: unknown[]) => void> {
    const prefix = `[插件 ${this.name}]`
    return {
      log: (...args: unknown[]) => console.log(prefix, ...args),
      info: (...args: unknown[]) => console.info(prefix, ...args),
      warn: (...args: unknown[]) => console.warn(prefix, ...args),
      error: (...args: unknown[]) => console.error(prefix, ...args),
      debug: (...args: unknown[]) => console.debug(prefix, ...args)
    }
  }

  /** 构造注入给插件的 lx 对象。 */
  private createLxObject(): Record<string, unknown> {
    const target: Record<string, unknown> = {
      EVENT_NAMES: { request: EVENT_REQUEST, inited: EVENT_INITED },
      on: (eventName: string, handler: unknown): void => this.registerHandler(eventName, handler),
      send: (eventName: string, data: unknown): unknown => this.dispatch(eventName, data),
      request: (url: string, options: LxRequestOptions, cb: LxRequestCallback): void =>
        this.performRequest(url, options, cb),
      utils: createLxUtils(),
      currentScriptInfo: {
        name: this.header.name ?? path.basename(this.resolvedPath),
        version: this.header.version ?? '0.0.0',
        author: this.header.author ?? '',
        description: this.header.description ?? '',
        homepage: this.header.homepage ?? ''
      },
      version: HOST_VERSION,
      env: {
        isBrowser: false,
        isElectron: Boolean(process.versions.electron),
        version: process.versions.node
      }
    }
    return new Proxy(target, {
      get: (obj, prop) => {
        if (typeof prop === 'string' && UNSUPPORTED_LX_KEYS.includes(prop)) {
          this.addIncompatibility(`脚本使用了不受支持的 lx.${prop}`)
          return undefined
        }
        return Reflect.get(obj, prop)
      }
    })
  }

  /** lx.on：登记插件事件处理器。 */
  private registerHandler(eventName: string, handler: unknown): void {
    if (typeof handler !== 'function') {
      this.addIncompatibility(`lx.on 收到的「${eventName}」处理器不是函数，已忽略`)
      return
    }
    const fn = handler as SandboxHandler
    this.handlers.set(eventName, fn)
    this.sandboxHandlers[eventName] = fn
  }

  /** lx.send：拦截 inited，普通事件转发给已登记的处理器。 */
  private dispatch(eventName: string, data: unknown): unknown {
    if (eventName === EVENT_INITED) {
      this.initedPayload = isPlainObject(data) ? data : null
      return undefined
    }
    const handler = this.handlers.get(eventName)
    if (!handler) return undefined
    return handler(data)
  }

  /** 扫描脚本源码，提前发现宿主无法支持的用法。 */
  private scanSource(): void {
    const code = this.code
    for (const key of UNSUPPORTED_LX_KEYS) {
      if (new RegExp(`(?:globalThis\\s*\\.\\s*)?\\blx\\s*\\.\\s*${key}\\b`).test(code)) {
        this.addIncompatibility(`脚本使用了不受支持的 lx.${key}`)
      }
    }
    if (/\brequire\s*\(/.test(code) || /\bprocess\s*[.[\]]/.test(code)) {
      this.addIncompatibility('脚本尝试访问 require/process，已被沙箱拒绝')
    }
    // typeof Buffer 只是能力探测，不算使用
    if (/\bBuffer\b/.test(code.replace(/typeof\s+Buffer/g, ''))) {
      this.addIncompatibility('脚本使用了不受支持的 Buffer，请改用 lx.utils.buffer')
    }
  }

  /** 判定协议、解析元信息、检测不兼容点。 */
  private resolveProtocol(): void {
    const hasModuleExport = !!this.moduleExports
    const hasLxHandler = this.handlers.has(EVENT_REQUEST)
    if (hasModuleExport && hasLxHandler) {
      this.addIncompatibility('脚本同时使用两种协议，以 module.exports 优先')
      this.format = 'fn'
    } else if (hasModuleExport) {
      this.format = 'fn'
    } else if (hasLxHandler) {
      this.format = 'lx'
    } else {
      this.format = 'unknown'
    }

    if (this.format === 'fn') {
      const exported = this.moduleExports ?? {}
      this.name = toText(exported.name) || this.header.name || path.basename(this.resolvedPath)
      this.version = toText(exported.version) || this.header.version || '0.0.0'
      this.description = toText(exported.description) || this.header.description
      this.author = toText(exported.author) || this.header.author
      this.homepage = toText(exported.homepage) || this.header.homepage
      const sourceMap = isPlainObject(exported.sources) ? exported.sources : {}
      this.sources = Object.keys(sourceMap)
      const declared: string[] = []
      if (Array.isArray(exported.qualitys)) declared.push(...exported.qualitys.map((q) => toText(q)))
      for (const value of Object.values(sourceMap)) {
        if (isPlainObject(value) && Array.isArray(value.qualitys)) {
          declared.push(...value.qualitys.map((q) => toText(q)))
        }
      }
      this.qualitys = this.filterQualitys(declared)
      this.registerFnExports(exported)
      if (typeof exported.musicSearch !== 'function') {
        this.addIncompatibility('脚本未实现 musicSearch，无法搜索')
      }
    } else if (this.format === 'lx') {
      this.name = this.header.name || path.basename(this.resolvedPath)
      this.version = this.header.version || '0.0.0'
      this.description = this.header.description
      this.author = this.header.author
      this.homepage = this.header.homepage
      const sourceMap = this.extractInitedSources()
      this.sources = Object.keys(sourceMap)
      const declared: string[] = []
      if (this.initedPayload && Array.isArray(this.initedPayload.qualitys)) {
        declared.push(...this.initedPayload.qualitys.map((q) => toText(q)))
      }
      for (const value of Object.values(sourceMap)) {
        if (isPlainObject(value) && Array.isArray(value.qualitys)) {
          declared.push(...value.qualitys.map((q) => toText(q)))
        }
      }
      this.qualitys = this.filterQualitys(declared)
      if (!this.sources.includes('local')) {
        this.addIncompatibility('脚本未声明 local 源，歌词/封面请求可能无法被正确处理')
      }
    } else {
      this.addIncompatibility('脚本既未导出 module.exports，也未注册 lx 事件，无法识别协议')
    }

    if (this.sources.length === 0) {
      this.addIncompatibility('脚本没有声明任何 sources')
    }

    if (this.format === 'unknown') {
      throw new PluginLoadError('插件加载失败：无法识别插件协议（既无 module.exports，也没有 lx 事件）', {
        id: this.id,
        name: this.name,
        version: this.version,
        format: 'unknown',
        incompatibilities: [...this.incompatibilities]
      })
    }
  }

  /** 取出 inited 事件里声明的 sources。 */
  private extractInitedSources(): Record<string, unknown> {
    const payload = this.initedPayload
    if (!payload) return {}
    if (isPlainObject(payload.sources)) return payload.sources
    const values = Object.values(payload)
    if (values.length > 0 && values.every((v) => isPlainObject(v))) return payload
    return {}
  }

  /** 按白名单过滤音质，并逐个点名不支持的音质。 */
  private filterQualitys(declared: string[]): string[] {
    const kept: string[] = []
    for (const item of declared) {
      const value = item.trim()
      if (QUALITY_WHITELIST.includes(value)) {
        if (!kept.includes(value)) kept.push(value)
      } else {
        this.addIncompatibility(`quality「${value}」不在白名单内，已忽略`)
      }
    }
    return kept
  }

  /** 登记函数式协议的实现。 */
  private registerFnExports(exported: Record<string, unknown>): void {
    const map: Array<[string, string]> = [
      ['musicSearch', 'fn:musicSearch'],
      ['musicUrl', 'fn:musicUrl'],
      ['lyric', 'fn:lyric'],
      ['albumArt', 'fn:albumArt']
    ]
    for (const [name, key] of map) {
      const fn = exported[name]
      if (typeof fn !== 'function') continue
      const handler = fn as SandboxHandler
      this.handlers.set(key, handler)
      this.sandboxHandlers[key] = handler
    }
  }

  /** 记录一条不兼容说明（去重）。 */
  private addIncompatibility(message: string): void {
    if (!this.incompatibilities.includes(message)) this.incompatibilities.push(message)
  }

  /** 合并插件级与调用级的不兼容说明。 */
  private mergeIncompatibilities(extra: string[]): string[] {
    const merged = [...this.incompatibilities]
    for (const item of extra) if (!merged.includes(item)) merged.push(item)
    return merged
  }

  /** 组装失败结果。 */
  private fail(fn: PluginFn, error: string, started: number, extra: string[]): PluginCallResult {
    return {
      ok: false,
      fn,
      error,
      durationMs: Date.now() - started,
      incompatibilities: this.mergeIncompatibilities(extra)
    }
  }

  /** 组装成功结果。 */
  private ok(fn: PluginFn, data: unknown, started: number, extra: string[]): PluginCallResult {
    return {
      ok: true,
      fn,
      data,
      durationMs: Date.now() - started,
      incompatibilities: this.mergeIncompatibilities(extra)
    }
  }

  /** 在沙箱内调用插件函数（带超时）。 */
  private async invoke(key: string, args: unknown[], timeoutMs: number): Promise<unknown> {
    const deadline = Date.now() + timeoutMs
    this.sandbox[BRIDGE_NAME] = (bridgeKey: string, bridgeArgs: unknown[]): unknown => {
      const handler = this.sandboxHandlers[bridgeKey]
      if (typeof handler !== 'function') throw new Error(`插件未实现 ${bridgeKey}`)
      return handler(...bridgeArgs)
    }
    const source = `${BRIDGE_NAME}(${JSON.stringify(key)},${JSON.stringify(args)})`
    let raw: unknown
    try {
      raw = vm.runInContext(source, this.context, { timeout: timeoutMs, displayErrors: true })
    } catch (err) {
      if (isVmTimeout(err)) {
        this.poisoned = true
        throw new PluginTimeoutError(`插件执行超时（超过 ${timeoutMs}ms 已被中断）`)
      }
      throw err
    }
    if (isPromiseLike(raw)) {
      const remain = Math.max(1, deadline - Date.now())
      try {
        raw = await withDeadline(Promise.resolve(raw), remain)
      } catch (err) {
        if (err instanceof PluginTimeoutError) this.poisoned = true
        throw err
      }
    }
    return raw
  }

  /** 构造传给插件的 musicInfo（同时兼容新旧两种字段结构）。 */
  private buildMusicInfo(args: PluginCallArgs): Record<string, unknown> {
    const info = isPlainObject(args.musicInfo) ? { ...args.musicInfo } : {}
    if (args.source && !info.source) info.source = args.source
    return info
  }

  /** 调用 musicUrl。 */
  private async callUrl(
    args: PluginCallArgs,
    extra: string[],
    started: number
  ): Promise<PluginCallResult> {
    const musicInfo = this.buildMusicInfo(args)
    let raw: unknown
    if (this.format === 'fn') {
      if (typeof this.sandboxHandlers['fn:musicUrl'] !== 'function') {
        extra.push('脚本未实现 musicUrl，无法获取播放地址')
        return this.fail('url', '脚本未实现 musicUrl，无法获取播放地址', started, extra)
      }
      raw = await this.invoke('fn:musicUrl', [musicInfo, args.quality ?? ''], DEFAULT_CALL_TIMEOUT_MS)
    } else {
      const source = args.source ?? 'local'
      raw = await this.invoke(
        EVENT_REQUEST,
        [{ action: 'musicUrl', source, musicInfo, quality: args.quality ?? '' }],
        DEFAULT_CALL_TIMEOUT_MS
      )
    }
    const url = extractUrl(raw)
    if (!url) return this.fail('url', '插件未返回可用的播放地址', started, extra)
    if (!isHttpUrl(url)) {
      extra.push('返回的 url 不是 http(s) 协议')
      return this.fail('url', `返回的 url 不是 http(s) 协议：${url.slice(0, 120)}`, started, extra)
    }
    if (url.length > MAX_URL_LENGTH) {
      extra.push(`返回的 url 超过 ${MAX_URL_LENGTH} 字符限制`)
      return this.fail('url', `返回的 url 超过 ${MAX_URL_LENGTH} 字符限制`, started, extra)
    }
    return this.ok('url', { url }, started, extra)
  }

  /** 调用 lyric。 */
  private async callLyric(
    args: PluginCallArgs,
    extra: string[],
    started: number
  ): Promise<PluginCallResult> {
    const musicInfo = this.buildMusicInfo(args)
    let raw: unknown
    if (this.format === 'fn') {
      if (typeof this.sandboxHandlers['fn:lyric'] !== 'function') {
        extra.push('脚本未实现 lyric，无法获取歌词')
        return this.fail('lyric', '脚本未实现 lyric，无法获取歌词', started, extra)
      }
      raw = await this.invoke('fn:lyric', [musicInfo, args.source ?? 'local'], DEFAULT_CALL_TIMEOUT_MS)
    } else {
      const source = args.source ?? 'local'
      if (source !== 'local') {
        extra.push(`源「${source}」不支持 lyric（仅 local 源支持）`)
        return this.fail('lyric', `源「${source}」不支持 lyric（仅 local 源支持）`, started, extra)
      }
      raw = await this.invoke(
        EVENT_REQUEST,
        [{ action: 'lyric', source, musicInfo }],
        DEFAULT_CALL_TIMEOUT_MS
      )
    }
    let lyric = ''
    let translation = ''
    if (typeof raw === 'string') {
      lyric = raw
    } else if (isPlainObject(raw)) {
      lyric = toText(raw.lyric)
      translation = toText(raw.tlyric) || toText(raw.translation) || toText(raw.rlyric)
    }
    if (!lyric.trim()) return this.fail('lyric', '插件未返回歌词内容', started, extra)
    const data: PluginLyricResult = { lyric, translation, timed: hasTimeAxis(lyric) }
    return this.ok('lyric', data, started, extra)
  }

  /** 调用 albumArt（洛雪协议里对应 pic 动作）。 */
  private async callAlbumArt(
    args: PluginCallArgs,
    extra: string[],
    started: number
  ): Promise<PluginCallResult> {
    const musicInfo = this.buildMusicInfo(args)
    let raw: unknown
    if (this.format === 'fn') {
      if (typeof this.sandboxHandlers['fn:albumArt'] !== 'function') {
        extra.push('脚本未实现 albumArt，无法获取封面')
        return this.fail('albumArt', '脚本未实现 albumArt，无法获取封面', started, extra)
      }
      raw = await this.invoke('fn:albumArt', [musicInfo], DEFAULT_CALL_TIMEOUT_MS)
    } else {
      const source = args.source ?? 'local'
      if (source !== 'local') {
        extra.push(`源「${source}」不支持 pic（仅 local 源支持）`)
        return this.fail('albumArt', `源「${source}」不支持 pic（仅 local 源支持）`, started, extra)
      }
      raw = await this.invoke(
        EVENT_REQUEST,
        [{ action: 'pic', source, musicInfo }],
        DEFAULT_CALL_TIMEOUT_MS
      )
    }
    const url = extractUrl(raw)
    if (!url) return this.fail('albumArt', '插件未返回封面地址', started, extra)
    if (!isHttpUrl(url)) {
      extra.push('返回的 url 不是 http(s) 协议')
      return this.fail('albumArt', `返回的 url 不是 http(s) 协议：${url.slice(0, 120)}`, started, extra)
    }
    return this.ok('albumArt', { url }, started, extra)
  }

  /** 调用 search（只有函数式协议支持搜索）。 */
  private async callSearch(
    args: PluginCallArgs,
    extra: string[],
    started: number
  ): Promise<PluginCallResult> {
    if (this.format !== 'fn') {
      extra.push('洛雪协议不支持 search（仅支持 musicUrl/lyric/pic）')
      return this.fail('search', '洛雪协议不支持 search（仅支持 musicUrl/lyric/pic）', started, extra)
    }
    if (typeof this.sandboxHandlers['fn:musicSearch'] !== 'function') {
      extra.push('脚本未实现 musicSearch，无法搜索')
      return this.fail('search', '脚本未实现 musicSearch，无法搜索', started, extra)
    }
    const page = args.page ?? 1
    const size = args.size ?? 30
    const raw = await this.invoke('fn:musicSearch', [args.keyword ?? '', page, size], DEFAULT_CALL_TIMEOUT_MS)
    if (!isPlainObject(raw)) {
      return this.fail('search', '插件返回的搜索结果格式不正确（应为 { list, total, limit, page }）', started, extra)
    }
    const rawList = Array.isArray(raw.list) ? raw.list : []
    const list: PluginSearchResult['list'] = rawList.filter(isPlainObject).map((item) => {
      const meta = isPlainObject(item.meta) ? item.meta : {}
      const album = toText(item.album) || toText(item.albumName) || toText(meta.albumName)
      const imgurl = toText(item.imgurl) || toText(item.img) || toText(meta.picUrl)
      const lyric = toText(item.lyric)
      return {
        ...item,
        id: toText(item.id) || toText(item.songmid) || toText(meta.songId),
        name: toText(item.name) || toText(item.title),
        singer: normalizeSinger(item.singer ?? item.artist),
        album: album || undefined,
        source: toText(item.source),
        interval: typeof item.interval === 'number' ? item.interval : undefined,
        imgurl: imgurl || undefined,
        lyric: lyric || undefined
      }
    })
    const data: PluginSearchResult = {
      list,
      total: typeof raw.total === 'number' ? raw.total : list.length,
      limit: typeof raw.limit === 'number' ? raw.limit : size,
      page: typeof raw.page === 'number' ? raw.page : page
    }
    return this.ok('search', data, started, extra)
  }

  /** lx.request：宿主侧实现，带超时与响应体积上限。 */
  private performRequest(rawUrl: string, options: LxRequestOptions | undefined, cb: unknown): void {
    const callback = typeof cb === 'function' ? (cb as LxRequestCallback) : null
    const fail = (err: Error): void => {
      if (callback) callback(err)
    }
    if (typeof rawUrl !== 'string' || !rawUrl) {
      fail(new Error('lx.request: 缺少合法的 url'))
      return
    }
    let target: URL
    try {
      target = new URL(rawUrl)
    } catch {
      fail(new Error(`lx.request: 无法解析地址 ${rawUrl}`))
      return
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      fail(new Error(`lx.request: 不支持的协议 ${target.protocol}`))
      return
    }
    const opts = options ?? {}
    const timeout =
      typeof opts.timeout === 'number' && opts.timeout > 0 ? opts.timeout : DEFAULT_REQUEST_TIMEOUT_MS
    const headers: Record<string, string> = { ...(opts.headers ?? {}) }
    let payload: Buffer | undefined
    if (opts.form && typeof opts.form === 'object') {
      payload = Buffer.from(new URLSearchParams(opts.form).toString(), 'utf8')
      if (!this.hasHeader(headers, 'content-type')) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded'
      }
    } else if (opts.formData && typeof opts.formData === 'object') {
      const boundary = '----SongMatchBoundary' + crypto.randomBytes(8).toString('hex')
      const chunks: Buffer[] = []
      for (const [key, value] of Object.entries(opts.formData)) {
        chunks.push(
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${toText(value)}\r\n`,
            'utf8'
          )
        )
      }
      chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'))
      payload = Buffer.concat(chunks)
      if (!this.hasHeader(headers, 'content-type')) {
        headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`
      }
    } else if (opts.body !== undefined && opts.body !== null) {
      payload = typeof opts.body === 'string' ? Buffer.from(opts.body, 'utf8') : Buffer.from(opts.body)
    }

    const client = target.protocol === 'https:' ? https : http
    let settled = false
    const done = (err: Error | null, resp?: LxResponse, body?: unknown): void => {
      if (settled) return
      settled = true
      if (!callback) return
      if (err) callback(err)
      else callback(null, resp, body)
    }

    const request = client.request(
      target,
      { method: (opts.method ?? 'GET').toUpperCase(), headers },
      (res) => {
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > MAX_RESPONSE_BYTES) {
            done(new Error(`lx.request: 响应体超过 ${MAX_RESPONSE_BYTES} 字节上限`))
            request.destroy()
            return
          }
          chunks.push(chunk)
        })
        res.on('error', (err: Error) => done(err))
        res.on('end', () => {
          const raw = Buffer.concat(chunks)
          const text = raw.toString('utf8')
          const contentType = String(res.headers['content-type'] ?? '').toLowerCase()
          let body: unknown = text
          if (contentType.includes('json')) {
            try {
              body = JSON.parse(text)
            } catch {
              body = text
            }
          }
          const resp: LxResponse = {
            statusCode: res.statusCode ?? 0,
            statusMessage: res.statusMessage ?? '',
            headers: res.headers,
            bytes: raw.length,
            raw,
            body
          }
          done(null, resp, body)
        })
      }
    )
    this.pendingRequests.add(request)
    request.on('close', () => this.pendingRequests.delete(request))
    request.on('error', (err: Error) => done(err))
    request.setTimeout(timeout, () => {
      done(new Error(`lx.request: 请求超时（${timeout}ms）`))
      request.destroy()
    })
    if (payload) request.write(payload)
    request.end()
  }

  /** 请求头是否已经存在同名 key（忽略大小写）。 */
  private hasHeader(headers: Record<string, string>, name: string): boolean {
    const lower = name.toLowerCase()
    return Object.keys(headers).some((key) => key.toLowerCase() === lower)
  }
}

/**
 * 加载一个插件脚本。
 * @param opts 脚本路径与加载超时
 */
export async function loadPlugin(opts: LoadOptions): Promise<LoadedPlugin> {
  const host = new PluginHost(opts)
  host.load(opts.timeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS)
  return host.toLoadedPlugin()
}

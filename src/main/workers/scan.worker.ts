/**
 * 扫描工作线程：目录遍历 + 标签读取 + 哈希计算（重活全部离开主进程与渲染进程）。
 */
import { parentPort } from 'node:worker_threads'
import type { ScannedFile } from '../db'
import { collectFiles, scanOne, type ScanContext } from '../core/scanner'

export interface ScanWorkerRequest {
  type: 'scan'
  roots: string[]
  options: {
    recursive: boolean
    followSymlinks: boolean
    extensions: string[]
    computeHash: boolean
  }
  aliasPairs: Array<[string, string]>
  protectedArtists: string[]
  taskId: string
}

export type ScanWorkerMessage =
  | { type: 'progress'; done: number; total: number; current: string }
  | { type: 'records'; records: ScannedFile[] }
  | { type: 'dirErrors'; errors: Array<{ dir: string; message: string }> }
  | { type: 'done'; scanned: number; issues: number; failed: number }
  | { type: 'error'; error: string }

const port = parentPort
if (!port) throw new Error('scan.worker 必须在 worker_threads 中运行')

port.on('message', (req: ScanWorkerRequest) => {
  if (req.type !== 'scan') return
  try {
    runScan(req)
  } catch (err) {
    post({ type: 'error', error: err instanceof Error ? err.message : String(err) })
  }
})

function post(msg: ScanWorkerMessage): void {
  port!.postMessage(msg)
}

function runScan(req: ScanWorkerRequest): void {
  const aliasIndex = new Map<string, string>(req.aliasPairs)
  let cancelled = false

  const ctx: ScanContext = {
    extensions: req.options.extensions,
    recursive: req.options.recursive,
    followSymlinks: req.options.followSymlinks,
    computeHash: req.options.computeHash,
    aliasIndex,
    protectedArtists: req.protectedArtists,
    isCancelled: () => cancelled
  }

  const collected = collectFiles(req.roots, ctx)
  if (collected.dirErrors.length) {
    post({ type: 'dirErrors', errors: collected.dirErrors })
  }

  const total = collected.files.length
  let done = 0
  let issues = 0
  let failed = 0
  let buffer: ScannedFile[] = []

  for (const file of collected.files) {
    if (cancelled) break
    try {
      const rec = scanOne(file, ctx)
      issues += rec.issues.length
      buffer.push(rec)
    } catch (err) {
      failed++
      buffer.push({
        path: file,
        dir: '',
        filename: file,
        ext: '',
        size: 0,
        mtime: 0,
        audioHash: null,
        format: 'unknown',
        duration: null,
        bitrate: null,
        sampleRate: null,
        channels: null,
        hasArtwork: false,
        tags: {},
        sources: {},
        parsed: null,
        context: null,
        issues: [
          {
            code: 'scan-failed',
            level: 'error',
            message: `扫描失败：${err instanceof Error ? err.message : String(err)}`
          }
        ],
        matchState: 'pending',
        lyricState: 'none'
      })
    }
    done++
    if (buffer.length >= 50) {
      post({ type: 'records', records: buffer })
      buffer = []
    }
    post({ type: 'progress', done, total, current: file })
  }
  if (buffer.length) post({ type: 'records', records: buffer })

  post({ type: 'done', scanned: done, issues, failed })
}

/**
 * 批量写入工作线程：只改元数据，不动音频流。
 *
 * 每个文件写前记录音频数据区哈希，写后重算并比对，
 * 一旦发现音频区被改动，立即报错（宁可失败也不静默破坏文件）。
 */
import { parentPort } from 'node:worker_threads'
import path from 'node:path'
import { writeTags } from '../core/tagIo'
import { computeAudioHash } from '../core/hash'
import { formatFromExtension } from '../core/fieldMap'
import type { WriteJob, WriteJobResult } from '../core/batch'

export interface WriteWorkerRequest {
  type: 'write'
  jobs: WriteJob[]
}

export type WriteWorkerMessage =
  | { type: 'result'; results: WriteJobResult[] }
  | { type: 'progress'; done: number; total: number }
  | { type: 'error'; error: string }

const port = parentPort
if (!port) throw new Error('write.worker 必须在 worker_threads 中运行')

port.on('message', (req: WriteWorkerRequest) => {
  if (req.type !== 'write') return
  try {
    const results: WriteJobResult[] = []
    const total = req.jobs.length
    let done = 0
    for (const job of req.jobs) {
      results.push(writeOne(job))
      done++
      port!.postMessage({ type: 'progress', done, total } satisfies WriteWorkerMessage)
    }
    port!.postMessage({ type: 'result', results } satisfies WriteWorkerMessage)
  } catch (err) {
    port!.postMessage({
      type: 'error',
      error: err instanceof Error ? err.message : String(err)
    } satisfies WriteWorkerMessage)
  }
})

function writeOne(job: WriteJob): WriteJobResult {
  const format = formatFromExtension(path.extname(job.path))
  const before = computeAudioHash(job.path, format)
  const res = writeTags(job.path, job.fields)
  const after = computeAudioHash(job.path, format)
  const audioIntact = !before || !after || before === after
  return {
    path: job.path,
    ok: res.ok && audioIntact,
    written: res.written,
    failed: res.failed.map((f) => ({ field: f.field, reason: f.reason ?? '未知原因' })),
    audioIntact,
    error: res.error
  }
}

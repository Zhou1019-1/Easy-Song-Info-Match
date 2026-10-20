/**
 * 任务中心：每个批量操作都是一个独立任务，可看进度、可取消、失败可重试。
 */
import { EventEmitter } from 'node:events'
import type { TaskInfo } from '@shared/types'
import type { Db } from '../db'

export type TaskType =
  | 'scan'
  | 'match'
  | 'lyric'
  | 'write'
  | 'rename'
  | 'move'
  | 'plugin'
  | 'other'

export class TaskManager {
  private readonly tasks = new Map<string, TaskInfo>()
  private readonly cancelled = new Set<string>()
  private readonly emitter = new EventEmitter()

  constructor(private readonly db: Db) {
    for (const t of this.db.listTasks()) this.tasks.set(t.id, t)
  }

  /** 订阅任务更新。 */
  onUpdate(cb: (t: TaskInfo) => void): () => void {
    this.emitter.on('update', cb)
    return () => this.emitter.off('update', cb)
  }

  private emit(t: TaskInfo): void {
    this.db.saveTask(t)
    this.emitter.emit('update', { ...t })
  }

  create(type: TaskType, title: string): TaskInfo {
    const id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const t: TaskInfo = {
      id,
      type,
      title,
      status: 'queued',
      progress: 0,
      total: 0,
      message: '排队中',
      createdAt: Date.now()
    }
    this.tasks.set(id, t)
    this.emit(t)
    return t
  }

  start(id: string, message = '执行中'): void {
    const t = this.tasks.get(id)
    if (!t) return
    t.status = 'running'
    t.startedAt = Date.now()
    t.message = message
    this.emit(t)
  }

  progress(id: string, done: number, total: number, message?: string): void {
    const t = this.tasks.get(id)
    if (!t) return
    t.status = 'running'
    t.total = total
    t.progress = total > 0 ? Math.min(1, done / total) : 0
    if (message) t.message = message
    this.emit(t)
  }

  done(id: string, message = '已完成'): void {
    const t = this.tasks.get(id)
    if (!t) return
    t.status = 'done'
    t.progress = 1
    t.message = message
    t.finishedAt = Date.now()
    this.emit(t)
  }

  fail(id: string, error: string): void {
    const t = this.tasks.get(id)
    if (!t) return
    t.status = 'failed'
    t.message = '失败'
    t.error = error
    t.finishedAt = Date.now()
    this.emit(t)
  }

  cancel(id: string): void {
    this.cancelled.add(id)
    const t = this.tasks.get(id)
    if (!t) return
    if (t.status === 'running' || t.status === 'queued') {
      t.status = 'cancelled'
      t.message = '已取消'
      t.finishedAt = Date.now()
      this.emit(t)
    }
  }

  isCancelled(id: string): boolean {
    return this.cancelled.has(id)
  }

  get(id: string): TaskInfo | undefined {
    return this.tasks.get(id)
  }

  list(): TaskInfo[] {
    return [...this.tasks.values()].sort((a, b) => b.createdAt - a.createdAt)
  }
}

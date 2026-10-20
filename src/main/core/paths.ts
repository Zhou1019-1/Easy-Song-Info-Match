/**
 * 运行期路径解析。
 *
 * - 默认数据目录：%APPDATA%/SongMatch
 * - 便携模式：若 exe 同级存在 `portable` 目录，则数据写到 <exeDir>/portable/data
 *   （参考 lx-music-desktop 的 portable 约定）
 */
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

export interface AppPaths {
  /** 数据根目录 */
  dataDir: string
  /** 数据库文件 */
  dbFile: string
  /** 插件目录 */
  pluginDir: string
  /** 写操作前的整文件备份目录 */
  backupDir: string
  /** 日志目录 */
  logDir: string
  /** 便携模式 */
  portable: boolean
  /** 应用根目录（打包后为 exe 所在目录） */
  appDir: string
}

let cached: AppPaths | null = null

function ensureDir(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {
    /* 目录创建失败时后续写入会给出明确错误 */
  }
}

/** 解析应用路径（缓存，进程内只算一次）。 */
export function resolvePaths(): AppPaths {
  if (cached) return cached

  const appDir = path.dirname(process.execPath)
  const portableRoot = path.join(appDir, 'portable')
  const portable = fs.existsSync(portableRoot) && fs.statSync(portableRoot).isDirectory()

  let dataDir: string
  if (portable) {
    dataDir = path.join(portableRoot, 'data')
  } else {
    const appData = process.env.APPDATA || process.env.LOCALAPPDATA || app.getPath('appData')
    dataDir = path.join(appData, 'SongMatch')
  }

  const paths: AppPaths = {
    dataDir,
    dbFile: path.join(dataDir, 'songmatch.db'),
    pluginDir: path.join(dataDir, 'plugins'),
    backupDir: path.join(dataDir, 'backups'),
    logDir: path.join(dataDir, 'logs'),
    portable,
    appDir
  }

  for (const d of [paths.dataDir, paths.pluginDir, paths.backupDir, paths.logDir]) ensureDir(d)

  cached = paths
  return paths
}

/** 测试用：重置缓存。 */
export function resetPathsCache(): void {
  cached = null
}

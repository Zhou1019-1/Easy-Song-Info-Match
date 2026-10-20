/**
 * 重命名 / 归档移动的模板渲染与同名消解（纯函数 + 少量 fs 探测）。
 *
 * 规则（来自提示词「永不静默覆盖」）：
 *   - 目标已存在同名文件时，**不覆盖**，而是追加 ` (2)`、` (3)` … 直到唯一；
 *   - 同一批次内两个文件映射到同一目标名时，两者都要保留（各自拿到不同序号）；
 *   - 模板渲染失败（缺少字段）时留空并记警告，绝不编造。
 */
import fs from 'node:fs'
import path from 'node:path'
import { sanitizeFilename } from './charset'
import type { TagValues } from '@shared/types'

/** 模板可用的占位符。 */
export const TEMPLATE_TOKENS = [
  'track',
  'totaltracks',
  'disc',
  'title',
  'artist',
  'album',
  'albumartist',
  'year',
  'genre',
  'ext'
] as const

export interface TemplateContext {
  tags: TagValues
  filename: string
  ext: string
}

function firstValue(tags: TagValues, field: string): string {
  const v = tags[field]
  return v && v.length ? v[0] : ''
}

/** 渲染模板。未知占位符原样保留（便于提示用户写错了）。 */
export function renderTemplate(template: string, ctx: TemplateContext): string {
  return template.replace(/\{(\w+)\}/g, (whole, token: string) => {
    switch (token) {
      case 'track':
        return firstValue(ctx.tags, 'track')
      case 'totaltracks':
        return firstValue(ctx.tags, 'totaltracks')
      case 'disc':
        return firstValue(ctx.tags, 'disc')
      case 'title':
        return firstValue(ctx.tags, 'title')
      case 'artist':
        return firstValue(ctx.tags, 'artist')
      case 'album':
        return firstValue(ctx.tags, 'album')
      case 'albumartist':
        return firstValue(ctx.tags, 'albumartist')
      case 'year':
        return firstValue(ctx.tags, 'year') || firstValue(ctx.tags, 'date')
      case 'genre':
        return firstValue(ctx.tags, 'genre')
      case 'ext':
        return ctx.ext.replace(/^\./, '')
      default:
        return whole
    }
  })
}

/** 清理路径中的非法字符与空片段。 */
export function sanitizeRelativePath(rel: string): string {
  const parts = rel
    .split(/[\\/]+/)
    .filter((p) => p.length > 0 && p !== '.' && p !== '..')
    .map((p) => sanitizeFilename(p, '_').trim())
    .filter((p) => p.length > 0)
  return parts.join(path.sep)
}

/** 取所有选中文件的公共祖先目录。 */
export function commonAncestor(dirs: string[]): string {
  if (!dirs.length) return ''
  const split = dirs.map((d) => path.resolve(d).split(path.sep))
  const first = split[0]
  let common = first
  for (const parts of split.slice(1)) {
    let i = 0
    while (i < common.length && i < parts.length && common[i] === parts[i]) i++
    common = common.slice(0, i)
  }
  return common.join(path.sep)
}

/**
 * 在目录中找一个不冲突的文件名。
 * @param reserved 本批次已占用的文件名集合（不含路径）
 */
export function uniqueFileName(
  dir: string,
  base: string,
  ext: string,
  reserved: Set<string>,
  exists: (p: string) => boolean = (p) => fs.existsSync(p)
): string {
  const suffix = ext ? `.${ext.replace(/^\./, '')}` : ''
  let candidate = `${base}${suffix}`
  let n = 1
  while (reserved.has(candidate.toLowerCase()) || exists(path.join(dir, candidate))) {
    n += 1
    candidate = `${base} (${n})${suffix}`
    if (n > 9999) break
  }
  reserved.add(candidate.toLowerCase())
  return candidate
}

/** 生成目标文件名（不含目录），并做非法字符清洗。 */
export function buildFileName(
  template: string,
  ctx: TemplateContext,
  fallback: string
): { name: string; warnings: string[] } {
  const warnings: string[] = []
  const raw = renderTemplate(template, ctx)
  const unknown = [...raw.matchAll(/\{(\w+)\}/g)]
    .map((m) => m[1])
    .filter((t) => !(TEMPLATE_TOKENS as readonly string[]).includes(t))
  if (unknown.length) {
    warnings.push(`模板中存在未知占位符：${[...new Set(unknown)].join('、')}`)
  }
  let name = raw.trim()
  if (!name) {
    warnings.push('模板渲染结果为空，改用原文件名')
    name = fallback
  }
  // 去掉渲染结果里的非法字符
  name = name.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, ' ').trim()
  // 去掉结尾的点与空格（Windows 不允许）
  name = name.replace(/[. ]+$/g, '')
  if (!name) {
    warnings.push('清洗后文件名为空，改用原文件名')
    name = fallback
  }
  return { name, warnings }
}

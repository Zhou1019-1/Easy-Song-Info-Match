/**
 * 本地线索来源。
 *
 * 作用：把「本地文件已经解析出来的信息」本身作为一个候选交给用户，
 * 保证任何时候（哪怕全部在线来源都失败）用户都有「就用我已知的」这个选项。
 * 完全离线，不发任何网络请求。
 */
import type { Candidate } from '@shared/types'
import type { SourceAdapter, SourceContext, SourceQuery, SourceResult } from './base'

export const localAdapter: SourceAdapter = {
  id: 'local',
  name: '本地线索',
  offlineCapable: true,

  async query(q: SourceQuery, ctx: SourceContext): Promise<SourceResult> {
    const path = (q.path ?? '').trim()
    const candidate: Candidate = {
      id: `local:${path}`,
      source: 'local',
      sourceKey: path,
      title: q.title ?? '',
      artists: q.artists ?? [],
      album: q.album ?? null,
      albumArtists: [],
      composers: [],
      duration: q.duration ?? null,
      year: q.year ?? null,
      date: null,
      genre: null,
      label: null,
      upc: null,
      catalogNumber: null,
      copyright: null,
      trackNumber: null,
      discNumber: null,
      totalDiscs: null,
      advisory: 'none',
      raw: {
        // 记录来源：这些值来自本地文件自身的标签/文件名解析
        from: 'local-file',
        keyword: q.keyword ?? '',
        path
      },
      // 本地线索不参与匹配打分，交给整合方按同一套规则计算
      score: 0,
      scoreDetail: undefined
    }
    ctx.log(`[本地线索] 生成 1 条候选：${candidate.id}`)
    return { candidates: [candidate], fromCache: false }
  }
}

export default localAdapter

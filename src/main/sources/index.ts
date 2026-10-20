/**
 * 多来源适配器工厂。
 *
 * 顺序即展示顺序：MusicBrainz（最全）-> iTunes（补充）-> 本地线索（兜底）。
 */
import type { SourceAdapter, SourceContext } from './base'
import { itunesAdapter } from './itunes'
import { localAdapter } from './local'
import { musicbrainzAdapter } from './musicbrainz'

export type { SourceAdapter, SourceContext, SourceQuery, SourceResult } from './base'
export { fetchJson } from './base'

/** 按固定顺序创建全部来源适配器。 */
export function createSourceAdapters(ctx: SourceContext): SourceAdapter[] {
  const adapters: SourceAdapter[] = [musicbrainzAdapter, itunesAdapter, localAdapter]
  ctx.log(`[sources] 已创建来源适配器：${adapters.map((a) => a.name).join(' / ')}`)
  return adapters
}

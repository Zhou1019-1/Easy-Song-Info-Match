/**
 * 语义字段定义：全应用唯一事实来源。
 *
 * 「语义字段」是格式无关的抽象（title / artist / composer …），
 * 由 main/core/fieldMap.ts 映射到各容器格式的具体帧/字段。
 */

/** 可编辑的语义字段（顺序即 UI 列顺序）。 */
export const EDITABLE_FIELDS = [
  'title',
  'artist',
  'album',
  'albumartist',
  'composer',
  'lyricist',
  'genre',
  'year',
  'date',
  'track',
  'totaltracks',
  'disc',
  'totaldiscs',
  'copyright',
  'label',
  'organization',
  'publisher',
  'upc',
  'barcode',
  'isrc',
  'advisory',
  'itunesadvisory',
  'lyrics',
  'comment',
  'conductor',
  'grouping',
  'bpm',
  'compilation',
  'mb_recording_id',
  'mb_release_id',
  'mb_artist_id',
  'mb_release_artist_id'
] as const

export type EditableField = (typeof EDITABLE_FIELDS)[number]

export const EDITABLE_FIELD_SET: Set<string> = new Set(EDITABLE_FIELDS)

/** 字段中文标签。 */
export const FIELD_LABELS: Record<string, string> = {
  title: '标题',
  artist: '歌手',
  album: '专辑',
  albumartist: '专辑歌手',
  composer: '作曲家',
  lyricist: '作词',
  genre: '流派',
  year: '年份',
  date: '日期',
  track: '音轨号',
  totaltracks: '总音轨数',
  disc: '碟号',
  totaldiscs: '总碟数',
  copyright: '版权',
  label: '厂牌',
  organization: '发行机构',
  publisher: '出版商',
  upc: 'UPC',
  barcode: '条码',
  isrc: 'ISRC',
  advisory: '分级(文本)',
  itunesadvisory: '分级(iTunes)',
  lyrics: '歌词',
  comment: '备注',
  conductor: '指挥',
  grouping: '分组',
  bpm: 'BPM',
  compilation: '合辑',
  mb_recording_id: 'MB 录音 ID',
  mb_release_id: 'MB 发行 ID',
  mb_artist_id: 'MB 艺人 ID',
  mb_release_artist_id: 'MB 发行艺人 ID'
}

/** 数值型字段（编辑时按数字处理）。 */
export const NUMERIC_FIELDS: Set<string> = new Set([
  'year',
  'track',
  'totaltracks',
  'disc',
  'totaldiscs',
  'bpm',
  'itunesadvisory'
])

/** 多值字段。 */
export const MULTI_VALUE_FIELDS: Set<string> = new Set([
  'artist',
  'albumartist',
  'composer',
  'lyricist',
  'genre'
])

/** 空字段是否允许写入（false 表示该字段只读/派生）。 */
export const FIELD_META: Record<string, { label: string; multi?: boolean; numeric?: boolean; writable?: boolean }> = {
  title: { label: '标题', writable: true },
  artist: { label: '歌手', multi: true, writable: true },
  album: { label: '专辑', writable: true },
  albumartist: { label: '专辑歌手', multi: true, writable: true },
  composer: { label: '作曲家', multi: true, writable: true },
  lyricist: { label: '作词', multi: true, writable: true },
  genre: { label: '流派', multi: true, writable: true },
  year: { label: '年份', numeric: true, writable: true },
  date: { label: '日期', writable: true },
  track: { label: '音轨号', numeric: true, writable: true },
  totaltracks: { label: '总音轨数', numeric: true, writable: true },
  disc: { label: '碟号', numeric: true, writable: true },
  totaldiscs: { label: '总碟数', numeric: true, writable: true },
  copyright: { label: '版权', writable: true },
  label: { label: '厂牌', writable: true },
  organization: { label: '发行机构', writable: true },
  publisher: { label: '出版商', writable: true },
  upc: { label: 'UPC', writable: true },
  barcode: { label: '条码', writable: true },
  isrc: { label: 'ISRC', writable: true },
  advisory: { label: '分级(文本)', writable: true },
  itunesadvisory: { label: '分级(iTunes)', numeric: true, writable: true },
  lyrics: { label: '歌词', writable: true },
  comment: { label: '备注', writable: true },
  conductor: { label: '指挥', writable: true },
  grouping: { label: '分组', writable: true },
  bpm: { label: 'BPM', numeric: true, writable: true },
  compilation: { label: '合辑', writable: true },
  mb_recording_id: { label: 'MB 录音 ID', writable: true },
  mb_release_id: { label: 'MB 发行 ID', writable: true },
  mb_artist_id: { label: 'MB 艺人 ID', writable: true },
  mb_release_artist_id: { label: 'MB 发行艺人 ID', writable: true }
}

/** 表格视图中默认展示的列。 */
export const TABLE_COLUMNS = [
  'filename',
  'title',
  'artist',
  'album',
  'composer',
  'label',
  'upc',
  'disc',
  'advisory',
  'year',
  'genre',
  'lyricState',
  'matchState'
] as const

export const COLUMN_LABELS: Record<string, string> = {
  filename: '文件名',
  title: '标题',
  artist: '歌手',
  album: '专辑',
  composer: '作曲家',
  label: '厂牌',
  upc: 'UPC',
  disc: '碟号',
  advisory: '分级',
  year: '年份',
  genre: '流派',
  lyricState: '歌词状态',
  matchState: '匹配状态'
}

/** iTunes 分级数值 <-> 文本。 */
export const ITUNES_ADVISORY_TEXT: Record<number, string> = {
  0: 'none',
  1: 'clean',
  2: 'explicit'
}

export const ADVISORY_TEXT_TO_ITUNES: Record<string, number> = {
  none: 0,
  clean: 1,
  explicit: 2
}

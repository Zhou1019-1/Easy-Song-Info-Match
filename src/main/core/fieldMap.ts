/**
 * 语义字段 <-> 物理标签字段的映射表（纯数据 + 纯函数，便于单元测试）。
 *
 * 依据提示词第五节 E 的字段映射表：
 *
 * | 语义     | FLAC (Vorbis)              | MP3 (ID3)                | MP4/M4A                            |
 * |----------|----------------------------|--------------------------|------------------------------------|
 * | 作曲家   | COMPOSER                   | TCOM                     | ©wrt                               |
 * | 碟号/总碟数 | DISCNUMBER / TOTALDISCS  | TPOS                     | disk                               |
 * | 版权     | COPYRIGHT                  | TCOP                     | cprt                               |
 * | 厂牌     | LABEL + ORGANIZATION       | TPUB                     | ----:com.apple.iTunes:LABEL        |
 * | UPC      | UPC + BARCODE              | TXXX:UPC                 | ----:com.apple.iTunes:UPC          |
 * | 分级     | ADVISORY + ITUNESADVISORY  | TXXX:ADVISORY + TXXX:ITUNESADVISORY | rtng                     |
 * | 歌词     | LYRICS                     | USLT                     | ©lyr                               |
 * | 专辑     | ALBUM                      | TALB                     | ©alb                               |
 */

export type TagFormat = 'vorbis' | 'id3v2' | 'mp4' | 'ape' | 'id3v1' | 'asf' | 'riff' | 'unknown'

/** 物理键的特殊处理方式。 */
export type KeyKind =
  | 'text' // 普通文本
  | 'userText' // ID3 TXXX:<描述>
  | 'freeform' // MP4 ----:mean:name
  | 'fraction' // 形如 3/12（TRCK / TPOS）
  | 'integerPair' // MP4 trkn / disk 二进制对
  | 'numeric' // 纯数字字符串（rtng / ITUNESADVISORY）

export interface PhysicalKey {
  /** 物理键在对应格式中的写法 */
  key: string
  kind: KeyKind
}

/** 每个语义字段在各格式下的物理键（按优先级排列，第一个命中即用）。 */
export const FIELD_KEYS: Record<TagFormat, Record<string, PhysicalKey[]>> = {
  vorbis: {
    title: [{ key: 'TITLE', kind: 'text' }],
    artist: [{ key: 'ARTIST', kind: 'text' }],
    album: [{ key: 'ALBUM', kind: 'text' }],
    albumartist: [{ key: 'ALBUMARTIST', kind: 'text' }, { key: 'ALBUM ARTIST', kind: 'text' }],
    composer: [{ key: 'COMPOSER', kind: 'text' }],
    lyricist: [{ key: 'LYRICIST', kind: 'text' }, { key: 'WRITER', kind: 'text' }],
    genre: [{ key: 'GENRE', kind: 'text' }],
    year: [{ key: 'DATE', kind: 'text' }, { key: 'YEAR', kind: 'text' }],
    date: [{ key: 'DATE', kind: 'text' }],
    track: [{ key: 'TRACKNUMBER', kind: 'text' }],
    totaltracks: [{ key: 'TRACKTOTAL', kind: 'text' }, { key: 'TRACKNUMBER', kind: 'fraction' }],
    disc: [{ key: 'DISCNUMBER', kind: 'text' }],
    totaldiscs: [{ key: 'TOTALDISCS', kind: 'text' }, { key: 'DISCTOTAL', kind: 'text' }],
    copyright: [{ key: 'COPYRIGHT', kind: 'text' }],
    label: [{ key: 'LABEL', kind: 'text' }],
    organization: [{ key: 'ORGANIZATION', kind: 'text' }],
    publisher: [{ key: 'ORGANIZATION', kind: 'text' }],
    upc: [{ key: 'UPC', kind: 'text' }],
    barcode: [{ key: 'BARCODE', kind: 'text' }],
    isrc: [{ key: 'ISRC', kind: 'text' }],
    advisory: [{ key: 'ADVISORY', kind: 'text' }],
    itunesadvisory: [{ key: 'ITUNESADVISORY', kind: 'numeric' }],
    lyrics: [{ key: 'LYRICS', kind: 'text' }],
    comment: [{ key: 'COMMENT', kind: 'text' }],
    conductor: [{ key: 'CONDUCTOR', kind: 'text' }],
    grouping: [{ key: 'GROUPING', kind: 'text' }],
    bpm: [{ key: 'BPM', kind: 'numeric' }, { key: 'TEMPO', kind: 'numeric' }],
    compilation: [{ key: 'COMPILATION', kind: 'text' }],
    mb_recording_id: [{ key: 'MUSICBRAINZ_TRACKID', kind: 'text' }],
    mb_release_id: [{ key: 'MUSICBRAINZ_ALBUMID', kind: 'text' }],
    mb_artist_id: [{ key: 'MUSICBRAINZ_ARTISTID', kind: 'text' }],
    mb_release_artist_id: [{ key: 'MUSICBRAINZ_ALBUMARTISTID', kind: 'text' }]
  },
  id3v2: {
    title: [{ key: 'TIT2', kind: 'text' }],
    artist: [{ key: 'TPE1', kind: 'text' }],
    album: [{ key: 'TALB', kind: 'text' }],
    albumartist: [{ key: 'TPE2', kind: 'text' }],
    composer: [{ key: 'TCOM', kind: 'text' }],
    lyricist: [{ key: 'TEXT', kind: 'text' }, { key: 'TXXX:LYRICIST', kind: 'userText' }],
    genre: [{ key: 'TCON', kind: 'text' }],
    year: [{ key: 'TDRC', kind: 'text' }, { key: 'TYER', kind: 'text' }],
    date: [{ key: 'TDRC', kind: 'text' }],
    track: [{ key: 'TRCK', kind: 'fraction' }],
    totaltracks: [{ key: 'TRCK', kind: 'fraction' }],
    disc: [{ key: 'TPOS', kind: 'fraction' }],
    totaldiscs: [{ key: 'TPOS', kind: 'fraction' }],
    copyright: [{ key: 'TCOP', kind: 'text' }],
    label: [{ key: 'TPUB', kind: 'text' }],
    organization: [{ key: 'TPUB', kind: 'text' }],
    publisher: [{ key: 'TPUB', kind: 'text' }],
    upc: [{ key: 'TXXX:UPC', kind: 'userText' }],
    barcode: [{ key: 'TXXX:UPC', kind: 'userText' }],
    isrc: [{ key: 'TSRC', kind: 'text' }],
    advisory: [{ key: 'TXXX:ADVISORY', kind: 'userText' }],
    itunesadvisory: [{ key: 'TXXX:ITUNESADVISORY', kind: 'userText' }],
    lyrics: [{ key: 'USLT', kind: 'text' }],
    comment: [{ key: 'COMM', kind: 'text' }],
    conductor: [{ key: 'TPE3', kind: 'text' }],
    grouping: [{ key: 'TIT1', kind: 'text' }],
    bpm: [{ key: 'TBPM', kind: 'text' }],
    compilation: [{ key: 'TCMP', kind: 'text' }],
    mb_recording_id: [{ key: 'TXXX:MusicBrainz Release Track Id', kind: 'userText' }],
    mb_release_id: [{ key: 'TXXX:MusicBrainz Album Id', kind: 'userText' }],
    mb_artist_id: [{ key: 'TXXX:MusicBrainz Artist Id', kind: 'userText' }],
    mb_release_artist_id: [{ key: 'TXXX:MusicBrainz Album Artist Id', kind: 'userText' }]
  },
  mp4: {
    title: [{ key: '©nam', kind: 'text' }],
    artist: [{ key: '©ART', kind: 'text' }],
    album: [{ key: '©alb', kind: 'text' }],
    albumartist: [{ key: 'aART', kind: 'text' }],
    composer: [{ key: '©wrt', kind: 'text' }],
    lyricist: [{ key: '----:com.apple.iTunes:LYRICIST', kind: 'freeform' }],
    genre: [{ key: '©gen', kind: 'text' }],
    year: [{ key: '©day', kind: 'text' }],
    date: [{ key: '©day', kind: 'text' }],
    track: [{ key: 'trkn', kind: 'integerPair' }],
    totaltracks: [{ key: 'trkn', kind: 'integerPair' }],
    disc: [{ key: 'disk', kind: 'integerPair' }],
    totaldiscs: [{ key: 'disk', kind: 'integerPair' }],
    copyright: [{ key: 'cprt', kind: 'text' }],
    label: [{ key: '----:com.apple.iTunes:LABEL', kind: 'freeform' }],
    organization: [{ key: '----:com.apple.iTunes:LABEL', kind: 'freeform' }],
    publisher: [{ key: '----:com.apple.iTunes:LABEL', kind: 'freeform' }],
    upc: [{ key: '----:com.apple.iTunes:UPC', kind: 'freeform' }],
    barcode: [{ key: '----:com.apple.iTunes:UPC', kind: 'freeform' }],
    isrc: [{ key: '----:com.apple.iTunes:ISRC', kind: 'freeform' }],
    advisory: [{ key: 'rtng', kind: 'numeric' }],
    itunesadvisory: [{ key: 'rtng', kind: 'numeric' }],
    lyrics: [{ key: '©lyr', kind: 'text' }],
    comment: [{ key: '©cmt', kind: 'text' }],
    conductor: [{ key: '©con', kind: 'text' }],
    grouping: [{ key: '©grp', kind: 'text' }],
    bpm: [{ key: 'tmpo', kind: 'numeric' }],
    compilation: [{ key: 'cpil', kind: 'text' }],
    mb_recording_id: [{ key: '----:com.apple.iTunes:MusicBrainz Track Id', kind: 'freeform' }],
    mb_release_id: [{ key: '----:com.apple.iTunes:MusicBrainz Album Id', kind: 'freeform' }],
    mb_artist_id: [{ key: '----:com.apple.iTunes:MusicBrainz Artist Id', kind: 'freeform' }],
    mb_release_artist_id: [
      { key: '----:com.apple.iTunes:MusicBrainz Album Artist Id', kind: 'freeform' }
    ]
  },
  ape: {
    title: [{ key: 'Title', kind: 'text' }],
    artist: [{ key: 'Artist', kind: 'text' }],
    album: [{ key: 'Album', kind: 'text' }],
    albumartist: [{ key: 'Album Artist', kind: 'text' }],
    composer: [{ key: 'Composer', kind: 'text' }],
    genre: [{ key: 'Genre', kind: 'text' }],
    year: [{ key: 'Year', kind: 'text' }],
    track: [{ key: 'Track', kind: 'text' }],
    totaltracks: [{ key: 'Track', kind: 'text' }],
    disc: [{ key: 'Disc', kind: 'text' }],
    totaldiscs: [{ key: 'Disc', kind: 'text' }],
    copyright: [{ key: 'Copyright', kind: 'text' }],
    label: [{ key: 'Label', kind: 'text' }],
    upc: [{ key: 'UPC', kind: 'text' }],
    isrc: [{ key: 'ISRC', kind: 'text' }],
    lyrics: [{ key: 'Lyrics', kind: 'text' }],
    comment: [{ key: 'Comment', kind: 'text' }]
  },
  id3v1: {
    title: [{ key: 'title', kind: 'text' }],
    artist: [{ key: 'artist', kind: 'text' }],
    album: [{ key: 'album', kind: 'text' }],
    year: [{ key: 'year', kind: 'text' }],
    comment: [{ key: 'comment', kind: 'text' }],
    track: [{ key: 'track', kind: 'text' }]
  },
  asf: {
    title: [{ key: 'Title', kind: 'text' }],
    artist: [{ key: 'Author', kind: 'text' }],
    album: [{ key: 'WM/AlbumTitle', kind: 'text' }],
    albumartist: [{ key: 'WM/AlbumArtist', kind: 'text' }],
    composer: [{ key: 'WM/Composer', kind: 'text' }],
    genre: [{ key: 'WM/Genre', kind: 'text' }],
    year: [{ key: 'WM/Year', kind: 'text' }],
    track: [{ key: 'WM/TrackNumber', kind: 'text' }],
    copyright: [{ key: 'Copyright', kind: 'text' }],
    label: [{ key: 'WM/Publisher', kind: 'text' }],
    lyrics: [{ key: 'WM/Lyrics', kind: 'text' }],
    comment: [{ key: 'Description', kind: 'text' }]
  },
  riff: {
    title: [{ key: 'INAM', kind: 'text' }],
    artist: [{ key: 'IART', kind: 'text' }],
    album: [{ key: 'IPRD', kind: 'text' }],
    genre: [{ key: 'IGNR', kind: 'text' }],
    year: [{ key: 'ICRD', kind: 'text' }],
    track: [{ key: 'IPRT', kind: 'text' }],
    comment: [{ key: 'ICMT', kind: 'text' }]
  },
  unknown: {}
}

/** 按扩展名推断格式（读磁盘标签类型失败时的兜底）。 */
export function formatFromExtension(ext: string): TagFormat {
  const e = ext.replace(/^\./, '').toLowerCase()
  switch (e) {
    case 'flac':
    case 'ogg':
    case 'oga':
    case 'opus':
      return 'vorbis'
    case 'mp3':
    case 'mp2':
    case 'aac':
      return 'id3v2'
    case 'm4a':
    case 'm4b':
    case 'mp4':
    case 'm4v':
      return 'mp4'
    case 'ape':
    case 'wv':
    case 'mpc':
    case 'tta':
      return 'ape'
    case 'dsf':
    case 'dff':
      return 'id3v2'
    case 'wav':
    case 'wave':
      return 'riff'
    case 'wma':
      return 'asf'
    default:
      return 'unknown'
  }
}

/** 解析 "3/12" 形式的分数键。 */
export function parseFraction(value: string): { numerator: number | null; denominator: number | null } {
  const m = value.trim().match(/^(\d+)\s*\/\s*(\d+)$/)
  if (!m) {
    const n = Number(value.trim())
    return { numerator: Number.isFinite(n) ? n : null, denominator: null }
  }
  return { numerator: Number(m[1]), denominator: Number(m[2]) }
}

/** 生成 "3/12" 形式的分数键。 */
export function formatFraction(numerator: number | null, denominator: number | null): string {
  if (!numerator) return ''
  if (!denominator) return String(numerator)
  return `${numerator}/${denominator}`
}

/** 该格式是否支持该字段（用于「写入失败明确提示」）。 */
export function supportsField(format: TagFormat, field: string): boolean {
  return (FIELD_KEYS[format]?.[field]?.length ?? 0) > 0
}

/** 该格式支持的字段列表。 */
export function supportedFields(format: TagFormat): string[] {
  return Object.keys(FIELD_KEYS[format] ?? {})
}

/** 格式能力弱提示（DSF/DFF/WAV）。 */
export const WEAK_FORMATS: TagFormat[] = ['riff', 'id3v1']

export function formatWarning(format: TagFormat): string | null {
  switch (format) {
    case 'riff':
      return 'WAV 的 RIFF INFO 标签能力很弱，仅支持标题/歌手/专辑/流派/年份等基础字段，歌词与厂牌类字段将写入失败。'
    case 'id3v1':
      return 'ID3v1 仅支持标题/歌手/专辑/年份/音轨号，字段极少。'
    case 'unknown':
      return '未知容器格式，标签写入可能不被支持。'
    default:
      return null
  }
}

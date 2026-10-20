/**
 * 语义字段 <-> 物理标签键映射表的单元测试。
 */
import { describe, expect, it } from 'vitest'
import {
  FIELD_KEYS,
  WEAK_FORMATS,
  formatFraction,
  formatFromExtension,
  formatWarning,
  parseFraction,
  supportedFields,
  supportsField
} from '@main/core/fieldMap'

describe('formatFromExtension', () => {
  it('按扩展名推断标签格式', () => {
    expect(formatFromExtension('flac')).toBe('vorbis')
    expect(formatFromExtension('mp3')).toBe('id3v2')
    expect(formatFromExtension('m4a')).toBe('mp4')
    expect(formatFromExtension('wav')).toBe('riff')
  })

  it('未知扩展名返回 unknown', () => {
    expect(formatFromExtension('xyz')).toBe('unknown')
    expect(formatFromExtension('')).toBe('unknown')
  })

  it('忽略前导点与大小写', () => {
    expect(formatFromExtension('.FLAC')).toBe('vorbis')
  })

  it('其它常见扩展名映射正确', () => {
    expect(formatFromExtension('ogg')).toBe('vorbis')
    expect(formatFromExtension('ape')).toBe('ape')
    expect(formatFromExtension('wma')).toBe('asf')
  })
})

describe('parseFraction / formatFraction', () => {
  it('解析 "3/12" 形式的分数键', () => {
    expect(parseFraction('3/12')).toEqual({ numerator: 3, denominator: 12 })
  })

  it('纯数字解析为不带分母的分数', () => {
    expect(parseFraction('7')).toEqual({ numerator: 7, denominator: null })
  })

  it('非法输入返回 null', () => {
    expect(parseFraction('abc')).toEqual({ numerator: null, denominator: null })
  })

  it('生成 "3/12" 形式的分数键', () => {
    expect(formatFraction(3, 12)).toBe('3/12')
    expect(formatFraction(3, null)).toBe('3')
  })

  it('分母缺失时只输出分子', () => {
    expect(formatFraction(0, 12)).toBe('')
  })
})

describe('supportsField / supportedFields', () => {
  it('vorbis 支持 composer', () => {
    expect(supportsField('vorbis', 'composer')).toBe(true)
  })

  it('id3v1 不支持 lyrics', () => {
    expect(supportsField('id3v1', 'lyrics')).toBe(false)
  })

  it('supportedFields 返回该格式可写的字段名', () => {
    const fields = supportedFields('vorbis')
    expect(fields).toContain('composer')
    expect(fields).toContain('lyrics')
    expect(supportedFields('id3v1')).not.toContain('lyrics')
  })

  it('未知格式没有可用字段', () => {
    expect(supportedFields('unknown')).toEqual([])
    expect(supportsField('unknown', 'title')).toBe(false)
  })
})

describe('FIELD_KEYS', () => {
  it('vorbis 字段映射符合规格', () => {
    expect(FIELD_KEYS.vorbis.composer[0].key).toBe('COMPOSER')
    expect(FIELD_KEYS.vorbis.disc[0].key).toBe('DISCNUMBER')
    expect(FIELD_KEYS.vorbis.copyright[0].key).toBe('COPYRIGHT')
    expect(FIELD_KEYS.vorbis.label[0].key).toBe('LABEL')
    expect(FIELD_KEYS.vorbis.upc[0].key).toBe('UPC')
    expect(FIELD_KEYS.vorbis.advisory[0].key).toBe('ADVISORY')
    expect(FIELD_KEYS.vorbis.lyrics[0].key).toBe('LYRICS')
  })

  it('id3v2 字段映射符合规格', () => {
    expect(FIELD_KEYS.id3v2.composer[0].key).toBe('TCOM')
    expect(FIELD_KEYS.id3v2.disc[0].key).toBe('TPOS')
    expect(FIELD_KEYS.id3v2.copyright[0].key).toBe('TCOP')
    expect(FIELD_KEYS.id3v2.label[0].key).toBe('TPUB')
    expect(FIELD_KEYS.id3v2.upc[0].key).toBe('TXXX:UPC')
    expect(FIELD_KEYS.id3v2.advisory[0].key).toBe('TXXX:ADVISORY')
    expect(FIELD_KEYS.id3v2.lyrics[0].key).toBe('USLT')
  })

  it('mp4 字段映射符合规格', () => {
    expect(FIELD_KEYS.mp4.composer[0].key).toBe('©wrt')
    expect(FIELD_KEYS.mp4.disc[0].key).toBe('disk')
    expect(FIELD_KEYS.mp4.copyright[0].key).toBe('cprt')
    expect(FIELD_KEYS.mp4.advisory[0].key).toBe('rtng')
    expect(FIELD_KEYS.mp4.lyrics[0].key).toBe('©lyr')
  })

  it('特殊字段的写入方式标注正确', () => {
    expect(FIELD_KEYS.id3v2.upc[0].kind).toBe('userText')
    expect(FIELD_KEYS.id3v2.disc[0].kind).toBe('fraction')
    expect(FIELD_KEYS.mp4.upc[0].kind).toBe('freeform')
    expect(FIELD_KEYS.mp4.disc[0].kind).toBe('integerPair')
    expect(FIELD_KEYS.mp4.advisory[0].kind).toBe('numeric')
  })

  it('每个格式都提供标题/歌手/专辑的映射', () => {
    for (const format of ['vorbis', 'id3v2', 'mp4', 'ape', 'id3v1', 'asf', 'riff'] as const) {
      expect(supportsField(format, 'title')).toBe(true)
      expect(supportsField(format, 'artist')).toBe(true)
      expect(supportsField(format, 'album')).toBe(true)
    }
  })
})

describe('formatWarning', () => {
  it('riff 与 id3v1 给出中文提示', () => {
    const riff = formatWarning('riff')
    const id3v1 = formatWarning('id3v1')
    expect(riff).not.toBeNull()
    expect(id3v1).not.toBeNull()
    expect(riff).toMatch(/[\u4e00-\u9fa5]/)
    expect(id3v1).toMatch(/[\u4e00-\u9fa5]/)
  })

  it('能力足够的格式没有提示', () => {
    expect(formatWarning('vorbis')).toBeNull()
    expect(formatWarning('id3v2')).toBeNull()
    expect(formatWarning('mp4')).toBeNull()
  })

  it('未知容器格式也会提示', () => {
    expect(formatWarning('unknown')).not.toBeNull()
  })
})

describe('WEAK_FORMATS', () => {
  it('包含能力弱的格式', () => {
    expect(WEAK_FORMATS).toContain('riff')
    expect(WEAK_FORMATS).toContain('id3v1')
  })
})

/**
 * 艺人别名归一 / 多歌手拆分的单元测试。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ALIAS_RULES,
  DEFAULT_PROTECTED_ARTISTS,
  artistKey,
  buildAliasIndex,
  canonicalArtist,
  mergeArtistLists,
  sameArtist,
  splitArtists,
  tidyArtistName
} from '@main/core/alias'

const ALIAS_INDEX = buildAliasIndex(DEFAULT_ALIAS_RULES)

describe('artistKey', () => {
  it('忽略撇号，空格归一', () => {
    expect(artistKey("Fool's Garden")).toBe('fools garden')
    expect(artistKey('Fools Garden')).toBe('fools garden')
    expect(artistKey("Fool's Garden")).toBe(artistKey('Fools Garden'))
  })

  it('忽略大小写与首尾空白', () => {
    expect(artistKey('  Taylor Swift ')).toBe('taylor swift')
  })

  it('去掉句点等标点但保留斜杠', () => {
    expect(artistKey('P!nk')).toBe('pnk')
    expect(artistKey('AC/DC')).toBe('ac/dc')
  })
})

describe('tidyArtistName', () => {
  it('折叠空白并去掉首尾噪声', () => {
    expect(tidyArtistName('  The   Beatles  ')).toBe('The Beatles')
    expect(tidyArtistName('-Taylor Swift-')).toBe('Taylor Swift')
    expect(tidyArtistName('__薛之谦')).toBe('薛之谦')
  })
})

describe('splitArtists', () => {
  it('按分号/顿号拆分（最高优先级）', () => {
    expect(splitArtists('A; B、 C')).toEqual(['A', 'B', 'C'])
    expect(splitArtists('A；B')).toEqual(['A', 'B'])
  })

  it('按逗号拆分', () => {
    expect(splitArtists('A, B')).toEqual(['A', 'B'])
    expect(splitArtists('A，B')).toEqual(['A', 'B'])
  })

  it('按 & 拆分', () => {
    expect(splitArtists('A & B')).toEqual(['A', 'B'])
  })

  it('按 feat./ft./featuring/with 拆分（最低优先级）', () => {
    expect(splitArtists('Artist feat. Other')).toEqual(['Artist', 'Other'])
    expect(splitArtists('Artist ft. Other')).toEqual(['Artist', 'Other'])
    expect(splitArtists('Artist featuring Other')).toEqual(['Artist', 'Other'])
    expect(splitArtists('Artist with Other')).toEqual(['Artist', 'Other'])
  })

  it('多级分隔符按优先级逐级拆分', () => {
    expect(splitArtists('A; B, C & D feat. E')).toEqual(['A', 'B', 'C', 'D', 'E'])
  })

  it('保护名单内的艺名不被拆开', () => {
    expect(splitArtists('AC/DC')).toEqual(['AC/DC'])
    expect(splitArtists('Earth, Wind & Fire')).toEqual(['Earth, Wind & Fire'])
    expect(splitArtists('Simon & Garfunkel')).toEqual(['Simon & Garfunkel'])
  })

  it('保护名单整体命中时不做任何拆分', () => {
    expect(splitArtists('AC/DC; Earth, Wind & Fire')).toEqual(['AC/DC', 'Earth, Wind & Fire'])
  })

  it('拆分产生的片段若命中保护名单则整段保留', () => {
    expect(splitArtists('AC/DC & Other')).toEqual(['AC/DC', 'Other'])
  })

  it('空串或纯空白返回空数组', () => {
    expect(splitArtists('')).toEqual([])
    expect(splitArtists('   ')).toEqual([])
  })
})

describe('buildAliasIndex / canonicalArtist', () => {
  it('命中别名表时返回规范名', () => {
    expect(canonicalArtist('老鹰', ALIAS_INDEX)).toBe('Eagles')
    expect(canonicalArtist('MJ', ALIAS_INDEX)).toBe('Michael Jackson')
    expect(canonicalArtist('The Eagles', ALIAS_INDEX)).toBe('Eagles')
  })

  it('未命中别名表时返回清洗后的原名', () => {
    expect(canonicalArtist('老鹰')).toBe('老鹰')
    expect(canonicalArtist('  老鹰  ')).toBe('老鹰')
    expect(canonicalArtist('未知歌手', ALIAS_INDEX)).toBe('未知歌手')
  })

  it('空名返回空串', () => {
    expect(canonicalArtist('', ALIAS_INDEX)).toBe('')
  })

  it('别名索引以归一化后的键建立', () => {
    expect(ALIAS_INDEX.get('老鹰')).toBe('Eagles')
    expect(ALIAS_INDEX.size).toBeGreaterThan(0)
  })
})

describe('mergeArtistLists', () => {
  it('同一歌手的不同写法合并为一条', () => {
    const merged = mergeArtistLists([["Fool's Garden"], ['Fools Garden']])
    expect(merged).toHaveLength(1)
    expect(merged[0]).toBe('Fools Garden')
  })

  it('相同写法去重', () => {
    expect(mergeArtistLists([['AC/DC'], ['AC/DC']])).toEqual(['AC/DC'])
  })

  it('不同歌手保持多条', () => {
    expect(mergeArtistLists([['米津玄師'], ['Taylor Swift']])).toEqual(['米津玄師', 'Taylor Swift'])
  })

  it('空白项被忽略', () => {
    expect(mergeArtistLists([[], ['  ']])).toEqual([])
  })
})

describe('sameArtist', () => {
  it('别名表能关联的两种写法视为同一歌手', () => {
    expect(sameArtist('老鹰', 'Eagles', ALIAS_INDEX)).toBe(true)
    expect(sameArtist("Fool's Garden", 'Fools Garden', ALIAS_INDEX)).toBe(true)
  })

  it('确实是不同歌手时返回 false', () => {
    expect(sameArtist('米津玄師', 'Taylor Swift', ALIAS_INDEX)).toBe(false)
  })

  it('空串不参与判定', () => {
    expect(sameArtist('', 'Taylor Swift', ALIAS_INDEX)).toBe(false)
  })
})

describe('默认配置', () => {
  it('默认保护名单包含常见不可拆分艺名', () => {
    expect(DEFAULT_PROTECTED_ARTISTS).toContain('AC/DC')
    expect(DEFAULT_PROTECTED_ARTISTS).toContain('Earth, Wind & Fire')
    expect(DEFAULT_PROTECTED_ARTISTS).toContain('Simon & Garfunkel')
  })

  it('默认别名规则包含中英文写法归一', () => {
    expect(DEFAULT_ALIAS_RULES.some((r) => r.from === '老鹰' && r.to === 'Eagles')).toBe(true)
  })
})

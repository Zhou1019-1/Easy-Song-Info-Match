/**
 * 匹配打分的单元测试。
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_ALIAS_RULES, buildAliasIndex } from '@main/core/alias'
import {
  AUTO_ACCEPT_SCORE,
  HIGH_CONFIDENCE_SCORE,
  SCORE_WEIGHTS,
  artistSimilarity,
  diceCoefficient,
  durationSimilarity,
  levenshtein,
  normalizeText,
  scoreCandidate,
  similarity,
  stripParenthetical,
  titleGuard,
  yearSimilarity
} from '@main/core/scoring'

const ALIAS_INDEX = buildAliasIndex(DEFAULT_ALIAS_RULES)

describe('stripParenthetical', () => {
  it('去掉括号内的补充说明', () => {
    expect(stripParenthetical('Lemon (Remastered 2019)')).toBe('Lemon')
    expect(stripParenthetical('Lemon【Live】')).toBe('Lemon')
  })
})

describe('normalizeText', () => {
  it('去掉括号补充说明', () => {
    expect(normalizeText('Lemon (Remastered 2019)')).toBe('lemon')
    expect(normalizeText('Lemon【Live】')).toBe('lemon')
  })

  it('去掉 feat./live 等噪声词', () => {
    expect(normalizeText('Lemon feat. Other')).toBe('lemon other')
  })

  it('统一大小写并把标点变成空格', () => {
    expect(normalizeText('Hello, World!')).toBe('hello world')
  })
})

describe('levenshtein', () => {
  it('相同字符串距离为 0', () => {
    expect(levenshtein('lemon', 'lemon')).toBe(0)
  })

  it('经典编辑距离', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3)
  })

  it('空串与另一串的距离等于另一串长度', () => {
    expect(levenshtein('', 'abc')).toBe(3)
    expect(levenshtein('abc', '')).toBe(3)
  })
})

describe('diceCoefficient', () => {
  it('相同字符串系数为 1', () => {
    expect(diceCoefficient('lemon', 'lemon')).toBe(1)
    expect(diceCoefficient('abc', 'abc')).toBe(1)
  })

  it('完全不同字符串系数为 0', () => {
    expect(diceCoefficient('abc', 'xyz')).toBe(0)
  })
})

describe('similarity', () => {
  it('相同字符串为 1', () => {
    expect(similarity('Lemon', 'Lemon')).toBe(1)
  })

  it('包含关系得分很高', () => {
    expect(similarity('Lemon', 'Lemon (Live)')).toBeGreaterThanOrEqual(0.85)
    expect(similarity('Lemon', 'Lemonade')).toBeGreaterThanOrEqual(0.85)
  })

  it('完全不同的字符串得分很低', () => {
    expect(similarity('Lemon', '夜曲')).toBeLessThan(0.2)
  })

  it('空串得分为 0', () => {
    expect(similarity('', 'Lemon')).toBe(0)
  })
})

describe('artistSimilarity', () => {
  it('多歌手顺序不影响得分', () => {
    expect(artistSimilarity(['米津玄師', 'Bump of Chicken'], ['Bump of Chicken', '米津玄師'])).toBe(1)
  })

  it('别名写法通过别名表仍能匹配', () => {
    expect(artistSimilarity(['老鹰'], ['Eagles'], ALIAS_INDEX)).toBe(1)
  })

  it('没有别名表时别名写法无法匹配', () => {
    expect(artistSimilarity(['老鹰'], ['Eagles'])).toBe(0)
  })

  it('一侧为空返回 0', () => {
    expect(artistSimilarity([], ['Eagles'], ALIAS_INDEX)).toBe(0)
  })
})

describe('durationSimilarity', () => {
  it('时长相同为 1', () => {
    expect(durationSimilarity(200, 200)).toBe(1)
  })

  it('相差 1~2 秒仍为高分', () => {
    expect(durationSimilarity(200, 201.5)).toBe(1)
    expect(durationSimilarity(200, 202)).toBe(1)
  })

  it('相差 3~5 秒开始降档', () => {
    expect(durationSimilarity(200, 203)).toBe(0.85)
  })

  it('相差 10 秒左右明显下降', () => {
    expect(durationSimilarity(100, 110)).toBe(0.6)
  })

  it('相差很大时为 0', () => {
    expect(durationSimilarity(200, 260)).toBe(0)
  })

  it('任一侧为 null 时为 0', () => {
    expect(durationSimilarity(null, 200)).toBe(0)
    expect(durationSimilarity(200, null)).toBe(0)
  })
})

describe('yearSimilarity', () => {
  it('年份相同为 1', () => {
    expect(yearSimilarity(2020, 2020)).toBe(1)
  })

  it('年份不同会降档', () => {
    expect(yearSimilarity(2020, 2021)).toBeLessThan(1)
    expect(yearSimilarity(2020, 2024)).toBe(0.25)
    expect(yearSimilarity(2020, 2010)).toBe(0)
  })

  it('任一侧为 null 时为 0', () => {
    expect(yearSimilarity(null, 2020)).toBe(0)
  })
})

describe('scoreCandidate', () => {
  const query = { title: 'Lemon', artists: ['米津玄師'], album: 'LEMON', duration: 240, year: 2020 }

  it('标题/歌手/专辑/时长/年份全部命中时总分 100', () => {
    const detail = scoreCandidate(query, {
      title: 'Lemon',
      artists: ['米津玄師'],
      album: 'LEMON',
      duration: 241,
      year: 2020
    })
    expect(detail).toEqual({
      title: 100,
      artist: 100,
      album: 100,
      duration: 100,
      year: 100,
      total: 100
    })
  })

  it('标题与歌手命中但缺少其他信息时明显高于完全不匹配', () => {
    const partial = scoreCandidate(query, { title: 'Lemon', artists: ['米津玄師'] })
    const none = scoreCandidate(query, {
      title: '夜曲',
      artists: ['周杰伦'],
      album: '十一月的萧邦',
      duration: 300,
      year: 2005
    })
    expect(partial.total).toBeGreaterThan(none.total)
    expect(partial.total).toBeGreaterThanOrEqual(AUTO_ACCEPT_SCORE)
    expect(partial.total).toBeLessThan(HIGH_CONFIDENCE_SCORE)
  })

  it('明细包含 5 个维度与总分，总分落在 0~100', () => {
    const detail = scoreCandidate(query, {
      title: 'Lemon (Live)',
      artists: ['米津玄師'],
      album: 'LEMON',
      duration: 240,
      year: 2020
    })
    expect(Object.keys(detail).sort()).toEqual(['album', 'artist', 'duration', 'title', 'total', 'year'])
    expect(detail.total).toBeGreaterThanOrEqual(0)
    expect(detail.total).toBeLessThanOrEqual(100)
  })

  it('完全不匹配的候选各维度均为 0', () => {
    const detail = scoreCandidate(query, {
      title: '夜曲',
      artists: ['周杰伦'],
      album: '十一月的萧邦',
      duration: 300,
      year: 2005
    })
    expect(detail.total).toBe(0)
    expect(detail.title).toBe(0)
    expect(detail.artist).toBe(0)
  })
})

describe('titleGuard', () => {
  it('标题一致时通过', () => {
    expect(titleGuard('Lemon', 'Lemon')).toBe(true)
    expect(titleGuard('Lemon (Live)', 'Lemon')).toBe(true)
  })

  it('标题完全不同的歌曲被拦截', () => {
    expect(titleGuard('夜曲', 'Lemon')).toBe(false)
  })
})

describe('打分常量', () => {
  it('高置信阈值高于自动采纳阈值', () => {
    expect(HIGH_CONFIDENCE_SCORE).toBeGreaterThan(AUTO_ACCEPT_SCORE)
  })

  it('各维度权重之和为 1', () => {
    const sum =
      SCORE_WEIGHTS.title +
      SCORE_WEIGHTS.artist +
      SCORE_WEIGHTS.album +
      SCORE_WEIGHTS.duration +
      SCORE_WEIGHTS.year
    expect(sum).toBeCloseTo(1, 10)
  })
})

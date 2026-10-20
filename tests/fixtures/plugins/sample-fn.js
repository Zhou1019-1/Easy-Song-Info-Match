/**
 * @name 函数式音源
 * @description 函数式协议示例插件（module.exports 形式）
 * @version 1.0.0
 * @author someone
 */

module.exports = {
  name: '函数式音源',
  version: '1.0.0',
  description: '函数式协议示例插件',
  author: 'someone',
  qualitys: ['128k', '320k', 'flac', 'flac24bit'],
  sources: {
    kw: { name: '酷我', qualitys: ['128k', '320k'] },
    kg: { name: '酷狗' }
  },
  musicSearch(keyword, page, size) {
    const limit = size || 3
    const list = []
    for (let i = 0; i < limit; i += 1) {
      list.push({
        id: `fn-${page || 1}-${i}`,
        name: `${keyword || '关键词'} - 第 ${i + 1} 首`,
        singer: '示例歌手',
        album: '示例专辑',
        source: 'kw',
        interval: 200 + i,
        imgurl: 'https://example.com/cover.jpg',
        lyric: '[00:00.00]hello'
      })
    }
    return { list, total: list.length, limit, page: page || 1 }
  },
  musicUrl(musicInfo, quality) {
    const id = musicInfo && musicInfo.id ? musicInfo.id : 'default'
    return { url: `https://example.com/audio/${id}.mp3?quality=${quality || '128k'}` }
  },
  lyric(musicInfo, type) {
    return { lyric: '[00:00.00]hello world', translation: '[00:00.00]你好世界' }
  },
  albumArt(musicInfo) {
    return 'https://example.com/cover.jpg'
  }
}

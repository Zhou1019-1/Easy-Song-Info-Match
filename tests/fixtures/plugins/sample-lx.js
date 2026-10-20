/**
 * @name 示例音源
 * @description 一个用于自测的示例音源（洛雪事件驱动协议）
 * @version 1.0.0
 * @author someone
 * @homepage https://example.com
 */

const { EVENT_NAMES, request, utils } = globalThis.lx

const source = {
  name: '示例音源',
  type: 'music',
  qualitys: ['128k', '320k', 'flac', 'flac24bit'],
  sources: {
    kw: { name: '酷我', type: 'music', qualitys: ['128k', '320k', 'flac'] },
    kg: { name: '酷狗', type: 'music', qualitys: ['128k', '320k', 'flac', 'flac24bit'] }
  }
}

const handlers = {
  onRequest: (data) => {
    switch (data.action) {
      case 'musicUrl':
        // data.source, data.musicInfo, data.quality
        return { url: 'https://example.com/audio.mp3' }
      case 'lyric':
        // ONLY the 'local' source supports lyric
        return { lyric: '[00:00.00]hello', tlyric: '', rlyric: '', lxlyric: '' }
      case 'pic':
        // ONLY the 'local' source supports pic
        return { url: 'https://example.com/cover.jpg' }
    }
  }
}

globalThis.lx.on(EVENT_NAMES.request, handlers.onRequest)
globalThis.lx.send(EVENT_NAMES.inited, { sources: source.sources })

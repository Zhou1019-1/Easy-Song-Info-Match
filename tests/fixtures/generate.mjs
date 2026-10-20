/**
 * 生成测试用音频样本（无需 ffmpeg）。
 *
 * 生成的都是「结构合法」的最小音频容器：
 *  - MP3  : 真实 MPEG-1 Layer III 帧序列
 *  - FLAC : fLaC + STREAMINFO + VORBIS_COMMENT
 *  - WAV  : 标准 RIFF/WAVE
 *  - M4A  : ftyp + moov/udta/meta/ilst 最小结构
 *
 * 用法：node tests/fixtures/generate.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/* ---------------------------------------------------------------- MP3 --- */

const MPEG1_L3_128K_44K = Buffer.from([0xff, 0xfb, 0x90, 0x00])
const MPEG1_L3_FRAME_SIZE = 417

function makeMp3Audio(frames = 24) {
  const buf = Buffer.alloc(MPEG1_L3_FRAME_SIZE * frames)
  for (let i = 0; i < frames; i++) {
    MPEG1_L3_128K_44K.copy(buf, i * MPEG1_L3_FRAME_SIZE)
  }
  return buf
}

/** ID3v2.3 文本帧（UTF-8 编码，ID3v2.3+ 允许 0x03） */
function textFrame(id, text) {
  const payload = Buffer.concat([
    Buffer.from([0x03]), // 编码：UTF-8
    Buffer.from(text, 'utf8')
  ])
  const header = Buffer.alloc(10)
  header.write(id, 0, 'latin1')
  header.writeUInt32BE(payload.length, 4)
  return Buffer.concat([header, payload])
}

/** ID3v2.3 TXXX 用户文本帧 */
function userTextFrame(description, text) {
  const payload = Buffer.concat([
    Buffer.from([0x03]),
    Buffer.from(description, 'utf8'),
    Buffer.from([0x00]),
    Buffer.from(text, 'utf8')
  ])
  const header = Buffer.alloc(10)
  header.write('TXXX', 0, 'latin1')
  header.writeUInt32BE(payload.length, 4)
  return Buffer.concat([header, payload])
}

/** ID3v2.3 USLT 帧（编码 + 语言(3) + 描述(null 结尾) + 文本） */
function usltFrame(description, language, text) {
  const payload = Buffer.concat([
    Buffer.from([0x03]),
    Buffer.from(language, 'latin1'),
    Buffer.from(description, 'utf8'),
    Buffer.from([0x00]),
    Buffer.from(text, 'utf8')
  ])
  const header = Buffer.alloc(10)
  header.write('USLT', 0, 'latin1')
  header.writeUInt32BE(payload.length, 4)
  return Buffer.concat([header, payload])
}

function id3v2(frames) {
  const body = Buffer.concat(frames)
  const size = body.length
  const header = Buffer.alloc(10)
  header.write('ID3', 0, 'latin1')
  header[3] = 3 // version 2.3
  header[4] = 0
  header[5] = 0
  // syncsafe 长度
  header[6] = (size >> 21) & 0x7f
  header[7] = (size >> 14) & 0x7f
  header[8] = (size >> 7) & 0x7f
  header[9] = size & 0x7f
  return Buffer.concat([header, body])
}

/* --------------------------------------------------------------- FLAC --- */

function flacBlock(type, data, isLast) {
  const head = Buffer.alloc(4)
  head[0] = (isLast ? 0x80 : 0) | type
  head.writeUIntBE(data.length, 1, 3)
  return Buffer.concat([head, data])
}

function flacStreamInfo() {
  const b = Buffer.alloc(34)
  b.writeUInt16BE(4096, 0) // min block
  b.writeUInt16BE(4096, 2) // max block
  // min/max frame size 24bit = 0
  const sampleRate = 44100
  const channels = 2
  const bps = 16
  const totalSamples = 44100
  // 64bit: sampleRate(20) | channels-1(3) | bps-1(5) | totalSamples(36)
  let v =
    (BigInt(sampleRate) << 44n) |
    (BigInt(channels - 1) << 41n) |
    (BigInt(bps - 1) << 36n) |
    BigInt(totalSamples)
  for (let i = 0; i < 8; i++) {
    b[10 + i] = Number((v >> BigInt(8 * (7 - i))) & 0xffn)
  }
  return b
}

function vorbisComment(comments, vendor = 'SongMatch Fixtures') {
  const parts = []
  const v = Buffer.from(vendor, 'utf8')
  const head = Buffer.alloc(4)
  head.writeUInt32LE(v.length, 0)
  parts.push(head, v)
  const cnt = Buffer.alloc(4)
  cnt.writeUInt32LE(comments.length, 0)
  parts.push(cnt)
  for (const c of comments) {
    const cb = Buffer.from(c, 'utf8')
    const l = Buffer.alloc(4)
    l.writeUInt32LE(cb.length, 0)
    parts.push(l, cb)
  }
  return Buffer.concat(parts)
}

function makeFlac(comments = []) {
  const blocks = [
    flacBlock(0, flacStreamInfo(), false),
    flacBlock(4, vorbisComment(comments), true)
  ]
  // 伪造一帧 FLAC（同步码 + 头部），供属性解析
  const fakeFrame = Buffer.alloc(64)
  fakeFrame[0] = 0xff
  fakeFrame[1] = 0xf8
  return Buffer.concat([Buffer.from('fLaC', 'latin1'), ...blocks, fakeFrame])
}

/* ---------------------------------------------------------------- WAV --- */

/** RIFF INFO 块（LIST/INFO），用于给 WAV 带上可读写的标签。 */
function riffInfoChunk(entries) {
  const parts = [Buffer.from('INFO', 'latin1')]
  for (const [id, value] of entries) {
    const data = Buffer.from(value, 'latin1')
    const head = Buffer.alloc(8)
    head.write(id, 0, 'latin1')
    head.writeUInt32LE(data.length, 4)
    parts.push(head, data)
    if (data.length % 2) parts.push(Buffer.from([0]))
  }
  const body = Buffer.concat(parts)
  const head = Buffer.alloc(8)
  head.write('LIST', 0, 'latin1')
  head.writeUInt32LE(body.length, 4)
  return Buffer.concat([head, body])
}

function makeWav() {
  const dataSize = 44100 * 2
  const data = Buffer.alloc(dataSize)
  const fmt = Buffer.alloc(24)
  fmt.write('fmt ', 0, 'latin1')
  fmt.writeUInt32LE(16, 4)
  fmt.writeUInt16LE(1, 8) // PCM
  fmt.writeUInt16LE(2, 10) // channels
  fmt.writeUInt32LE(44100, 12)
  fmt.writeUInt32LE(176400, 16)
  fmt.writeUInt16LE(4, 20)
  fmt.writeUInt16LE(16, 22)
  const dataHeader = Buffer.alloc(8)
  dataHeader.write('data', 0, 'latin1')
  dataHeader.writeUInt32LE(dataSize, 4)
  const info = riffInfoChunk([
    ['INAM', 'Wave Sample'],
    ['IART', 'Various'],
    ['IPRD', 'Compilation'],
    ['IGNR', 'Test'],
    ['ICRD', '2020']
  ])
  const riffSize = 4 + fmt.length + dataHeader.length + dataSize + info.length
  const riff = Buffer.alloc(12)
  riff.write('RIFF', 0, 'latin1')
  riff.writeUInt32LE(riffSize, 4)
  riff.write('WAVE', 8, 'latin1')
  return Buffer.concat([riff, fmt, dataHeader, data, info])
}

/* ---------------------------------------------------------------- MP4 --- */

function box(type, ...payload) {
  const body = Buffer.concat(payload.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))))
  const head = Buffer.alloc(8)
  head.writeUInt32BE(body.length + 8, 0)
  head.write(type, 4, 'latin1')
  return Buffer.concat([head, body])
}

function fullBox(type, version, flags, ...payload) {
  const vf = Buffer.alloc(4)
  vf[0] = version
  vf.writeUIntBE(flags, 1, 3)
  return box(type, vf, ...payload)
}

function makeM4a(tags = {}) {
  const ftyp = box('ftyp', Buffer.from('M4A ', 'latin1'), Buffer.from([0, 0, 0, 0]), Buffer.from('M4A mp42isom', 'latin1'))

  const mvhd = fullBox(
    'mvhd',
    0,
    0,
    (() => {
      const b = Buffer.alloc(100)
      b.writeUInt32BE(0, 0) // creation
      b.writeUInt32BE(0, 4) // modification
      b.writeUInt32BE(1000, 8) // timescale
      b.writeUInt32BE(1000, 12) // duration
      b.writeUInt32BE(0x00010000, 16) // rate
      b.writeUInt16BE(0x0100, 20) // volume
      b.writeUInt16BE(0, 22)
      b.writeUInt32BE(0, 24)
      b.writeUInt32BE(0, 28)
      // unity matrix
      const m = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000]
      m.forEach((v, i) => b.writeUInt32BE(v, 32 + i * 4))
      for (let i = 0; i < 6; i++) b.writeUInt32BE(0, 68 + i * 4)
      b.writeUInt32BE(2, 96) // next track id
      return b
    })()
  )

  const mdhd = fullBox(
    'mdhd',
    0,
    0,
    (() => {
      const b = Buffer.alloc(24)
      b.writeUInt32BE(0, 0)
      b.writeUInt32BE(0, 4)
      b.writeUInt32BE(44100, 8)
      b.writeUInt32BE(44100, 12)
      b.writeUInt16BE(0x55c4, 16) // 'und'
      b.writeUInt16BE(0, 18)
      return b
    })()
  )

  const hdlr = fullBox(
    'hdlr',
    0,
    0,
    (() => {
      const b = Buffer.alloc(24)
      b.writeUInt32BE(0, 0)
      b.write('soun', 4, 'latin1')
      b.write('SoundHandler', 12, 'latin1')
      b[23] = 0
      return b
    })()
  )

  const smhd = fullBox('smhd', 0, 0, Buffer.alloc(4))
  const dref = fullBox(
    'dref',
    0,
    0,
    (() => {
      const b = Buffer.alloc(4)
      b.writeUInt32BE(1, 0)
      return Buffer.concat([b, fullBox('url ', 0, 1)])
    })()
  )
  const dinf = box('dinf', dref)

  const esds = fullBox(
    'esds',
    0,
    0,
    Buffer.concat([
      Buffer.from([0x03, 0x19, 0x00, 0x01, 0x00]),
      Buffer.from([0x04, 0x11, 0x40, 0x15, 0x00, 0x00, 0x00, 0x00, 0x01, 0xf4, 0x00, 0x00, 0x01, 0xf4, 0x00, 0x00, 0x00]),
      Buffer.from([0x05, 0x02, 0x12, 0x10]),
      Buffer.from([0x06, 0x01, 0x02])
    ])
  )
  const mp4a = box(
    'mp4a',
    Buffer.alloc(6),
    Buffer.from([0x00, 0x00]), // reserved
    (() => {
      const b = Buffer.alloc(20)
      b.writeUInt16BE(1, 0)
      b.writeUInt16BE(0, 2)
      b.writeUInt16BE(0, 4)
      b.writeUInt16BE(0, 6)
      b.writeUInt16BE(2, 8)
      b.writeUInt16BE(16, 10)
      b.writeUInt16BE(0, 12)
      b.writeUInt16BE(0, 14)
      b.writeUInt16BE(44100, 16)
      return b
    })(),
    esds
  )
  const stsd = fullBox('stsd', 0, 0, (() => {
    const b = Buffer.alloc(4)
    b.writeUInt32BE(1, 0)
    return Buffer.concat([b, mp4a])
  })())
  const stts = fullBox('stts', 0, 0, (() => {
    const b = Buffer.alloc(8)
    b.writeUInt32BE(1, 0)
    b.writeUInt32BE(44100, 4)
    return b
  })())
  const stsc = fullBox('stsc', 0, 0, (() => {
    const b = Buffer.alloc(12)
    b.writeUInt32BE(1, 0)
    b.writeUInt32BE(1, 4)
    b.writeUInt32BE(1, 8)
    return b
  })())
  const stsz = fullBox('stsz', 0, 0, (() => {
    const b = Buffer.alloc(12)
    b.writeUInt32BE(0, 0)
    b.writeUInt32BE(44100, 4)
    return b
  })())
  const stco = fullBox('stco', 0, 0, (() => {
    const b = Buffer.alloc(8)
    b.writeUInt32BE(1, 0)
    b.writeUInt32BE(0, 4)
    return b
  })())
  const stbl = box('stsd', stsd, stts, stsc, stsz, stco)
  const minf = box('smhd', smhd, dinf, stbl)
  const mdia = box('mdhd', mdhd, hdlr, minf)
  const tkhd = fullBox(
    'tkhd',
    0,
    3,
    (() => {
      const b = Buffer.alloc(84)
      b.writeUInt32BE(0, 0)
      b.writeUInt32BE(0, 4)
      b.writeUInt32BE(1, 8)
      b.writeUInt32BE(0, 12)
      b.writeUInt32BE(44100, 16)
      b.writeUInt32BE(44100, 20)
      b.writeUInt32BE(0, 24)
      b.writeUInt16BE(0, 28)
      b.writeUInt16BE(0, 30)
      b.writeUInt16BE(0, 32)
      b.writeUInt16BE(0, 34)
      const m = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000]
      m.forEach((v, i) => b.writeUInt32BE(v, 36 + i * 4))
      b.writeUInt32BE(44100, 72)
      b.writeUInt32BE(44100, 76)
      b.writeUInt32BE(2, 80)
      return b
    })()
  )
  const trak = box('tkhd', tkhd, box('mdia', mdia))

  // iTunes 元数据
  const ilstItems = []
  // data box: [type indicator(4)][locale(4)][payload]；type=1 表示文本，type=0 表示二进制
  const textData = (value) =>
    box('data', Buffer.from([0, 0, 0, 1, 0, 0, 0, 0]), Buffer.from(value, 'utf8'))
  const binData = (bytes) =>
    box('data', Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]), Buffer.from(bytes))
  for (const [atom, value] of Object.entries(tags)) {
    if (atom.startsWith('----:')) {
      const [, mean, name] = atom.split(':')
      ilstItems.push(
        box(
          '----',
          box('mean', Buffer.from([0, 0, 0, 0]), Buffer.from(mean, 'utf8')),
          box('name', Buffer.from([0, 0, 0, 0]), Buffer.from(name, 'utf8')),
          box('data', Buffer.from([0, 0, 0, 1, 0, 0, 0, 0]), Buffer.from(value, 'utf8'))
        )
      )
    } else if (value instanceof Buffer) ilstItems.push(box(atom, binData(value)))
    else ilstItems.push(box(atom, textData(value)))
  }
  const ilst = box('ilst', ...ilstItems)
  const hdlrMeta = fullBox(
    'hdlr',
    0,
    0,
    (() => {
      const b = Buffer.alloc(24)
      b.writeUInt32BE(0, 0)
      b.write('mdir', 4, 'latin1')
      b.write('appl', 12, 'latin1')
      return b
    })()
  )
  const meta = fullBox('meta', 0, 0, hdlrMeta, ilst)
  const udta = box('udta', meta)
  const moov = box('moov', mvhd, trak, udta)

  return Buffer.concat([ftyp, moov])
}

/* ------------------------------------------------------------- 样本集 --- */

const OUT = join(HERE, 'samples')

function write(name, buf) {
  writeFileSync(join(OUT, name), buf)
  console.log('  +', name, buf.length, 'bytes')
}

mkdirSync(OUT, { recursive: true })
console.log('生成测试样本 ->', OUT)

// 1. 带完整标签的 MP3
write(
  '01 - 米津玄師 - Lemon.mp3',
  Buffer.concat([
    id3v2([
      textFrame('TIT2', 'Lemon'),
      textFrame('TPE1', '米津玄師'),
      textFrame('TPE2', '米津玄師'),
      textFrame('TALB', 'BOOTLEG'),
      textFrame('TCOM', '米津玄師'),
      textFrame('TCON', 'J-Pop'),
      textFrame('TDRC', '2018'),
      textFrame('TRCK', '1/12'),
      textFrame('TPOS', '1/1'),
      textFrame('TCOP', '2018 Sony Music'),
      textFrame('TPUB', 'Sony Music Labels'),
      userTextFrame('UPC', '4548736598321'),
      userTextFrame('ADVISORY', 'explicit'),
      userTextFrame('ITUNESADVISORY', '2'),
      usltFrame('', 'eng', '[00:00.00]Lemon\n[00:10.00]夢堵塞')
    ]),
    makeMp3Audio()
  ])
)

// 2. 无任何标签的 MP3
write('02 - 无标签 - 未知曲目.mp3', makeMp3Audio())

// 3. FLAC + Vorbis Comment
write(
  '03 - YOASOBI - あの夢をなぞって.flac',
  makeFlac([
    'TITLE=あの夢をなぞって',
    'ARTIST=YOASOBI',
    'ALBUM=THE BOOK 2',
    'ALBUMARTIST=YOASOBI',
    'COMPOSER=Ayase',
    'DATE=2021',
    'TRACKNUMBER=1',
    'TRACKTOTAL=12',
    'DISCNUMBER=1',
    'TOTALDISCS=1',
    'COPYRIGHT=2021 Sony Music',
    'LABEL=Sony Music Labels',
    'ORGANIZATION=Sony Music Labels Inc.',
    'UPC=4567890123456',
    'BARCODE=4567890123456',
    'ADVISORY=clean',
    'ITUNESADVISORY=1',
    'LYRICS=[00:00.00]あの夢をなぞって\n[00:12.30]あの夢をなぞって',
    'GENRE=J-Pop'
  ])
)

// 4. GBK 乱码（标题是 UTF-8 被误按 GBK 解读的产物）
const gbkMojibake = Buffer.from('中文乱码测试', 'utf8').toString('binary')
write(
  '04 - 米津玄師 - 乱码.mp3',
  Buffer.concat([
    id3v2([textFrame('TIT2', gbkMojibake), textFrame('TPE1', '米津玄師')]),
    makeMp3Audio()
  ])
)

// 5. 多歌手 + 含斜杠艺名
write(
  '05 - ACDC & 张三 - 非法字符测试.mp3',
  Buffer.concat([
    id3v2([
      textFrame('TIT2', 'Bad<Char>?'),
      textFrame('TPE1', 'AC/DC'),
      textFrame('TPE2', '张三')
    ]),
    makeMp3Audio()
  ])
)

// 6. WAV
write('06 - Various - wave.wav', makeWav())

// 7. M4A
const trknPayload = Buffer.from([0, 0, 0, 5, 0, 12, 0, 0])
const diskPayload = Buffer.from([0, 0, 0, 1, 0, 2, 0, 0])
write(
  '07 - Taylor Swift - Love Story.m4a',
  makeM4a({
    '©nam': 'Love Story',
    '©ART': 'Taylor Swift',
    '©alb': 'Fearless',
    '©wrt': 'Taylor Swift',
    '©day': '2008',
    '©gen': 'Country',
    'cprt': '2008 Big Machine',
    'rtng': Buffer.from([2]),
    trkn: trknPayload,
    disk: diskPayload,
    '----:com.apple.iTunes:LABEL': 'Big Machine'
  })
)

// 8. 损坏文件
writeFileSync(join(OUT, '08 - 损坏文件 - broken.flac'), Buffer.from('this is not a real flac file at all'))

console.log('完成')

/**
 * ID3v2 文本帧的**原始**读取。
 *
 * 为什么需要自己解析：
 * node-taglib-sharp 沿用了 taglib-sharp 的历史行为，会把 TCOM / TEXT / TMCL / TOLY /
 * TOPE / TSOC / TSOP / TSO2 / TPE1~TPE4 这几类帧按 "/" 拆成多值，
 * 于是 "AC/DC" 读出来变成 "AC; DC"。这与 MusicBrainz Picard / MP3tag 的行为不一致，
 * 会直接破坏艺名，也和本项目的「保护名单」相冲突。
 *
 * ID3v2 规范里「多值」是用 NUL 分隔的，按 "/" 拆分并不是规范行为。
 * 因此这里只针对上述几类帧做原始解析，其余帧仍走 taglib。
 */
import fs from 'node:fs'
import iconv from 'iconv-lite'

/** 会被 taglib 按 "/" 拆开的帧类型（读取时我们自己解析）。 */
export const SPLIT_TEXT_FRAMES = new Set([
  'TCOM',
  'TEXT',
  'TMCL',
  'TOLY',
  'TOPE',
  'TSOC',
  'TSOP',
  'TSO2',
  'TPE1',
  'TPE2',
  'TPE3',
  'TPE4'
])

/** 读取文件的一段区间。 */
function readRange(fd: number, start: number, length: number): Buffer {
  const buf = Buffer.alloc(length)
  const read = fs.readSync(fd, buf, 0, length, start)
  return buf.subarray(0, read)
}

/** 解析 syncsafe 整数（ID3v2.4 帧长度）。 */
function syncsafe(b: Buffer, off: number): number {
  if (off + 4 > b.length) return 0
  return (
    ((b[off] & 0x7f) << 21) | ((b[off + 1] & 0x7f) << 14) | ((b[off + 2] & 0x7f) << 7) | (b[off + 3] & 0x7f)
  )
}

/** 去同步（unsynchronisation）：把 0xFF 0x00 还原为 0xFF。 */
function deunsynchronise(buf: Buffer): Buffer {
  const out = Buffer.alloc(buf.length)
  let o = 0
  for (let i = 0; i < buf.length; i++) {
    out[o++] = buf[i]
    if (buf[i] === 0xff && i + 1 < buf.length && buf[i + 1] === 0x00) i++
  }
  return out.subarray(0, o)
}

/** 按 ID3 文本编码字节解码负载。 */
function decodeTextPayload(payload: Buffer): string[] {
  if (!payload.length) return []
  const enc = payload[0]
  const body = payload.subarray(1)
  let text: string
  switch (enc) {
    case 0:
      text = body.toString('latin1')
      break
    case 1:
      // UTF-16 带 BOM
      text = iconv.decode(body, 'utf16')
      break
    case 2:
      text = iconv.decode(body, 'utf16-be')
      break
    case 3:
      text = body.toString('utf8')
      break
    default:
      text = body.toString('latin1')
  }
  // ID3v2 的多值用 NUL 分隔
  return text
    .split('\u0000')
    .map((s) => s.replace(/[\u0000\s]+$/, ''))
    .filter((s) => s.length > 0)
}

/**
 * 读取文件的 ID3v2 原始文本帧。
 * @returns 帧 ID -> 值列表（不会按 "/" 拆分）
 */
export function readId3v2TextFrames(filePath: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  let fd: number | null = null
  try {
    fd = fs.openSync(filePath, 'r')
    const head = readRange(fd, 0, 10)
    if (head.length < 10 || head.subarray(0, 3).toString('latin1') !== 'ID3') return out
    const version = head[3]
    const flags = head[5]
    const size = syncsafe(head, 6)
    if (size <= 0) return out

    let region = readRange(fd, 10, size)
    if (region.length < size) return out
    if (flags & 0x80) region = deunsynchronise(region)

    let offset = 0
    // 扩展头
    if (flags & 0x40) {
      if (region.length < 4) return out
      offset = version >= 4 ? syncsafe(region, 0) + 4 : region.readUInt32BE(0)
    }

    const idLen = version === 2 ? 3 : 4
    const headerLen = version === 2 ? 6 : 10

    while (offset + headerLen <= region.length) {
      const id = region.subarray(offset, offset + idLen).toString('latin1')
      if (!/^[A-Z0-9]+$/.test(id)) break // 填充区，结束

      let frameSize = 0
      let flags1 = 0
      let flags2 = 0
      if (version === 2) {
        frameSize = (region[offset + 3] << 16) | (region[offset + 4] << 8) | region[offset + 5]
      } else if (version === 4) {
        frameSize = syncsafe(region, offset + 4)
        flags1 = region[offset + 8]
        flags2 = region[offset + 9]
      } else {
        frameSize = region.readUInt32BE(offset + 4)
        flags1 = region[offset + 8]
        flags2 = region[offset + 9]
      }

      const payloadStart = offset + headerLen
      if (frameSize < 0 || payloadStart + frameSize > region.length) break
      let payload = region.subarray(payloadStart, payloadStart + frameSize)
      offset = payloadStart + frameSize

      // 压缩 / 加密的帧无法直接解码，跳过
      if (version === 3) {
        if (flags1 & 0x80) continue // 压缩
        if (flags1 & 0x40) continue // 加密
        if (flags1 & 0x20) payload = payload.subarray(1) // 分组标识
      } else if (version === 4) {
        if (flags1 & 0x08) continue // 压缩
        if (flags1 & 0x04) continue // 加密
        if (flags1 & 0x02) payload = deunsynchronise(payload)
        if (flags1 & 0x40) payload = payload.subarray(1) // 分组标识
        if (flags2 & 0x01) payload = payload.subarray(4) // 数据长度指示符
      }

      if (!SPLIT_TEXT_FRAMES.has(id)) continue
      const values = decodeTextPayload(payload)
      if (values.length) out.set(id, values)
    }
    return out
  } catch {
    return out
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        /* ignore */
      }
    }
  }
}

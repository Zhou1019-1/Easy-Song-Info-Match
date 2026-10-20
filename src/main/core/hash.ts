/**
 * 音频数据区哈希（只覆盖音频帧，不含标签区）。
 *
 * 目的：证明「只改元数据不动音频流」——写标签前后音频数据区哈希必须一致。
 * 各容器的标签位置：
 *   - MP3：ID3v2 在文件头（10 + syncsafe size 字节），ID3v1 在文件尾 128 字节，APEv2 在尾部
 *   - FLAC：若干 metadata block 在文件头（最后一个 block 的 last-flag 置位）
 *   - MP4/M4A：moov/udta/meta 里的 ilst 元数据，音频在 mdat
 *   - 其它：整体哈希
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import type { TagFormat } from './fieldMap'

/** 读文件头部。 */
function readHead(fd: number, len: number): Buffer {
  const buf = Buffer.alloc(len)
  const read = fs.readSync(fd, buf, 0, len, 0)
  return buf.subarray(0, read)
}

/** 读文件尾部。 */
function readTail(fd: number, len: number, size: number): Buffer {
  const buf = Buffer.alloc(len)
  const start = Math.max(0, size - len)
  const read = fs.readSync(fd, buf, 0, len, start)
  return buf.subarray(0, read)
}

/** 解析 ID3v2 头长度（syncsafe 整数）。 */
export function id3v2Size(head: Buffer): number {
  if (head.length < 10) return 0
  if (head.subarray(0, 3).toString('latin1') !== 'ID3') return 0
  const size =
    ((head[6] & 0x7f) << 21) |
    ((head[7] & 0x7f) << 14) |
    ((head[8] & 0x7f) << 7) |
    (head[9] & 0x7f)
  const footer = head[5] & 0x10 ? 10 : 0
  return 10 + size + footer
}

/** 解析 FLAC 头部 metadata block 总长度。 */
export function flacMetadataSize(head: Buffer): number {
  if (head.length < 4 || head.subarray(0, 4).toString('latin1') !== 'fLaC') return 0
  let offset = 4
  for (;;) {
    if (offset + 4 > head.length) break
    const flag = head[offset]
    const size =
      (head[offset + 1] << 16) | (head[offset + 2] << 8) | head[offset + 3]
    offset += 4 + size
    if (flag & 0x80) break
  }
  return offset
}

/** 解析 MP4 中 mdat 盒的负载区间（找不到则返回 null）。 */
export function findMdatRange(buf: Buffer): { start: number; end: number } | null {
  let offset = 0
  while (offset + 8 <= buf.length) {
    let size = buf.readUInt32BE(offset)
    const type = buf.subarray(offset + 4, offset + 8).toString('latin1')
    let headerSize = 8
    if (size === 1) {
      if (offset + 16 > buf.length) break
      const big = buf.readBigUInt64BE(offset + 8)
      size = Number(big)
      headerSize = 16
    } else if (size === 0) {
      size = buf.length - offset
    }
    if (size < headerSize) break
    if (type === 'mdat') {
      const end = Math.min(offset + size, buf.length)
      return { start: offset + headerSize, end }
    }
    offset += size
  }
  return null
}

/** 计算一段区间的 sha256。 */
function hashRange(fd: number, start: number, end: number): string {
  const h = crypto.createHash('sha256')
  const CHUNK = 1 << 20
  const buf = Buffer.alloc(CHUNK)
  let pos = start
  while (pos < end) {
    const want = Math.min(CHUNK, end - pos)
    const read = fs.readSync(fd, buf, 0, want, pos)
    if (read <= 0) break
    h.update(buf.subarray(0, read))
    pos += read
  }
  return h.digest('hex')
}

/**
 * 计算音频数据区哈希。
 * @param filePath 文件路径
 * @param format  标签容器格式
 */
export function computeAudioHash(filePath: string, format: TagFormat): string {
  let fd: number | null = null
  try {
    fd = fs.openSync(filePath, 'r')
    const size = fs.fstatSync(fd).size
    if (size === 0) return crypto.createHash('sha256').update('').digest('hex')

    let start = 0
    let end = size

    if (format === 'id3v2' || format === 'id3v1') {
      const head = readHead(fd, 10)
      start = id3v2Size(head)
      // ID3v1 尾部 128 字节
      const tail = readTail(fd, 128, size)
      if (tail.length === 128 && tail.subarray(0, 3).toString('latin1') === 'TAG') {
        end = size - 128
      }
      // APEv2 尾部标签
      const apeTail = readTail(fd, 32, size)
      if (apeTail.length === 32 && apeTail.subarray(0, 8).toString('latin1') === 'APETAGEX') {
        const apeSize = apeTail.readUInt32LE(12)
        const apeStart = Math.max(0, size - apeSize)
        end = Math.min(end, apeStart)
      }
    } else if (format === 'vorbis' || format === 'ape') {
      const head = readHead(fd, 1 << 20)
      if (format === 'vorbis') {
        start = flacMetadataSize(head)
      } else {
        // APE 标签在文件尾
        const tail = readTail(fd, 32, size)
        if (tail.length === 32 && tail.subarray(0, 8).toString('latin1') === 'APETAGEX') {
          const apeSize = tail.readUInt32LE(12)
          end = Math.max(0, size - apeSize)
        }
      }
    } else if (format === 'mp4') {
      const head = readHead(fd, 1 << 22)
      const range = findMdatRange(head)
      if (range) return hashRange(fd, range.start, range.end)
    }

    if (end <= start) {
      // 没有可识别的音频区，退化为整体哈希
      return hashRange(fd, 0, size)
    }
    return hashRange(fd, start, end)
  } catch {
    return ''
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

/** 整个文件的哈希（用于备份校验）。 */
export function computeFileHash(filePath: string): string {
  try {
    const h = crypto.createHash('sha256')
    h.update(fs.readFileSync(filePath))
    return h.digest('hex')
  } catch {
    return ''
  }
}

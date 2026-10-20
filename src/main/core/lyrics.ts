/**
 * 歌词处理：文本解析、覆盖率、LRC 生成、时间轴偏移。
 *
 * 三种落地方式由上层决定：内嵌（embedded）/ 同名 .lrc / 两者都要。
 * 已有歌词默认不动（由上层根据 lyricState 判断）。
 */

/** LRC 单行时间标签，如 `[01:23.45]`。 */
const LRC_TIME = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g

/** 解析 LRC，返回带时间轴的行与总行数。 */
export function parseLrc(text: string): { timed: boolean; lines: Array<{ time: number; text: string }> } {
  const lines: Array<{ time: number; text: string }> = []
  let sawTag = false
  for (const raw of text.split(/\r?\n/)) {
    LRC_TIME.lastIndex = 0
    const stamps: number[] = []
    let m: RegExpExecArray | null
    let rest = raw
    while ((m = LRC_TIME.exec(raw)) !== null) {
      sawTag = true
      const min = Number(m[1])
      const sec = Number(m[2])
      const fracRaw = m[3] ?? '0'
      const frac = Number(fracRaw.padEnd(3, '0').slice(0, 3))
      stamps.push(min * 60 + sec + frac / 1000)
    }
    rest = raw.replace(LRC_TIME, '').trim()
    for (const t of stamps) lines.push({ time: t, text: rest })
  }
  lines.sort((a, b) => a.time - b.time)
  return { timed: sawTag, lines }
}

/** LRC 元信息行（如 [ti:] [ar:] [by:] [offset:]），不是歌词正文。 */
function isMetaLine(raw: string): boolean {
  return /^\[[a-z]+:.*\]$/i.test(raw.trim())
}

/** 纯文本歌词的行数（去掉空行）。 */
export function countLyricLines(text: string): number {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0).length
}

/**
 * 时间轴覆盖率：有时间轴的歌词行占比（0~1）。
 * 纯文本歌词没有时间轴，覆盖率按「有歌词」记为 0，并在 UI 上提示需手工对齐。
 * 元信息行（[ti:] 等）不计入分母。
 */
export function lrcCoverage(text: string): number {
  const parsed = parseLrc(text)
  if (!parsed.timed) return 0
  const all = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !isMetaLine(l)).length
  if (!all) return 0
  return Math.min(1, parsed.lines.length / all)
}

/** 给 LRC 的时间标签统一加偏移（毫秒，可为负）。 */
export function applyLrcOffset(text: string, offsetMs: number): string {
  if (!offsetMs) return text
  const parsed = parseLrc(text)
  if (!parsed.timed) return text
  const out: string[] = []
  // 保留原始的元信息行（[ti:] [ar:] [by:] 等）
  for (const raw of text.split(/\r?\n/)) {
    if (/^\[[a-z]+:.*\]$/i.test(raw.trim())) {
      out.push(raw)
    }
  }
  for (const l of parsed.lines) {
    const t = Math.max(0, l.time + offsetMs / 1000)
    out.push(`[${formatLrcTime(t)}]${l.text}`)
  }
  return out.join('\n')
}

/** 秒 -> LRC 时间标签文本。 */
export function formatLrcTime(seconds: number): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000))
  const min = Math.floor(totalMs / 60000)
  const sec = Math.floor((totalMs % 60000) / 1000)
  const ms = totalMs % 1000
  return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(ms).padStart(3, '0')}`
}

/** 把纯文本歌词转成 LRC（无时间轴时逐行 0 起点占位，仅供预览，不写盘）。 */
export function plainTextToLrc(text: string): string {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => `[00:00.00]${l}`)
    .join('\n')
}

/** 去掉歌词里的元信息行，得到纯正文（用于标题相似度校验）。 */
export function lyricBody(text: string): string {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(LRC_TIME, '').trim())
    .filter((l) => l.length > 0 && !/^\[[a-z]+:.*\]$/i.test(l))
    .join('\n')
}

/** 生成同名的 .lrc 文件路径。 */
export function lrcPathFor(audioPath: string): string {
  const dot = audioPath.lastIndexOf('.')
  const sep = Math.max(audioPath.lastIndexOf('/'), audioPath.lastIndexOf('\\'))
  const hasExt = dot > sep && dot > 0
  const base = hasExt ? audioPath.slice(0, dot) : audioPath
  return `${base}.lrc`
}

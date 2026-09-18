import type { MappedLine } from './anchor'
import type { Cue } from './srt'
import { formatTime } from './time'

/**
 * 双语字幕合并：
 * 在主 SRT 完成校准（得到校准后起止时间）后，把第二份（次轨）SRT 与主轨做
 * “保持顺序的一对一匹配”，用于导出“主文本 + 次文本逐行追加”的双语 SRT。
 *
 * 合法候选（一对主/次字幕）必须同时满足：
 * - 双方时间区间存在“正重叠”（overlap > 0）；
 * - 重叠时长不少于“较短字幕时长”的 50%（含恰好 50%）；
 * - 双方时长均为正（校准后时长非正的主轨条目不参与）。
 *
 * 在全部合法匹配（主、次条目均按文件内顺序递增的一一对应）中，依次按下列
 * 优先级择优：
 * 1. 最大化“总重叠毫秒数”；
 * 2. 再最小化“起始时间差绝对值之和”；
 * 3. 仍并列时，选择“次轨序号序列”字典序更早的方案。
 *
 * 主轨一律使用校准后的 newStart/newEnd；次轨使用其文件内时间。
 * 与 DOM 无关，可在 Node 中直接断言检查。
 */

const EPS = 1e-6
/** 空序列的“虚拟首元素”，使其在字典序比较中排在所有非空序列之后。 */
const SEQ_END = 2147483647

/** 一对已匹配：主轨 MappedLine.index -> 次轨 Cue.index。 */
export interface MergePair {
  mainIndex: number
  secondaryIndex: number
  /** 该对的重叠毫秒数（正）。 */
  overlapMs: number
  /** 该对主/次起始时间差的绝对值（毫秒）。 */
  startDeltaMs: number
}

export interface MergeResult {
  /** 按主轨顺序排列的匹配对（次轨序号同步严格递增）。 */
  pairs: MergePair[]
  /** 未匹配主轨条目的 MappedLine.index（按文件顺序）。 */
  unmatchedMain: number[]
  /** 未匹配次轨条目的 Cue.index（按文件顺序）。 */
  unmatchedSecondary: number[]
  /** 最优方案的总重叠毫秒数。 */
  totalOverlapMs: number
  /** 最优方案的起始时间差绝对值总和（毫秒）。 */
  totalStartDeltaMs: number
}

interface LegalPair {
  overlapMs: number
  startDeltaMs: number
}

/**
 * 判定一条主轨（校准后）与一条次轨是否构成合法候选；合法时附带重叠与起始差。
 */
export function legalPair(
  main: Pick<MappedLine, 'newStart' | 'newEnd'>,
  secondary: Pick<Cue, 'start' | 'end'>,
): LegalPair | null {
  const mainDur = main.newEnd - main.newStart
  const secDur = secondary.end - secondary.start
  if (!(mainDur > 0) || !(secDur > 0)) return null

  const overlap =
    Math.min(main.newEnd, secondary.end) - Math.max(main.newStart, secondary.start)
  if (!(overlap > EPS)) return null

  const shorter = Math.min(mainDur, secDur)
  // “不少于较短字幕的 50%”：恰好 50% 也合法
  if (overlap + EPS < shorter * 0.5) return null

  return {
    overlapMs: overlap,
    startDeltaMs: Math.abs(main.newStart - secondary.start),
  }
}

/**
 * 顺序保持一对一匹配的动态规划（后缀表）。
 *
 * W[i][j] / D[i][j]：主轨后缀 i..、次轨后缀 j.. 能取得的最大总重叠与对应最小
 * 起始差总和。每个状态有至多三个转移：
 * - 匹配 (i,j)（仅当合法）：得分 (overlap, delta) + W[i+1][j+1]；
 * - 跳过主轨 i：W[i+1][j]；
 * - 跳过次轨 j：W[i][j+1]。
 *
 * 平局裁决需要比较“次轨序号序列”的字典序：匹配转移生成的序列为 [j, ...tail]，
 * 跳过转移直接引用后继状态的同一序列（共享 cons 链）。序列比较逐节点比较首个
 * 次轨序号、再比较尾部，空序列排在所有非空序列之后。
 */
export function mergeSubtitles(mainLines: MappedLine[], secondary: Cue[]): MergeResult {
  const m = mainLines.length
  const n = secondary.length
  const width = n + 1
  const idx = (i: number, j: number) => i * width + j

  const bestOverlap = new Float64Array((m + 1) * (n + 1))
  const bestDelta = new Float64Array((m + 1) * (n + 1))
  /** 每个状态选中的次轨序号序列（cons id；0 = 空序列）。 */
  const seqAt = new Int32Array((m + 1) * (n + 1))

  // cons 表：下标 0 保留给空序列（head 取 SEQ_END）。只在“匹配转移”真正成为
  // 某状态最优选择时才新增节点，用按需扩容的 Int32Array 存储，避免装箱开销。
  const cons = {
    cap: 16,
    main: new Int32Array(16),
    sec: new Int32Array(16),
    tail: new Int32Array(16),
    len: 1,
  }
  cons.sec[0] = SEQ_END
  const makeCons = (i: number, j: number, tail: number): number => {
    if (cons.len === cons.cap) {
      cons.cap *= 2
      const grow = (old: Int32Array) => {
        const next = new Int32Array(cons.cap)
        next.set(old)
        return next
      }
      cons.main = grow(cons.main)
      cons.sec = grow(cons.sec)
      cons.tail = grow(cons.tail)
    }
    const id = cons.len++
    cons.main[id] = i
    cons.sec[id] = j
    cons.tail[id] = tail
    return id
  }

  /** 字典序比较两条已存在的次轨序号序列：首个次轨序号更小者为“更早”。 */
  const compareSeq = (a: number, b: number): -1 | 0 | 1 => {
    let x = a
    let y = b
    while (x !== y) {
      const hx = cons.sec[x]
      const hy = cons.sec[y]
      if (hx !== hy) return hx < hy ? -1 : 1
      x = cons.tail[x]
      y = cons.tail[y]
    }
    return 0
  }

  /**
   * 比较“虚拟序列 [head, ...tailNode]”（不必先创建节点）与已存在序列 b。
   * 平局裁决时用它判断匹配转移是否更优，只有胜出时才真正分配 cons 节点。
   */
  const compareVirtual = (head: number, tailNode: number, b: number): -1 | 0 | 1 => {
    let h: number = head
    let x: number = tailNode
    let y: number = b
    for (;;) {
      const hy = cons.sec[y]
      if (h !== hy) return h < hy ? -1 : 1
      x = x === 0 ? 0 : cons.tail[x]
      y = cons.tail[y]
      if (x === y) return 0
      h = cons.sec[x]
    }
  }

  /**
   * 三级择优（依次）：总重叠更大 → 总重叠相同则起始差总和更小 → 仍相同则
   * 次轨序号序列字典序更早。seqCmp 为候选序列相对当前最优序列的比较结果
   * （<0 表示候选更早）；仅在两级分数都持平时才需要提供。
   */
  const prefer = (
    w: number,
    d: number,
    bw: number,
    bd: number,
    seqCmp: -1 | 0 | 1,
  ): boolean => {
    if (w > bw + EPS) return true
    if (Math.abs(w - bw) > EPS) return false
    if (d < bd - EPS) return true
    if (d > bd + EPS) return false
    return seqCmp < 0
  }

  // 逆序填表：依赖 (i+1,j)、(i,j+1)、(i+1,j+1)
  for (let i = m; i >= 0; i--) {
    for (let j = n; j >= 0; j--) {
      if (i === m || j === n) continue // 边界状态：无条目可配，(0, 0) + 空序列

      const k = idx(i, j)
      // 初始最优：跳过主轨 i
      let bw = bestOverlap[idx(i + 1, j)]
      let bd = bestDelta[idx(i + 1, j)]
      let bseq = seqAt[idx(i + 1, j)]

      // 候选 1：跳过次轨 j
      const wSkip = bestOverlap[idx(i, j + 1)]
      const dSkip = bestDelta[idx(i, j + 1)]
      const seqSkip = seqAt[idx(i, j + 1)]
      if (prefer(wSkip, dSkip, bw, bd, compareSeq(seqSkip, bseq))) {
        bw = wSkip
        bd = dSkip
        bseq = seqSkip
      }

      // 候选 2：匹配 (i,j)（仅当合法）；虚拟序列 [j, ...tailDiag]
      const legal = legalPair(mainLines[i], secondary[j])
      if (legal) {
        const wMatch = legal.overlapMs + bestOverlap[idx(i + 1, j + 1)]
        const dMatch = legal.startDeltaMs + bestDelta[idx(i + 1, j + 1)]
        const tailDiag = seqAt[idx(i + 1, j + 1)]
        if (prefer(wMatch, dMatch, bw, bd, compareVirtual(j, tailDiag, bseq))) {
          bw = wMatch
          bd = dMatch
          bseq = makeCons(i, j, tailDiag)
        }
      }

      bestOverlap[k] = bw
      bestDelta[k] = bd
      seqAt[k] = bseq
    }
  }

  // 沿 cons 链还原匹配对：i、j 均严格递增，天然按主轨顺序排列
  const pairs: MergePair[] = []
  const matchedMain = new Set<number>()
  const matchedSecondary = new Set<number>()
  let node = seqAt[idx(0, 0)]
  while (node !== 0) {
    const i = cons.main[node]
    const j = cons.sec[node]
    const legal = legalPair(mainLines[i], secondary[j])!
    pairs.push({
      mainIndex: i,
      secondaryIndex: j,
      overlapMs: legal.overlapMs,
      startDeltaMs: legal.startDeltaMs,
    })
    matchedMain.add(i)
    matchedSecondary.add(j)
    node = cons.tail[node]
  }

  const unmatchedMain: number[] = []
  const unmatchedSecondary: number[] = []
  for (let i = 0; i < m; i++) {
    if (!matchedMain.has(i)) unmatchedMain.push(i)
  }
  for (let j = 0; j < n; j++) {
    if (!matchedSecondary.has(j)) unmatchedSecondary.push(j)
  }

  return {
    pairs,
    unmatchedMain,
    unmatchedSecondary,
    totalOverlapMs: bestOverlap[idx(0, 0)],
    totalStartDeltaMs: bestDelta[idx(0, 0)],
  }
}

/**
 * 生成双语合并 SRT：
 * - 沿用主轨校准后的时间码、序号与主文本；
 * - 已匹配主轨：在主文本下一行追加次轨文本（次轨文本原样保留，含多行）；
 * - 未匹配主轨：照常导出（仅主文本）；
 * - 未匹配次轨不写入（仅由界面提示）。
 */
export function buildMergedSrt(
  mainLines: MappedLine[],
  secondary: Cue[],
  result: MergeResult,
): string {
  const secondaryByIndex = new Map(secondary.map((cue) => [cue.index, cue]))
  const secondaryByMain = new Map<number, Cue>()
  for (const pair of result.pairs) {
    const cue = secondaryByIndex.get(pair.secondaryIndex)
    if (cue) secondaryByMain.set(pair.mainIndex, cue)
  }

  const ordered = [...mainLines].sort((a, b) => a.index - b.index)
  return (
    ordered
      .map((line) => {
        const sec = secondaryByMain.get(line.index)
        const text = sec ? `${line.text}\n${sec.text}` : line.text
        return `${line.id}\n${formatTime(line.newStart)} --> ${formatTime(line.newEnd)}\n${text}`
      })
      .join('\n\n') + '\n'
  )
}

import { parseTime, formatTime } from '../src/lib/time'
import { parseSrt, buildSrt, type Cue } from '../src/lib/srt'
import { buildAnchors, mapTimestamp, mapCues, validateMapped, type MappedLine } from '../src/lib/anchor'
import { activeLines, effectiveRange, seekTargetSec } from '../src/lib/sync'
import {
  normalizeText,
  parsePlan,
  previewPlan,
  serializePlan,
  type AnchorPlan,
} from '../src/lib/plan'
import { buildMergedSrt, legalPair, mergeSubtitles } from '../src/lib/merge'
import { SAMPLE_SRT, SAMPLE_SECONDARY_SRT } from '../src/sample'

let failures = 0
const assert = (cond: boolean, msg: string) => {
  if (cond) {
    console.log('  ✓', msg)
  } else {
    failures++
    console.error('  ✗ FAIL:', msg)
  }
}

// ---- time ----
console.log('time 解析/格式化')
assert(parseTime('00:00:01,500') === 1500, '1.5s 解析')
assert(parseTime('01:02:03.04') === 3723040, '点号分隔 1:02:03.04')
assert(parseTime('bad') === null, '非法时间返回 null')
assert(formatTime(3723040) === '01:02:03,040', '格式化')
assert(formatTime(-1500) === '-00:00:01,500', '负时间格式化带 -')
assert(parseTime(formatTime(123456789)) === 123456789, '往返一致')

// ---- map ----
console.log('无锚点：恒等')
assert(mapTimestamp(5000, []) === 5000, '保留原值')

console.log('单锚点：整体平移')
assert(mapTimestamp(1000, [{ source: 5000, target: 7000 }]) === 3000, '之前 +2000')
assert(mapTimestamp(9000, [{ source: 5000, target: 3000 }]) === 7000, '之后 -2000')

console.log('多锚点：分段线性 + 外推')
const a = [
  { source: 1000, target: 2000 },
  { source: 3000, target: 5000 },
  { source: 6000, target: 6000 },
]
assert(mapTimestamp(1000, a) === 2000, '锚点本身')
assert(mapTimestamp(2000, a) === 3500, '中点插值 (1k-3k 段斜率 1.5)')
assert(Math.abs(mapTimestamp(5000, a) - (5000 + 2000 / 3)) < 1e-9, '3k-6k 段插值 (斜率 1/3) ≈ 5666.67')
// 头部外推：斜率 1.5，t=0 => 2000 + (0-1000)*1.5 = 500
assert(mapTimestamp(0, a) === 500, '头部斜率外推')
// 尾部外推：斜率 1/3，t=9000 => 6000 + 3000/3 = 7000
assert(mapTimestamp(9000, a) === 7000, '尾部斜率外推')

console.log('锚点严格递增校验')
assert(buildAnchors([[1, 2]]) !== null, '单个锚点合法')
assert(buildAnchors([[1, 5], [2, 6]]) !== null, '双递增合法（乱序输入自动排序）')
assert(buildAnchors([[1, 5], [1, 6]]) === null, 'source 重复非法')
assert(buildAnchors([[1, 5], [2, 5]]) === null, 'target 相等非法')
assert(buildAnchors([[1, 5], [2, 4]]) === null, 'target 递减非法')
assert(buildAnchors([[2, 6], [1, 5]]) !== null, '乱序输入自动排序后合法')

// ---- SRT 解析 ----
console.log('SRT 解析')
const { cues, skipped } = parseSrt(SAMPLE_SRT)
assert(cues.length === 7, `示例解析出 7 条（实际 ${cues.length}）`)
assert(skipped === 0, '无跳过块')
assert(cues[0].id === '1' && cues[0].start === 1000 && cues[0].end === 4000, '第一条字段正确')
assert(cues[0].text.startsWith('欢迎使用'), '文本正确')

const crlf = parseSrt('1\r\n00:00:01,000 --> 00:00:02,000\r\nhi\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nbye')
assert(crlf.cues.length === 2, 'CRLF 解析')
assert(parseSrt(SAMPLE_SECONDARY_SRT).cues.length === 7, '示例次轨解析出 7 条')
const dot = parseSrt('1\n00:00:01.500 --> 00:00:02.000\nx')
assert(dot.cues.length === 1 && dot.cues[0].start === 1500, '点号毫秒解析')
const bad = parseSrt('1\nnot a timing\nx\n\n2\n00:00:01,000 --> 00:00:02,000\ny')
assert(bad.cues.length === 1 && bad.skipped === 1, '非法块跳过并计数')
const bom = parseSrt('﻿1\n00:00:01,000 --> 00:00:02,000\nx')
assert(bom.cues.length === 1 && bom.cues[0].id === '1', 'UTF-8 BOM 被正确去除')

// ---- 导出：序号与文本不变 ----
console.log('SRT 导出')
const mapped = mapCues(cues, [])
const out = buildSrt(mapped)
const reparsed = parseSrt(out)
assert(reparsed.cues.length === 7, '导出后仍 7 条')
assert(
  reparsed.cues.every((c, i) => c.id === cues[i].id && c.text === cues[i].text),
  '序号与文本不变',
)
assert(
  reparsed.cues.every((c, i) => c.start === cues[i].start && c.end === cues[i].end),
  '无锚点导出时间不变',
)
assert(out.includes('00:00:01,000 --> 00:00:04,000'), '时间码格式正确')

// ---- 校验 ----
console.log('错误检测')
const noIssue = validateMapped([
  { index: 0, id: '1', start: 0, end: 1000, text: '', newStart: 1000, newEnd: 2000 },
  { index: 1, id: '2', start: 0, end: 1000, text: '', newStart: 2000, newEnd: 3000 },
])
assert(noIssue.size === 0, '正常时间线无错误')

const neg = validateMapped([
  { index: 0, id: '1', start: 0, end: 1000, text: '', newStart: -500, newEnd: 500 },
])
assert(neg.get(0)?.some((i) => i.kind === 'negative'), '负时间标红')

const nonpos = validateMapped([
  { index: 0, id: '1', start: 0, end: 1000, text: '', newStart: 2000, newEnd: 2000 },
])
assert(nonpos.get(0)?.some((i) => i.kind === 'nonpositive'), '零时长标红')

const overlap = validateMapped([
  { index: 0, id: '1', start: 0, end: 1000, text: '', newStart: 1000, newEnd: 3000 },
  { index: 1, id: '2', start: 0, end: 1000, text: '', newStart: 2000, newEnd: 4000 },
])
assert(
  overlap.get(1)?.some((i) => i.kind === 'overlap' && i.withId === '1'),
  '重叠标红并指向前一条 #1',
)

// ---- 端到端：示例 + 双锚点 ----
console.log('端到端')
const e2e = mapCues(cues, [
  { source: cues[0].start, target: 3000 },
  { source: cues[6].start, target: 60000 },
])
const e2eIssues = validateMapped(e2e)
assert(e2e[0].newStart === 3000, '第一条映射到目标 3s')
assert(e2e[6].newStart === 60000, '最后一条映射到目标 60s')
assert(e2e.every((l) => l.newStart >= 0 && l.newEnd > l.newStart), '外推后无非负/非正问题')

// ---- 视频同步预览：当前字幕计算 ----
console.log('视频同步：当前字幕')
const mkLine = (index: number, newStart: number, newEnd: number): MappedLine => ({
  index,
  id: String(index + 1),
  start: 0,
  end: 0,
  text: '',
  newStart,
  newEnd,
})
const ids = (list: MappedLine[]) => list.map((l) => l.id).join(',')

// 以校准后起止时间为准，区间左闭右开
const ov = [mkLine(0, 1000, 5000), mkLine(1, 3000, 7000)]
assert(ids(activeLines(ov, 999)) === '', '起始前无字幕')
assert(ids(activeLines(ov, 1000)) === '1', '起始时刻包含（左闭）')
assert(ids(activeLines(ov, 5000)) === '2', '结束时刻不包含（右开）')
assert(ids(activeLines(ov, 4000)) === '1,2', '时间重叠时按字幕顺序同时展示')
assert(ids(activeLines(ov, 6000)) === '2', '重叠区之后仅剩后一条')
assert(ids(activeLines(ov, 8000)) === '', '全部结束后无字幕')

// 负时间字幕不提前显示：起始钳到 0，结束时间不变
assert(effectiveRange(mkLine(0, -500, 1500)).join(',') === '0,1500', '负起始时间钳到 0')
const negStart = [mkLine(0, -500, 1500)]
assert(ids(activeLines(negStart, 0)) === '1', '负起始字幕从 t=0 起显示')
assert(ids(activeLines(negStart, 1499)) === '1' && ids(activeLines(negStart, 1500)) === '', '负起始字幕仍按原结束时间消失')
const allNeg = [mkLine(0, -2000, -1000)]
assert(ids(activeLines(allNeg, 0)) === '' && ids(activeLines(allNeg, 60000)) === '', '整体为负的字幕任何时刻都不显示')
const nonPos = [mkLine(0, 2000, 2000)]
assert(ids(activeLines(nonPos, 2000)) === '', '时长非正的字幕不显示')

// 锚点编辑（映射变化）后，同一播放时刻的命中集合立即变化
const identityLines = mapCues(cues, [])
assert(ids(activeLines(identityLines, 2000)) === '1', '校准前 t=2s 命中第 1 条')
const shiftedLines = mapCues(cues, [{ source: cues[0].start, target: cues[0].start + 10000 }])
assert(ids(activeLines(shiftedLines, 2000)) === '', '整体后移 10s 后 t=2s 不再命中')
assert(ids(activeLines(shiftedLines, 12000)) === '1', '整体后移 10s 后 t=12s 命中第 1 条')

// ---- 视频同步预览：点击跳转目标 ----
console.log('视频同步：点击跳转')
assert(seekTargetSec(3000, 10) === 3, '跳转目标为校准后起始时间（秒）')
assert(seekTargetSec(-1500, 10) === 0, '负起始时间钳到 0')
assert(seekTargetSec(20000, 10) === 10, '超出视频时长停在末尾')
assert(seekTargetSec(9500, 10) === 9.5, '时长之内不钳制')
assert(seekTargetSec(3000, NaN) === 3, '时长未知（元数据未加载）时不钳制')

// ---- 锚点方案：规范化 ----
console.log('文本规范化')
assert(normalizeText('  hello   world  ') === 'hello world', '去首尾空白并合并连续空白')
assert(normalizeText('a\r\n\t b') === 'a b', '换行/制表符合并为单空格')
assert(normalizeText('\n\n  \t') === '', '纯空白规范化为空串')

// ---- 锚点方案：序列化 + 往返 ----
console.log('方案导出/解析')
const planAnchors = [
  { source: cues[0].start, target: 3000 },
  { source: cues[3].start, target: 20000 },
  { source: cues[6].start, target: 60000 },
]
const planJson = serializePlan(cues, planAnchors)
assert(planJson !== null, 'serializePlan 返回 JSON')
const parsedPlan = parsePlan(planJson ?? '')
assert('plan' in parsedPlan && parsedPlan.plan.version === 1, '解析后版本号为 1')
assert('plan' in parsedPlan && parsedPlan.plan.anchors.length === 3, '解析出 3 个锚点')
assert(
  'plan' in parsedPlan &&
    parsedPlan.plan.anchors[0].text === normalizeText(cues[0].text) &&
    parsedPlan.plan.anchors[0].source === '00:00:01,000' &&
    parsedPlan.plan.anchors[0].target === '00:00:03,000',
  '首项时间与规范化文本正确',
)
assert(planJson?.split('\n').join('').includes('"version": 1'), 'JSON 带版本号')

const mkCue = (index: number, start: number, text: string): Cue => ({
  index,
  id: String(index + 1),
  start,
  end: start + 1000,
  text,
})
const t1 = '第一句'
const t2 = '第二句'
const t3 = '第三句'
const t4 = '第四句'
const mkPlan = (anchors: Array<[string, string, string]>): AnchorPlan => ({
  version: 1,
  anchors: anchors.map(([source, target, text]) => ({ source, target, text })),
})

// ---- 方案预览：全部直接匹配 ----
console.log('方案预览')
const plan1 = mkPlan([
  ['00:00:01,000', '00:00:03,000', t1],
  ['00:00:05,000', '00:00:08,000', t2],
])
const cur1 = [mkCue(0, 1000, t1), mkCue(1, 5000, t2)]
const pv1 = previewPlan(plan1, cur1)
assert(pv1.validCount === 2 && pv1.conflictCount === 0, '原始时间+文本相同 → 全部直接匹配')
assert(pv1.entries.every((e) => e.status === 'direct'), '状态均为 direct')
assert(pv1.anchors?.length === 2 && pv1.anchors[0].source === 1000, '生成的锚点正确')

// ---- 文本唯一但时间变了 → 迁移 ----
const cur2 = [mkCue(0, 2000, t1), mkCue(1, 9000, t2)]
const pv2 = previewPlan(plan1, cur2)
assert(pv2.entries.every((e) => e.status === 'migrated'), '时间变化、文本唯一 → 迁移')
assert(pv2.anchors?.[0].source === 2000 && pv2.anchors[0].target === 3000, '迁移后锚点绑定新原始时间、沿用目标时间')

// ---- 规范化后相同（多余空白）也能直接匹配 ----
const cur2b = [mkCue(0, 1000, `  ${t1}  `), mkCue(1, 5000, `${t2}\n第二行`.replace('第二句', '第二句'))]
const plan1b = mkPlan([
  ['00:00:01,000', '00:00:03,000', t1],
  ['00:00:05,000', '00:00:08,000', normalizeText(t2)],
])
const pv2b = previewPlan(plan1b, cur2b)
assert(pv2b.entries[0].status === 'direct', '首尾空白规范化后仍直接匹配')

// ---- 文本缺失 → 冲突 ----
const cur3 = [mkCue(0, 2000, t1), mkCue(1, 9000, '完全不同的句子')]
const pv3 = previewPlan(plan1, cur3)
assert(
  pv3.entries[0].status === 'migrated' &&
    pv3.entries[1].status === 'conflict' &&
    pv3.entries[1].conflictReason === 'missing',
  '文本找不到 → missing 冲突',
)
assert(pv3.validCount === 1, '仅 1 项有效')

// ---- 文本重复 → 冲突（时间又不同）----
const cur4 = [mkCue(0, 2000, t2), mkCue(1, 3000, t2), mkCue(2, 9000, t1)]
const pv4 = previewPlan(plan1, cur4)
assert(pv4.entries[1].status === 'conflict' && pv4.entries[1].conflictReason === 'duplicate', '重复文本 → duplicate 冲突')

// ---- 重复文本但原始时间也相同：优先直接匹配（唯一精确命中）----
const planDup = mkPlan([['00:00:02,000', '00:00:09,000', t2]])
const pv4b = previewPlan(planDup, cur4)
assert(pv4b.entries[0].status === 'direct', '时间+文本精确命中优先于重复判定')

// ---- 迁移破坏锚点顺序 → 冲突 ----
// 方案顺序 t1→t2→t3，当前字幕中 t3 排在 t1、t2 之前
const plan5 = mkPlan([
  ['00:00:01,000', '00:00:03,000', t1],
  ['00:00:05,000', '00:00:08,000', t2],
  ['00:00:09,000', '00:00:12,000', t3],
])
const cur5 = [mkCue(0, 1000, t3), mkCue(1, 2000, t1), mkCue(2, 6000, t2)]
const pv5 = previewPlan(plan5, cur5)
assert(
  pv5.entries[2].status === 'conflict' && pv5.entries[2].conflictReason === 'order',
  '迁移后落在首个有效锚点之前 → order 冲突',
)
assert(
  pv5.entries[0].status === 'migrated' && pv5.entries[1].status === 'migrated',
  '其余两项正常迁移',
)

// ---- 交叉迁移（迁移项与直接匹配交叉）→ 冲突 ----
const plan6 = mkPlan([
  ['00:00:01,000', '00:00:03,000', t1],
  ['00:00:05,000', '00:00:08,000', t2],
])
const cur6 = [mkCue(0, 5000, t2), mkCue(1, 6000, t1)]
const pv6 = previewPlan(plan6, cur6)
assert(
  pv6.entries[0].status === 'conflict' &&
    pv6.entries[0].conflictReason === 'order' &&
    pv6.entries[1].status === 'direct',
  '迁移项越过直接匹配锚点 → order 冲突，直接匹配保留',
)

// ---- 迁移导致锚点顺序被破坏（按匹配后原始时间重排）→ 冲突 ----
// 方案：t1(→10s) 在 t2(→20s) 之前；当前字幕 t2 在 t1 之前（时间也都变了，均走迁移）
const plan7 = mkPlan([
  ['00:00:01,000', '00:00:10,000', t1],
  ['00:00:05,000', '00:00:20,000', t2],
])
const cur7 = [mkCue(0, 1000, t2), mkCue(1, 5000, t1)]
const pv7 = previewPlan(plan7, cur7)
assert(pv7.conflictCount === 1, '顺序颠倒恰好一项冲突')
assert(
  pv7.entries[0].status === 'migrated' &&
    pv7.entries[1].status === 'conflict' &&
    pv7.entries[1].conflictReason === 'order',
  '迁移后顺序颠倒 → order 冲突（目标时间随之不再严格递增）',
)

// ---- 不替换文本：预览结果只携带时间，锚点不含文本副作用（结构性保证）----
assert(
  pv2.anchors?.every((a) => typeof a.source === 'number' && typeof a.target === 'number'),
  '应用数据仅含 source/target，不触碰字幕文本',
)

// ---- 方案文件：严格校验 ----
console.log('方案文件校验')
const expectError = (raw: string, code: string, msg: string) => {
  const r = parsePlan(raw)
  assert('error' in r && r.error.code === code, msg)
}
expectError('{not json', 'invalid-json', '非法 JSON 拒绝')
expectError('[]', 'invalid-shape', '顶层非对象拒绝')
expectError('{"anchors":[]}', 'invalid-shape', '缺 version 拒绝')
expectError('{"version": 2, "anchors": []}', 'unknown-version', '未知版本拒绝')
expectError('{"version": "1", "anchors": []}', 'unknown-version', '版本号类型错误拒绝')
expectError(
  JSON.stringify({
    version: 1,
    anchors: [
      { source: '00:00:01,000', target: '00:00:02,000', text: 'x' },
    ],
    exportedAt: 'today',
  }),
  'invalid-shape',
  '额外顶层字段拒绝',
)
expectError(
  JSON.stringify({
    version: 1,
    anchors: [{ source: '00:00:01,000', target: '00:00:02,000', text: 'x', extra: 1 }],
  }),
  'invalid-anchor',
  '锚点含未知字段拒绝',
)
expectError(
  JSON.stringify({
    version: 1,
    anchors: [{ source: 1000, target: 2000, text: 'x' }],
  }),
  'invalid-anchor',
  '时间非字符串拒绝',
)
expectError(
  JSON.stringify({
    version: 1,
    anchors: [{ source: 'bad', target: '00:00:02,000', text: 'x' }],
  }),
  'invalid-anchor',
  '时间码无法解析拒绝',
)
expectError(
  JSON.stringify({
    version: 1,
    anchors: [{ source: '00:00:01,000', target: '25:99:99,000', text: 'x' }],
  }),
  'invalid-anchor',
  '目标时间码非法拒绝',
)
expectError(
  JSON.stringify({
    version: 1,
    anchors: [
      { source: '00:00:01,000', target: '00:00:05,000', text: 'x' },
      { source: '00:00:02,000', target: '00:00:04,000', text: 'y' },
    ],
  }),
  'invalid-anchor',
  '目标时间不严格递增拒绝',
)
expectError(
  JSON.stringify({
    version: 1,
    anchors: [
      { source: '00:00:02,000', target: '00:00:03,000', text: 'x' },
      { source: '00:00:02,000', target: '00:00:04,000', text: 'y' },
    ],
  }),
  'invalid-anchor',
  '原始时间重复拒绝',
)
expectError(
  JSON.stringify({ version: 1, anchors: [{ source: '00:00:01,000', target: '00:00:02,000', text: '   ' }] }),
  'invalid-anchor',
  '规范化文本为空拒绝',
)
expectError(JSON.stringify({ version: 1, anchors: [] }), 'empty-anchors', '空锚点方案拒绝')

// 合法但带点号毫秒的时间可解析
const dotPlan = parsePlan(
  JSON.stringify({
    version: 1,
    anchors: [{ source: '00:00:01.500', target: '00:00:02,000', text: t4 }],
  }),
)
assert('plan' in dotPlan, '点号毫秒时间可被接受')

// 端到端：示例导出方案 → 同一份字幕重新导入，全部直接匹配且锚点一致
const e2ePlanJson = serializePlan(cues, [
  { source: cues[0].start, target: 3000 },
  { source: cues[6].start, target: 60000 },
])
const e2ePlanRes = parsePlan(e2ePlanJson ?? '')
assert('plan' in e2ePlanRes, '端到端方案解析成功')
if ('plan' in e2ePlanRes) {
  const e2ePreview = previewPlan(e2ePlanRes.plan, cues)
  assert(e2ePreview.validCount === 2, '同一份字幕 2 项全部直接匹配')
  assert(e2ePreview.entries.every((e) => e.status === 'direct'), '全部 direct')
  assert(
    e2ePreview.anchors?.[0].source === cues[0].start && e2ePreview.anchors[0].target === 3000,
    '端到端锚点值一致',
  )
}

// ---- 双语字幕合并 ----
console.log('双语合并：候选判定（正重叠且 ≥ 较短字幕 50%）')
const mkMain = (index: number, s: number, e: number, text = `主${index + 1}`): MappedLine => ({
  index,
  id: String(index + 1),
  start: s,
  end: e,
  text,
  newStart: s,
  newEnd: e,
})
const mkSec = (index: number, s: number, e: number, text = `次${index + 1}`): Cue => ({
  index,
  id: String(index + 1),
  start: s,
  end: e,
  text,
})
const pairKey = (res: ReturnType<typeof mergeSubtitles>) =>
  res.pairs.map((p) => `${p.mainIndex}:${p.secondaryIndex}`).join(',')

// 重叠 600ms，较短字幕 1000ms → 60% 合法；起始差 100
assert(
  legalPair(mkMain(0, 1000, 2000), mkSec(0, 1100, 1700))?.overlapMs === 600,
  '正重叠 ≥50% 判定为候选',
)
// 重叠 400ms = 较短字幕（1000ms）的 40% → 不合法（次轨延到 2600，重叠为 1600..2000）
assert(
  legalPair(mkMain(0, 1000, 2000), mkSec(0, 1600, 2600)) === null,
  '重叠不足较短字幕 50% 不是候选',
)
// 恰好 50%（较短 1000ms，重叠 500ms）→ 合法（“不少于”含边界）
assert(
  legalPair(mkMain(0, 1000, 2000), mkSec(0, 1500, 3000)) !== null,
  '重叠恰好 50% 仍为候选',
)
// 仅端点相接（重叠 0）→ 不合法
assert(legalPair(mkMain(0, 1000, 2000), mkSec(0, 2000, 3000)) === null, '无正重叠（端点相接）不是候选')
// 较短的一侧是主轨：主 500ms、次 1000ms，重叠 300ms = 60% 主时长 → 合法
assert(
  legalPair(mkMain(0, 1000, 1500), mkSec(0, 900, 1900)) !== null,
  '较短字幕为主轨时按主轨时长的 50% 判定',
)
// 校准后时长非正的主轨不参与
assert(legalPair(mkMain(0, 2000, 2000), mkSec(0, 1900, 2100)) === null, '非正时长主轨不参与匹配')

console.log('双语合并：基础一对一与未匹配条目')
{
  const mains = [mkMain(0, 1000, 3000), mkMain(1, 5000, 7000), mkMain(2, 9000, 11000)]
  const secs = [
    mkSec(0, 1100, 2900),
    mkSec(1, 5200, 6900),
    mkSec(2, 9100, 10900),
    mkSec(3, 20000, 22000), // 无任何重叠 → 未匹配次轨
  ]
  const r = mergeSubtitles(mains, secs)
  assert(r.pairs.length === 3, '三对一一匹配')
  assert(pairKey(r) === '0:0,1:1,2:2', '按文件顺序成对')
  assert(r.unmatchedMain.length === 0, '主轨全部匹配')
  assert(r.unmatchedSecondary.length === 1 && r.unmatchedSecondary[0] === 3, '无重叠次轨列入未匹配')
  assert(r.totalOverlapMs === 1800 + 1700 + 1800, '总重叠毫秒数正确')
  assert(r.totalStartDeltaMs === 100 + 200 + 100, '起始时间差总和正确')
}

console.log('双语合并：不足阈值的条目双方均不匹配')
{
  // 主 [1000,2000]，次 [1600,2600] 仅 400ms 重叠（较短 1000ms 的 40%）；双方都应为未匹配
  const r = mergeSubtitles([mkMain(0, 1000, 2000)], [mkSec(0, 1600, 2600)])
  assert(r.pairs.length === 0, '不足 50% 不产生匹配')
  assert(r.unmatchedMain[0] === 0 && r.unmatchedSecondary[0] === 0, '双方各自列入未匹配')
  assert(r.totalOverlapMs === 0 && r.totalStartDeltaMs === 0, '空方案得分为 0')
}

console.log('双语合并：顺序保持——交叉方案总重叠更高也不采用')
{
  // 构造“交叉成对也合法”的场景：两条主轨时间高度重叠（异常输入也必须按规则裁决）。
  // A[0,10000]、B[1000,11000]；X[1100,11000]、Y[0,10000]
  // 四个交叉对全部满足“重叠 ≥ 较短字幕 50%”：
  //   0:0 重叠 8900、1:1 重叠 9000 → 顺序方案总重叠 17900
  //   0:1 重叠 10000、1:0 重叠 9900 → 交叉方案总重叠 19900（更高，但破坏双方顺序）
  const mains = [mkMain(0, 0, 10000), mkMain(1, 1000, 11000)]
  const secs = [mkSec(0, 1100, 11000), mkSec(1, 0, 10000)]
  const r = mergeSubtitles(mains, secs)
  assert(pairKey(r) === '0:0,1:1', '即使交叉成对总重叠更高，也必须保持双方顺序')
  assert(r.totalOverlapMs === 17900, '总重叠按顺序方案计算（拒绝交叉方案）')
}

console.log('双语合并：平局裁决 1——总重叠相同时最小化起始差之和')
{
  // 单主轨即可制造“两个合法候选总重叠相同、起始差不同”：
  // A[0,1000]；X[100,1100]（重叠 900，delta 100）、Z[0,1000]（重叠 1000，delta 0）
  // 为使总重叠并列，再让 X 重叠 900、Z 也 900：Z 取 [0,900]（delta 0）。
  // 次序：0=X(delta100) 1=Z(delta0)，两者与 A 重叠均为 900，均 ≥500。
  const mains = [mkMain(0, 0, 1000)]
  const secs = [mkSec(0, 100, 1100), mkSec(1, 0, 900)]
  const r = mergeSubtitles(mains, secs)
  assert(
    pairKey(r) === '0:1' && r.totalOverlapMs === 900 && r.totalStartDeltaMs === 0,
    '总重叠并列时选择起始差更小的候选（Z，delta 0）',
  )
}

console.log('双语合并：平局裁决 2——起始差仍并列时次轨序号字典序更早')
{
  // A[0,1000]；次 0=P[0,1000]、次 1=Q[0,1000] 几何完全等价（重叠与 delta 相同）。
  const mains = [mkMain(0, 0, 1000)]
  const secs = [mkSec(0, 0, 1000), mkSec(1, 0, 1000)]
  const r = mergeSubtitles(mains, secs)
  assert(pairKey(r) === '0:0', '次轨序号字典序更早者（#1）胜')
  assert(r.unmatchedSecondary[0] === 1, '未选择的等位次轨（#2）列为未匹配')
}

console.log('双语合并：单边数量不等 + 仅部分匹配')
{
  const mains = [mkMain(0, 1000, 2000), mkMain(1, 5000, 6000)]
  const secs = [mkSec(0, 1000, 2000), mkSec(1, 5000, 6000), mkSec(2, 8000, 9000)]
  const r = mergeSubtitles(mains, secs)
  assert(r.pairs.length === 2 && r.unmatchedSecondary[0] === 2, '次轨多出的尾部不匹配')

  const mains2 = [mkMain(0, 1000, 2000), mkMain(1, 5000, 6000), mkMain(2, 9000, 10000)]
  const secs2 = [mkSec(0, 1000, 2000)]
  const r2 = mergeSubtitles(mains2, secs2)
  assert(
    pairKey(r2) === '0:0' && r2.unmatchedMain.join(',') === '1,2',
    '主轨多出的条目不匹配且按顺序列出',
  )
}

console.log('双语合并：空输入')
{
  assert(mergeSubtitles([], []).pairs.length === 0, '双方为空得到空方案')
  assert(mergeSubtitles([mkMain(0, 0, 1000)], []).unmatchedMain[0] === 0, '无次轨时主轨全部未匹配')
}

console.log('双语合并：导出沿用主轨时间码与文本，次轨文本追加为下一行')
{
  const mains = [
    mkMain(0, 1000, 3000, '主文本一'),
    mkMain(1, 5000, 7000, '主文本二\n第二行'),
  ]
  const secs = [
    mkSec(0, 1200, 2900, 'Secondary one'),
    mkSec(1, 5100, 6900, 'Secondary two\nline two'),
  ]
  const r = mergeSubtitles(mains, secs)
  const srt = buildMergedSrt(mains, secs, r)
  assert(
    srt.includes('00:00:01,000 --> 00:00:03,000\n主文本一\nSecondary one'),
    '已匹配主轨：主时间码 + 主文本 + 次轨文本下一行',
  )
  assert(
    srt.includes('00:00:05,000 --> 00:00:07,000\n主文本二\n第二行\nSecondary two\nline two'),
    '多行主/次文本各自原样保留并追加',
  )
}

console.log('双语合并：未匹配主轨照常导出，未匹配次轨不写入')
{
  const mains = [mkMain(0, 1000, 3000, '主一'), mkMain(1, 8000, 9000, '主二（无次轨）')]
  const secs = [mkSec(0, 1100, 2900, '次一'), mkSec(1, 20000, 22000, '次二（无主轨）')]
  const r = mergeSubtitles(mains, secs)
  assert(r.pairs.length === 1, '仅一对匹配')
  const srt = buildMergedSrt(mains, secs, r)
  assert(srt.includes('主二（无次轨）'), '未匹配主轨文本照常导出')
  assert(!srt.includes('次二（无主轨）'), '未匹配次轨不写入文件')
  const rep = parseSrt(srt)
  assert(rep.cues.length === 2, '导出去条目数等于主轨条目数（次轨不新增条目）')
  assert(
    rep.cues[1].text === '主二（无次轨）' && rep.cues[1].start === 8000 && rep.cues[1].end === 9000,
    '未匹配主轨时间码与文本均沿用主轨校准结果',
  )
}

console.log('双语合并：锚点变化（主轨时间轴重映射）后匹配实时变化')
{
  // 主轨原始 [11s,12s] 与次轨 [1s,2s] 完全不重叠；整体平移 -10s 后应匹配
  const rawCues = [
    { id: '1', index: 0, start: 11000, end: 12000, text: '主' },
  ]
  const before = mapCues(rawCues, [])
  const secs = [mkSec(0, 1000, 2000, '次')]
  assert(mergeSubtitles(before, secs).pairs.length === 0, '校准前无重叠 → 无匹配')
  const after = mapCues(rawCues, [{ source: 11000, target: 1000 }])
  assert(after[0].newStart === 1000, '单锚点整体平移 -10s')
  const ra = mergeSubtitles(after, secs)
  assert(ra.pairs.length === 1 && ra.pairs[0].secondaryIndex === 0, '校准后产生一对一匹配')
}

console.log('双语合并：端到端（示例主轨 + 同步次轨，锚点重映射）')
{
  const secContent = SAMPLE_SRT.replace(/欢迎使用字幕时间轴校准工具。/, 'Welcome to the SRT alignment tool.')
  const secParsed = parseSrt(secContent).cues
  const anchored = mapCues(cues, [
    { source: cues[0].start, target: 3000 },
    { source: cues[6].start, target: 60000 },
  ])
  // 次轨按原始时间 → 与校准后主轨不再对齐，预期匹配数下降；该检查只确保计算稳定
  const r = mergeSubtitles(anchored, secParsed)
  assert(r.pairs.length >= 0 && r.pairs.length <= 7, '端到端结果在合法范围内且不抛错')
  const srt = buildMergedSrt(anchored, secParsed, r)
  // 分段线性映射可能产生小数毫秒（与既有 buildSrt 行为一致），按空行分块计数
  assert(srt.trim().split(/\n{2,}/).length === 7, '端到端导出块数恒等于主轨 7 条')
  assert(!srt.includes('Welcome to the SRT alignment tool.'), '无匹配的次轨文本不会凭空写入')
  // 无锚点（时间为整数）时整份次轨全部匹配，导出后可被严格重新解析
  const idMapped = mapCues(cues, [])
  const r2 = mergeSubtitles(idMapped, secParsed)
  assert(r2.pairs.length === 7, '无锚点恒等时间轴下次轨 7 条全部匹配')
  const rep = parseSrt(buildMergedSrt(idMapped, secParsed, r2))
  assert(rep.cues.length === 7 && rep.skipped === 0, '整数时间码双语 SRT 可重新解析为 7 条')
  assert(rep.cues[0].text.endsWith('Welcome to the SRT alignment tool.'), '首条主文本后追加次轨文本')
}

console.log('双语合并：随机小例对照暴力枚举（含字典序裁决）')
{
  /** 暴力枚举全部顺序保持的一一匹配，按同样的优先级取最优。 */
  const EPS_LOCAL = 1e-6
  const brute = (mains: MappedLine[], secs: Cue[]) => {
    let best: { overlap: number; delta: number; seq: number[] } = {
      overlap: -1,
      delta: Infinity,
      seq: [],
    }
    const rec = (i: number, j: number, seq: number[], overlap: number, delta: number) => {
      if (i >= mains.length || j >= secs.length) {
        const better =
          overlap > best.overlap + EPS_LOCAL ||
          (Math.abs(overlap - best.overlap) <= EPS_LOCAL &&
            (delta < best.delta - EPS_LOCAL ||
              (Math.abs(delta - best.delta) <= EPS_LOCAL && lexLess(seq, best.seq))))
        if (better) best = { overlap, delta, seq: [...seq] }
        return
      }
      rec(i + 1, j, seq, overlap, delta) // 跳过主 i
      rec(i, j + 1, seq, overlap, delta) // 跳过次 j
      const legal = legalPair(mains[i], secs[j])
      if (legal) {
        rec(i + 1, j + 1, [...seq, j], overlap + legal.overlapMs, delta + legal.startDeltaMs)
      }
    }
    const lexLess = (a: number[], b: number[]): boolean => {
      for (let k = 0; k < Math.max(a.length, b.length); k++) {
        const x = k < a.length ? a[k] : Number.MAX_SAFE_INTEGER
        const y = k < b.length ? b[k] : Number.MAX_SAFE_INTEGER
        if (x !== y) return x < y
      }
      return false
    }
    rec(0, 0, [], 0, 0)
    return best
  }

  // 固定种子的简单伪随机，保证检查可复现
  let seed = 20260918
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  const randMain = (index: number): MappedLine => {
    const s = Math.floor(rand() * 6000)
    const e = s + 1 + Math.floor(rand() * 3000)
    return mkMain(index, s, e)
  }
  const randSec = (index: number): Cue => {
    const s = Math.floor(rand() * 6000)
    const e = s + 1 + Math.floor(rand() * 3000)
    return mkSec(index, s, e)
  }

  let trials = 0
  let mismatches = 0
  for (let t = 0; t < 400; t++) {
    const mc = 1 + Math.floor(rand() * 6)
    const nc = 1 + Math.floor(rand() * 6)
    const mains = Array.from({ length: mc }, (_, i) => randMain(i))
    const secs = Array.from({ length: nc }, (_, i) => randSec(i))
    const dp = mergeSubtitles(mains, secs)
    const bf = brute(mains, secs)
    const dpSeq = dp.pairs.map((p) => p.secondaryIndex)
    trials++
    if (
      Math.abs(dp.totalOverlapMs - bf.overlap) > EPS_LOCAL ||
      Math.abs(dp.totalStartDeltaMs - bf.delta) > EPS_LOCAL ||
      dpSeq.join(',') !== bf.seq.join(',')
    ) {
      mismatches++
    }
  }
  assert(trials === 400, `完成 ${trials} 组随机小例`)
  assert(mismatches === 0, `DP 与暴力枚举在重叠/起始差/次序号序列上完全一致（不一致 ${mismatches} 组）`)
}

console.log(failures === 0 ? '\n全部测试通过 ✅' : `\n${failures} 项失败 ❌`)
process.exit(failures === 0 ? 0 : 1)

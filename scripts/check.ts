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
import { SAMPLE_SRT } from '../src/sample'

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

console.log(failures === 0 ? '\n全部测试通过 ✅' : `\n${failures} 项失败 ❌`)
process.exit(failures === 0 ? 0 : 1)

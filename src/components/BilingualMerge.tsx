import type { MappedLine } from '../lib/anchor'
import type { Cue } from '../lib/srt'
import type { MergeResult } from '../lib/merge'
import { formatTime } from '../lib/time'

interface Props {
  /** 主轨校准后字幕（锚点变化后会实时重算）。 */
  lines: MappedLine[]
  /** 已导入的次轨 SRT（未导入时为 null）。 */
  secondary: Cue[] | null
  secondaryName: string
  /** 次轨导入后的匹配结果（App 中随锚点/次轨变化实时重算；无次轨时为 null）。 */
  result: MergeResult | null
  /** 主轨是否存在现有校验错误（存在则禁止合并导出）。 */
  hasErrors: boolean
  errorCount: number
  onImportSecondary: (file: File) => void
  onLoadSampleSecondary: () => void
  onUnloadSecondary: () => void
  onExportMerged: () => void
}

/**
 * 双语字幕合并面板：导入第二份 SRT 后，按校准后的主时间轴做顺序保持的
 * 一对一匹配预览（锚点每次变化都实时重算），列出双方未匹配条目，
 * 校验通过后导出“主文本 + 次文本”双语 SRT。
 */
export default function BilingualMerge({
  lines,
  secondary,
  secondaryName,
  result,
  hasErrors,
  errorCount,
  onImportSecondary,
  onLoadSampleSecondary,
  onUnloadSecondary,
  onExportMerged,
}: Props) {
  const mainByIndex = new Map(lines.map((l) => [l.index, l]))
  const secByIndex = new Map((secondary ?? []).map((c) => [c.index, c]))

  return (
    <section className="merge-section">
      <div className="merge-head">
        <h2 className="merge-title">双语字幕合并</h2>
        <div className="toolbar-group">
          <input
            type="file"
            accept=".srt,text/plain"
            hidden
            id="secondary-srt-input"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) onImportSecondary(f)
              e.target.value = ''
            }}
          />
          {secondary ? (
            <>
              <label className="btn btn-small" htmlFor="secondary-srt-input">
                重新导入次轨 SRT
              </label>
              <button className="btn btn-small btn-ghost" onClick={onUnloadSecondary}>
                卸载次轨
              </button>
            </>
          ) : (
            <>
              <label className="btn btn-small" htmlFor="secondary-srt-input">
                导入次轨 SRT
              </label>
              <button className="btn btn-small" onClick={onLoadSampleSecondary}>
                载入示例次轨
              </button>
            </>
          )}
          <button
            className="btn btn-small btn-primary"
            disabled={!secondary || hasErrors}
            title={
              !secondary
                ? '请先导入第二份 SRT'
                : hasErrors
                  ? `主轨仍有 ${errorCount} 条校验错误，解决后才能合并导出`
                  : '导出主文本 + 次轨文本的双语 SRT'
            }
            onClick={onExportMerged}
          >
            导出双语 SRT
          </button>
        </div>
      </div>

      {!secondary ? (
        <p className="merge-hint">
          主 SRT 校准完成后，可导入<strong>第二份 SRT</strong>：按校准后的主时间轴做顺序保持的一对一匹配
          （要求正重叠且重叠不少于较短字幕的 50%；优先最大化总重叠，再最小化起始差，平局取次轨序号字典序更早者）。
          编辑锚点时预览会实时重算；次轨仅用于预览与追加文本，不会改动主轨时间码。
        </p>
      ) : (
        <>
          <div className="merge-summary">
            <span className="merge-file" title={secondaryName}>
              次轨文件：{secondaryName}
            </span>
            <span className="pill pill-direct">已匹配 {result?.pairs.length ?? 0} 对</span>
            <span className="pill pill-conflict">主轨未匹配 {result?.unmatchedMain.length ?? 0}</span>
            <span className="pill pill-migrated">次轨未匹配 {result?.unmatchedSecondary.length ?? 0}</span>
            <span className="merge-score mono">
              总重叠 {Math.round(result?.totalOverlapMs ?? 0)} ms · 起始差合计{' '}
              {Math.round(result?.totalStartDeltaMs ?? 0)} ms
            </span>
          </div>

          {hasErrors && (
            <div className="export-blocked">
              ⚠ 主轨存在 {errorCount} 条校验错误（负时间 / 重叠 / 非正时长），错误未解决前禁止合并导出。
              以下预览仍会随锚点编辑实时重算，仅供参考。
            </div>
          )}

          <div className="merge-table-wrap">
            <table className="merge-table">
              <thead>
                <tr>
                  <th className="mg-no">主 #</th>
                  <th className="mg-time">主轨校准后时间</th>
                  <th>主轨文本</th>
                  <th className="mg-no">次 #</th>
                  <th className="mg-time">次轨时间</th>
                  <th>次轨文本</th>
                  <th className="mg-ms">重叠</th>
                  <th className="mg-ms">起始差</th>
                </tr>
              </thead>
              <tbody>
                {result?.pairs.map((pair) => {
                  const main = mainByIndex.get(pair.mainIndex)
                  const sec = secByIndex.get(pair.secondaryIndex)
                  if (!main || !sec) return null
                  return (
                    <tr key={`${pair.mainIndex}-${pair.secondaryIndex}`}>
                      <td className="mg-no">{main.id}</td>
                      <td className="mg-time mono">
                        {formatTime(main.newStart)}
                        <span className="sep">→</span>
                        {formatTime(main.newEnd)}
                      </td>
                      <td className="mg-text">
                        <pre className="cue-text">{main.text}</pre>
                      </td>
                      <td className="mg-no">{sec.id}</td>
                      <td className="mg-time mono">
                        {formatTime(sec.start)}
                        <span className="sep">→</span>
                        {formatTime(sec.end)}
                      </td>
                      <td className="mg-text">
                        <pre className="cue-text">{sec.text}</pre>
                      </td>
                      <td className="mg-ms mono">{Math.round(pair.overlapMs)}</td>
                      <td className="mg-ms mono">{Math.round(pair.startDeltaMs)}</td>
                    </tr>
                  )
                })}
                {result && result.pairs.length === 0 && (
                  <tr>
                    <td colSpan={8} className="empty-row">
                      没有满足条件（正重叠 ≥ 较短字幕 50%）的匹配对，全部条目均未匹配。
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="merge-unmatched">
            <div className="merge-unmatched-col">
              <h3>未匹配主轨（{result?.unmatchedMain.length ?? 0}，照常导出）</h3>
              <ul className="unmatched-list">
                {result?.unmatchedMain.map((i) => {
                  const line = mainByIndex.get(i)
                  if (!line) return null
                  return (
                    <li key={i}>
                      <span className="pl-cue-id">#{line.id}</span>
                      <span className="mono pl-cue-time">
                        {formatTime(line.newStart)} → {formatTime(line.newEnd)}
                      </span>
                      <span className="unmatched-text" title={line.text}>
                        {line.text}
                      </span>
                    </li>
                  )
                })}
                {(result?.unmatchedMain.length ?? 0) === 0 && <li className="pl-na">无</li>}
              </ul>
            </div>
            <div className="merge-unmatched-col">
              <h3>未匹配次轨（{result?.unmatchedSecondary.length ?? 0}，仅提示不写入）</h3>
              <ul className="unmatched-list">
                {result?.unmatchedSecondary.map((j) => {
                  const cue = secByIndex.get(j)
                  if (!cue) return null
                  return (
                    <li key={j}>
                      <span className="pl-cue-id">#{cue.id}</span>
                      <span className="mono pl-cue-time">
                        {formatTime(cue.start)} → {formatTime(cue.end)}
                      </span>
                      <span className="unmatched-text" title={cue.text}>
                        {cue.text}
                      </span>
                    </li>
                  )
                })}
                {(result?.unmatchedSecondary.length ?? 0) === 0 && <li className="pl-na">无</li>}
              </ul>
            </div>
          </div>
        </>
      )}
    </section>
  )
}

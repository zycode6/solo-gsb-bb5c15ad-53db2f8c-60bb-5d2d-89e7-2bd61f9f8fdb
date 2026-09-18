export const SAMPLE_SRT = `1
00:00:01,000 --> 00:00:04,000
欢迎使用字幕时间轴校准工具。

2
00:00:05,200 --> 00:00:08,800
先导入 SRT 文件，或直接使用本示例。

3
00:00:12,500 --> 00:00:15,000
在任意字幕上设置校准锚点。

4
00:00:18,000 --> 00:00:21,500
单个锚点会整体平移全部字幕。

5
00:00:26,000 --> 00:00:29,500
多个锚点之间按分段线性方式映射。

6
00:00:34,000 --> 00:00:37,000
首尾会沿最近区段的斜率自动外推。

7
00:00:42,000 --> 00:00:45,500
存在负时间、重叠或非正时长时无法导出。
`

/**
 * 双语合并示例次轨（英文）：时间轴与 SAMPLE_SRT 基本重合，个别条目略有错位，
 * 用于体验“主 SRT 校准后导入第二份 SRT”的顺序匹配与双语导出。
 */
export const SAMPLE_SECONDARY_SRT = `1
00:00:01,100 --> 00:00:03,900
Welcome to the SRT timeline alignment tool.

2
00:00:05,000 --> 00:00:09,000
Import an SRT file first, or try this built-in sample.

3
00:00:12,500 --> 00:00:15,200
Set alignment anchors on any subtitle.

4
00:00:18,200 --> 00:00:21,400
A single anchor shifts every subtitle as a whole.

5
00:00:26,000 --> 00:00:29,500
With multiple anchors, mapping is piecewise linear.

6
00:00:34,200 --> 00:00:37,000
Ends extrapolate along the nearest segment's slope.

7
00:00:42,500 --> 00:00:46,000
Negative times, overlaps or non-positive durations block export.
`

import {
  CartesianGrid,
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { HistoryEntry } from '../lib/historyStore'

interface Props {
  entries: HistoryEntry[]
}

/** 横軸は日付のみ（時刻は付けない） */
function formatAxisDate(ts: number, timeSpanMs: number): string {
  const d = new Date(ts)
  /** およそ 400 日超と年がまたがるときは年を明示 */
  if (timeSpanMs > 400 * 24 * 3600 * 1000) {
    return (
      d.toLocaleDateString('ja-JP', {
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
      }) ?? ''
    )
  }
  return (
    d.toLocaleDateString('ja-JP', {
      month: 'numeric',
      day: 'numeric',
    }) ?? ''
  )
}

/** グラフは古い順（左→右）、横軸は日付（時系列） */
export function BaldTrendChart({ entries }: Props) {
  const asc = [...entries].sort((a, b) => a.ts - b.ts)
  const span = asc.length >= 2 ? asc[asc.length - 1].ts - asc[0].ts : 0

  const data = asc.map((e) => ({
    ts: e.ts,
    label:
      new Date(e.ts).toLocaleDateString('ja-JP', {
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        weekday: 'short',
      }) ?? '',
    value: e.baldRate,
  }))

  if (data.length < 2) {
    return (
      <p className="rounded-xl border border-slate-200/80 bg-white/60 px-4 py-10 text-center text-sm text-slate-500 backdrop-blur">
        2回以上の記録があるとグラフが表示されます。
      </p>
    )
  }

  return (
    <div className="h-56 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 10, right: 12, bottom: 28, left: 14 }}>
          <defs>
            <linearGradient id="scalpConditionGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="oklch(0.76 0.16 248)" stopOpacity={0.45} />
              <stop offset="100%" stopColor="oklch(0.76 0.16 248)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="4 10" stroke="oklch(0.92 0.01 245)" vertical={false} />
          <XAxis
            dataKey="ts"
            type="number"
            scale="time"
            domain={['dataMin', 'dataMax']}
            tickFormatter={(v) => formatAxisDate(typeof v === 'number' ? v : Number(v), span)}
            tick={{ fill: '#64748b', fontSize: 10 }}
            tickMargin={8}
            minTickGap={18}
            angle={-18}
            textAnchor="end"
            height={46}
          />
          <YAxis
            domain={[0, 100]}
            width={54}
            tick={{ fill: '#64748b', fontSize: 11 }}
            tickMargin={4}
            axisLine={false}
            unit="%"
          />
          <Tooltip
            formatter={(value) =>
              [`${typeof value === 'number' ? value : '--'}%`, '見ため％（目安）']
            }
            labelFormatter={(_, pts) =>
              (pts?.[0]?.payload as { label?: string } | undefined)?.label ?? ''
            }
            contentStyle={{
              borderRadius: 12,
              border: '1px solid oklch(0.9 0.01 245)',
              background: 'oklch(0.995 0.002 245 / 95%)',
            }}
          />
          <Area
            type="monotone"
            dataKey="value"
            stroke="oklch(0.55 0.19 258)"
            strokeWidth={2.2}
            fill="url(#scalpConditionGradient)"
            dot={{ r: 3, strokeWidth: 2, stroke: '#fff' }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

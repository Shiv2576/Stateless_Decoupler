import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';

export default function MetricChart({ title, data, series, yUnit = '' }) {
  const showLegend = series.length > 1;

  return (
    <div className="chart-card">
      <h3>{title}</h3>
      {data.length === 0 ? (
        <div className="empty-state">Waiting for data…</div>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={data} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="t"
              tickFormatter={(s) => `${s}s`}
              stroke="var(--text-muted)"
              tick={{ fontSize: 11 }}
              minTickGap={30}
            />
            <YAxis
              stroke="var(--text-muted)"
              tick={{ fontSize: 11 }}
              width={44}
              tickFormatter={(v) => `${v}${yUnit}`}
            />
            <Tooltip
              contentStyle={{
                background: 'var(--surface-0)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                fontSize: 12,
              }}
              labelFormatter={(s) => `t = ${s}s`}
              formatter={(value, name) => [`${Number(value).toFixed(2)}${yUnit}`, name]}
            />
            {showLegend && <Legend wrapperStyle={{ fontSize: 12 }} />}
            {series.map((s) => (
              <Line
                key={s.key}
                type="monotone"
                dataKey={s.key}
                name={s.label}
                stroke={s.color}
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

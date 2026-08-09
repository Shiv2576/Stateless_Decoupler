export default function StatTile({ label, value, tone }) {
  return (
    <div className="stat-tile">
      <div className="label">{label}</div>
      <div className={`value${tone ? ` ${tone}` : ''}`}>{value}</div>
    </div>
  );
}

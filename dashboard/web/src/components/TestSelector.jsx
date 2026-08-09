export default function TestSelector({ files, selected, onSelect, onRun, running }) {
  return (
    <div className="toolbar">
      <select value={selected} onChange={(e) => onSelect(e.target.value)} disabled={running}>
        {files.length === 0 && <option value="">No test files found</option>}
        {files.map((f) => (
          <option key={f} value={f}>{f}</option>
        ))}
      </select>
      <button onClick={onRun} disabled={running || !selected}>
        {running ? 'Running…' : 'Run test'}
      </button>
    </div>
  );
}

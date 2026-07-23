const BIAS_TFS     = ['W', 'D', '4H', '1H'];
const BIAS_OPTIONS = ['auto', 'bullish', 'bearish', 'neutral'];

export default function BiasOverridePanel({ overrides, onChange }) {
  return (
    <div className="bias-override-panel">
      <p className="text-muted mb-sm">Override HTF bias per timeframe</p>
      {BIAS_TFS.map(tf => (
        <div key={tf} className="bias-override-row">
          <span className="bias-override-tf">{tf}</span>
          <select className="select-sm" value={overrides?.[tf] ?? 'auto'}
            onChange={e => onChange(tf, e.target.value)}>
            {BIAS_OPTIONS.map(opt => (
              <option key={opt} value={opt}>{opt.charAt(0).toUpperCase() + opt.slice(1)}</option>
            ))}
          </select>
        </div>
      ))}
    </div>
  );
}

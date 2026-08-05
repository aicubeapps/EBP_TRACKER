import { FOREX_BIAS_TFS, NSE_BIAS_TFS } from '../lib/constants';

const BIAS_OPTIONS = ['auto', 'bullish', 'bearish', 'neutral'];

// asset is optional — AssetCard.jsx doesn't pass it yet (Prompt B wires
// this through), so this falls back to the forex/crypto TF set until then,
// matching today's hardcoded behavior exactly.
export default function BiasOverridePanel({ asset, overrides, onChange }) {
  const biasTfs = asset?.asset_type === 'nse' ? NSE_BIAS_TFS : FOREX_BIAS_TFS;

  return (
    <div className="bias-override-panel">
      <p className="text-muted mb-sm">Override HTF bias per timeframe</p>
      {biasTfs.map(tf => (
        <div key={tf} className="bias-override-row">
          <span className="bias-override-tf">{tf}</span>
          <select className="select-sm" value={overrides?.[tf] ?? 'auto'} onChange={e => onChange(tf, e.target.value)}>
            {BIAS_OPTIONS.map(opt => (
              <option key={opt} value={opt}>{opt.charAt(0).toUpperCase() + opt.slice(1)}</option>
            ))}
          </select>
        </div>
      ))}
    </div>
  );
}

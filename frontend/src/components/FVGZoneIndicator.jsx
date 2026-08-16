function formatPrice(val) {
  const n = parseFloat(val);
  if (!Number.isFinite(n)) return '—';
  if (n >= 1000) return n.toFixed(2);
  if (n >= 1)    return n.toFixed(5);
  return n.toFixed(6);
}

export function FVGZoneIndicator({ fvgZones }) {
  if (!fvgZones || fvgZones.length === 0) return null;

  return (
    <div className="fvg-indicator">
      <span className="fvg-indicator__title">FVG Zones</span>
      <div className="fvg-indicator__table">
        <div className="fvg-indicator__header">
          <span>TF</span><span>Dir</span><span>Zone</span><span>Status</span>
        </div>
        {fvgZones.map(zone => {
          const isMitigated = !!zone.mitigated_at;
          const dirEmoji = zone.direction === 'bullish' ? '🟢' : '🔴';
          const zoneRange = `${formatPrice(zone.bottom)} – ${formatPrice(zone.top)}`;
          return (
            <div
              key={zone.id}
              className={`fvg-indicator__row ${isMitigated ? 'fvg-indicator__row--mitigated' : ''}`}
            >
              <span className="fvg-tf">{zone.tf}</span>
              <span className="fvg-dir">{dirEmoji}</span>
              <span className={`fvg-range ${isMitigated ? 'fvg-range--mitigated' : ''}`}>
                {zoneRange}
              </span>
              <span className="fvg-status">
                {isMitigated ? 'Mitigated ✓' : 'Active'}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

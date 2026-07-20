import { Trash2 } from 'lucide-react'
import Badge from './ui/Badge.jsx'
import TFGrid from './TFGrid.jsx'

const assetTypeVariant = {
  Forex: 'blue',
  Commodity: 'yellow',
  Index: 'purple',
  'NSE Asset': 'neutral',
  Crypto: 'coffee',
}

export default function AssetCard({ asset, onRemove }) {
  const { symbol, type, tfData = {}, lastAlert } = asset

  return (
    <div className="bg-bg-card border border-border rounded-lg card-hover">
      {/* Desktop: single-row layout */}
      <div className="hidden lg:flex items-center gap-4 px-5 py-4">
        {/* Left — symbol + type (25%) */}
        <div className="w-1/4 shrink-0">
          <span className="block text-base font-bold text-text-primary tabular-nums">{symbol}</span>
          <Badge variant={assetTypeVariant[type] || 'neutral'} className="mt-1">{type}</Badge>
        </div>

        {/* Center — TFGrid (50%) */}
        <div className="flex-1">
          <TFGrid data={tfData} />
        </div>

        {/* Right — last alert + remove (25%) */}
        <div className="w-1/4 shrink-0 flex items-center justify-end gap-3">
          <div className="text-right">
            <p className="text-xs text-text-muted">Last alert</p>
            <p className="text-xs text-text-secondary tabular-nums">{lastAlert || 'None yet'}</p>
          </div>
          {onRemove && (
            <button
              onClick={() => onRemove(symbol)}
              className="p-1.5 text-text-muted hover:text-bear rounded transition-colors"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>

      {/* Mobile: stacked layout */}
      <div className="lg:hidden p-4 space-y-3">
        {/* Row 1: symbol + type + remove */}
        <div className="flex items-start justify-between">
          <div>
            <span className="block text-base font-bold text-text-primary tabular-nums">{symbol}</span>
            <Badge variant={assetTypeVariant[type] || 'neutral'} className="mt-1">{type}</Badge>
          </div>
          {onRemove && (
            <button
              onClick={() => onRemove(symbol)}
              className="p-1.5 text-text-muted hover:text-bear rounded transition-colors mt-0.5"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>

        {/* Row 2: TFGrid full width */}
        <TFGrid data={tfData} />

        {/* Row 3: last alert */}
        <div className="text-xs text-text-muted pt-1 border-t border-border-subtle">
          Last alert: <span className="text-text-secondary">{lastAlert || 'None yet'}</span>
        </div>
      </div>
    </div>
  )
}

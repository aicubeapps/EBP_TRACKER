import Card from './ui/Card.jsx'
import Badge from './ui/Badge.jsx'
import TFGrid from './TFGrid.jsx'

const assetTypeVariant = {
  Forex: 'blue',
  Commodity: 'yellow',
  Index: 'purple',
  'Indian Stock': 'neutral',
  Crypto: 'coffee',
}

export default function AssetCard({ asset }) {
  const { symbol, type, tfData = {}, lastAlert } = asset

  return (
    <Card hover className="flex flex-col gap-3">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-base font-semibold text-text-primary tabular-nums">{symbol}</h3>
          <Badge variant={assetTypeVariant[type] || 'neutral'} className="mt-1">
            {type}
          </Badge>
        </div>
      </div>
      <TFGrid data={tfData} />
      <div className="text-xs text-text-muted pt-1 border-t border-border-subtle">
        {lastAlert ? (
          <span>Last alert: <span className="text-text-secondary">{lastAlert}</span></span>
        ) : (
          <span>No alerts yet</span>
        )}
      </div>
    </Card>
  )
}

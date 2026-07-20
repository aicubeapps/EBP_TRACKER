import { BarChart2 } from 'lucide-react'
import AssetCard from '../components/AssetCard.jsx'
import ExpiryBanner from '../components/ExpiryBanner.jsx'
import EmptyState from '../components/ui/EmptyState.jsx'
import Button from '../components/ui/Button.jsx'
import { useNavigate } from 'react-router-dom'
import { useAssets } from '../hooks/useAssets.js'

const PLACEHOLDER_ASSETS = [
  { symbol: 'EURUSD', type: 'Forex', tfData: { M15: 'bull', '1H': 'bull', '4H': 'none', D: 'none', W: 'bear' }, lastAlert: '2h ago' },
  { symbol: 'XAUUSD', type: 'Commodity', tfData: { M15: 'none', '1H': 'bear', '4H': 'bear', D: 'none', W: 'none' }, lastAlert: '5h ago' },
  { symbol: 'RELIANCE', type: 'NSE Asset', tfData: { M15: 'none', '1H': 'none', '4H': 'bull', D: 'bull', W: 'none' }, lastAlert: 'Yesterday' },
]

export default function Dashboard() {
  const navigate = useNavigate()
  const { assets, loading } = useAssets()

  const displayAssets = assets.length > 0 ? assets : PLACEHOLDER_ASSETS

  return (
    <div>
      <ExpiryBanner daysLeft={null} />
      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="bg-bg-card border border-border rounded-lg h-20 animate-pulse" />
          ))}
        </div>
      ) : displayAssets.length === 0 ? (
        <EmptyState
          icon={BarChart2}
          title="No assets tracked yet"
          description="Add your first asset to start receiving engulfing bar print alerts."
          action={<Button onClick={() => navigate('/assets')} className="w-full lg:w-auto">Add Asset</Button>}
        />
      ) : (
        <div className="space-y-3">
          {displayAssets.map((asset) => (
            <AssetCard key={asset.symbol} asset={asset} />
          ))}
        </div>
      )}
    </div>
  )
}

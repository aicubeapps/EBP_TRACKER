import { useState } from 'react'
import { Check } from 'lucide-react'
import Card from '../components/ui/Card.jsx'
import Button from '../components/ui/Button.jsx'

const TIERS = [
  {
    id: 'coffee',
    emoji: '☕',
    name: 'Coffee',
    price: '₹99',
    assets: 5,
    days: 30,
    features: ['5 asset slots', 'All timeframes (M15–W)', '30-day access', 'Telegram alerts'],
    variant: 'coffee',
  },
  {
    id: 'beer',
    emoji: '🍺',
    name: 'Beer',
    price: '₹249',
    assets: 8,
    days: 30,
    features: ['8 asset slots', 'All timeframes (M15–W)', '30-day access', 'Telegram alerts', 'Priority support'],
    variant: 'beer',
    popular: true,
  },
  {
    id: 'wine',
    emoji: '🍷',
    name: 'Wine',
    price: '₹499',
    assets: 13,
    days: 30,
    features: ['13 asset slots', 'All timeframes (M15–W)', '30-day access', 'Telegram alerts', 'Custom TF pairing', 'Priority support'],
    variant: 'wine',
  },
]

const STATUS_STYLES = {
  pending: 'text-accent-yellow',
  approved: 'text-bull',
  rejected: 'text-bear',
}

export default function Upgrade() {
  const [selectedTier, setSelectedTier] = useState(null)
  const [txRef, setTxRef] = useState('')
  const [payStatus] = useState(null)

  return (
    <div>
      <p className="text-sm text-text-secondary mb-6">
        Support EBP Tracker and unlock more asset slots. All plans are manual UPI payment — activated within 24 hours.
      </p>

      {/* Tier Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        {TIERS.map((tier) => (
          <div
            key={tier.id}
            onClick={() => setSelectedTier(tier.id)}
            className={`relative flex flex-col bg-bg-card border rounded-lg p-5 cursor-pointer transition-all ${
              selectedTier === tier.id
                ? 'border-accent-blue shadow-[0_0_0_1px_rgba(68,136,255,0.4)]'
                : 'border-border hover:border-border/60'
            }`}
          >
            {tier.popular && (
              <span className="absolute -top-2.5 left-1/2 -translate-x-1/2 px-2 py-0.5 text-[10px] font-bold bg-accent-blue text-white rounded-full">
                POPULAR
              </span>
            )}
            <div className="text-4xl mb-3">{tier.emoji}</div>
            <h3 className="text-lg font-bold text-text-primary mb-1">{tier.name}</h3>
            <div className="text-2xl font-bold text-text-primary tabular-nums mb-1">{tier.price}</div>
            <p className="text-xs text-text-muted mb-4">{tier.assets} assets · {tier.days} days</p>
            <ul className="space-y-1.5 mb-5 flex-1">
              {tier.features.map((f) => (
                <li key={f} className="flex items-center gap-2 text-xs text-text-secondary">
                  <Check size={11} className="text-bull shrink-0" />
                  {f}
                </li>
              ))}
            </ul>
            <Button
              variant={selectedTier === tier.id ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => setSelectedTier(tier.id)}
            >
              Select {tier.name}
            </Button>
          </div>
        ))}
      </div>

      {/* UPI Payment Section */}
      {selectedTier && (
        <Card className="max-w-md">
          <h3 className="text-sm font-semibold text-text-primary mb-4">Pay via UPI</h3>
          <div className="flex items-center gap-6 mb-4">
            <div className="w-24 h-24 bg-bg-elevated border border-border rounded-lg flex items-center justify-center text-text-muted text-xs text-center">
              QR Code<br/>Placeholder
            </div>
            <div>
              <p className="text-xs text-text-muted mb-1">UPI ID</p>
              <p className="text-sm font-mono text-accent-blue">yourupi@bank</p>
              <p className="text-xs text-text-muted mt-2">Amount: <span className="text-text-primary font-medium tabular-nums">
                {TIERS.find((t) => t.id === selectedTier)?.price}
              </span></p>
            </div>
          </div>
          <div className="space-y-3">
            <div>
              <label className="block text-xs text-text-muted mb-1.5">Transaction Reference / UTR Number</label>
              <input
                type="text"
                value={txRef}
                onChange={(e) => setTxRef(e.target.value)}
                placeholder="e.g. 123456789012"
                className="w-full px-3 py-2 bg-bg-elevated border border-border rounded-lg text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-blue font-mono"
              />
            </div>
            <Button className="w-full" disabled={txRef.length < 6}>Submit Payment</Button>
            {payStatus && (
              <p className={`text-xs text-center font-medium ${STATUS_STYLES[payStatus]}`}>
                {payStatus === 'pending' && 'Payment submitted — pending verification (within 24h)'}
                {payStatus === 'approved' && 'Payment approved! Your plan is now active.'}
                {payStatus === 'rejected' && 'Payment rejected. Please contact support.'}
              </p>
            )}
          </div>
        </Card>
      )}
    </div>
  )
}

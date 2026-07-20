import { useState } from 'react'
import { Search, Plus, Trash2, BarChart2 } from 'lucide-react'
import Button from '../components/ui/Button.jsx'
import Modal from '../components/ui/Modal.jsx'
import EmptyState from '../components/ui/EmptyState.jsx'
import Badge from '../components/ui/Badge.jsx'

const ASSET_TYPES = ['Forex', 'Commodity', 'Index', 'Indian Stock', 'Crypto']
const MAX_SLOTS = 3

const PLACEHOLDER_ASSETS = [
  { id: 1, symbol: 'EURUSD', type: 'Forex' },
  { id: 2, symbol: 'XAUUSD', type: 'Commodity' },
]

export default function Assets() {
  const [search, setSearch] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [newSymbol, setNewSymbol] = useState('')
  const [newType, setNewType] = useState('Forex')
  const [assets] = useState(PLACEHOLDER_ASSETS)

  const filtered = assets.filter((a) =>
    a.symbol.toLowerCase().includes(search.toLowerCase())
  )

  const slotsUsed = assets.length
  const slotPct = (slotsUsed / MAX_SLOTS) * 100

  return (
    <div className="max-w-2xl">
      <div className="flex items-center gap-3 mb-5">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search symbol e.g. EURUSD, RELIANCE, BTC"
            className="w-full pl-9 pr-4 py-2 bg-bg-card border border-border rounded-lg text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-blue"
          />
        </div>
        <Button onClick={() => setModalOpen(true)} disabled={slotsUsed >= MAX_SLOTS}>
          <Plus size={14} />
          Add Asset
        </Button>
      </div>

      {/* Slot usage */}
      <div className="mb-5 p-4 bg-bg-card border border-border rounded-lg">
        <div className="flex items-center justify-between mb-2 text-sm">
          <span className="text-text-secondary">Slot usage</span>
          <span className="text-text-primary font-medium tabular-nums">
            {slotsUsed} / {MAX_SLOTS} slots used
          </span>
        </div>
        <div className="h-1.5 bg-bg-elevated rounded-full overflow-hidden">
          <div
            className="h-full bg-accent-blue rounded-full transition-all duration-300"
            style={{ width: `${Math.min(slotPct, 100)}%` }}
          />
        </div>
        <p className="text-xs text-text-muted mt-1.5">Upgrade your plan to track more assets.</p>
      </div>

      {filtered.length === 0 ? (
        <EmptyState icon={BarChart2} title="No assets found" description="Add your first asset or adjust your search." />
      ) : (
        <div className="space-y-2">
          {filtered.map((asset) => (
            <div key={asset.id} className="flex items-center justify-between px-4 py-3 bg-bg-card border border-border rounded-lg">
              <div className="flex items-center gap-3">
                <span className="text-sm font-semibold text-text-primary tabular-nums">{asset.symbol}</span>
                <Badge variant="blue">{asset.type}</Badge>
              </div>
              <button className="p-1.5 text-text-muted hover:text-bear rounded transition-colors">
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      <Modal isOpen={modalOpen} onClose={() => setModalOpen(false)} title="Add Asset">
        <div className="space-y-4">
          <div>
            <label className="block text-xs text-text-secondary mb-1.5">Symbol</label>
            <input
              type="text"
              value={newSymbol}
              onChange={(e) => setNewSymbol(e.target.value.toUpperCase())}
              placeholder="e.g. EURUSD, RELIANCE, BTCUSDT"
              className="w-full px-3 py-2 bg-bg-elevated border border-border rounded-lg text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-blue"
            />
          </div>
          <div>
            <label className="block text-xs text-text-secondary mb-1.5">Asset Type</label>
            <select
              value={newType}
              onChange={(e) => setNewType(e.target.value)}
              className="w-full px-3 py-2 bg-bg-elevated border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:border-accent-blue"
            >
              {ASSET_TYPES.map((t) => <option key={t}>{t}</option>)}
            </select>
          </div>
          <div className="flex gap-2 pt-2">
            <Button variant="secondary" className="flex-1" onClick={() => setModalOpen(false)}>Cancel</Button>
            <Button className="flex-1" onClick={() => setModalOpen(false)}>Add Asset</Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}

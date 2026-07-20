import { useState } from 'react'
import { MessageCircle, CheckCircle, ExternalLink, Send } from 'lucide-react'
import Card from '../components/ui/Card.jsx'
import Button from '../components/ui/Button.jsx'

export default function Settings() {
  const [telegramConnected] = useState(false)
  const [botCode, setBotCode] = useState('')
  const [alertMode, setAlertMode] = useState('aligned')

  return (
    <div className="max-w-2xl space-y-6">
      {/* Telegram Section */}
      <section>
        <h2 className="text-sm font-semibold text-text-primary mb-3 uppercase tracking-wider">Telegram</h2>
        <Card>
          <div className="flex items-center gap-2 mb-4">
            <MessageCircle size={16} className="text-accent-blue" />
            <span className="text-sm font-medium text-text-primary">Telegram Connection</span>
            {telegramConnected && (
              <span className="flex items-center gap-1 ml-auto text-xs text-bull">
                <CheckCircle size={12} /> Connected
              </span>
            )}
          </div>

          {telegramConnected ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between p-3 bg-bg-elevated rounded-lg">
                <span className="text-sm text-text-secondary">Chat ID</span>
                <span className="text-sm font-mono text-text-muted">••••7823</span>
              </div>
              <div className="flex gap-2">
                <Button variant="secondary" size="sm">
                  <Send size={12} /> Send Test
                </Button>
                <Button variant="ghost" size="sm">Disconnect</Button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-text-secondary">
                Connect your Telegram to receive EBP alerts directly in your chat.
              </p>
              <div className="p-3 bg-bg-elevated rounded-lg text-sm">
                <p className="text-text-muted mb-2">1. Open the bot and send <span className="font-mono text-accent-blue">/start</span></p>
                <a
                  href="#"
                  className="inline-flex items-center gap-1 text-accent-blue text-sm hover:underline"
                >
                  Open @EBPTrackerBot <ExternalLink size={12} />
                </a>
              </div>
              <div>
                <label className="block text-xs text-text-muted mb-1.5">2. Enter your verification code</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={botCode}
                    onChange={(e) => setBotCode(e.target.value)}
                    placeholder="6-digit code"
                    className="flex-1 px-3 py-2 bg-bg-elevated border border-border rounded-lg text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-blue font-mono"
                  />
                  <Button disabled={botCode.length < 4}>Verify</Button>
                </div>
              </div>
            </div>
          )}
        </Card>
      </section>

      {/* Alert Mode */}
      <section>
        <h2 className="text-sm font-semibold text-text-primary mb-3 uppercase tracking-wider">Alert Mode</h2>
        <Card>
          <div className="space-y-2">
            {[
              { id: 'aligned', label: 'Trend Aligned Only', desc: 'Only fire alerts when EBP aligns with the higher timeframe trend bias.' },
              { id: 'all', label: 'All Engulfing Bars', desc: 'Fire alerts for every engulfing bar print regardless of trend direction.' },
            ].map((opt) => (
              <label
                key={opt.id}
                className={`flex items-start gap-3 p-3 rounded-lg cursor-pointer border transition-colors ${
                  alertMode === opt.id
                    ? 'border-accent-blue/40 bg-accent-blue/5'
                    : 'border-border hover:border-border/80 hover:bg-bg-elevated'
                }`}
              >
                <input
                  type="radio"
                  name="alertMode"
                  value={opt.id}
                  checked={alertMode === opt.id}
                  onChange={() => setAlertMode(opt.id)}
                  className="mt-0.5 accent-accent-blue"
                />
                <div>
                  <p className="text-sm font-medium text-text-primary">{opt.label}</p>
                  <p className="text-xs text-text-muted mt-0.5">{opt.desc}</p>
                </div>
              </label>
            ))}
          </div>
        </Card>
      </section>

      {/* Timeframe Pairing — Wine only */}
      <section className="opacity-50 pointer-events-none">
        <div className="flex items-center gap-2 mb-3">
          <h2 className="text-sm font-semibold text-text-primary uppercase tracking-wider">Timeframe Pairing</h2>
          <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-accent-purple/20 text-accent-purple border border-accent-purple/30">
            🍷 WINE
          </span>
        </div>
        <Card>
          <p className="text-sm text-text-muted">
            Custom higher timeframe pairing is available on the Wine plan. Upgrade to configure custom HTF bias per asset.
          </p>
        </Card>
      </section>
    </div>
  )
}

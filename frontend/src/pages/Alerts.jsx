import { Bell, CheckCircle, AlertTriangle } from 'lucide-react'
import { Table, THead, TBody, TR, TH, TD } from '../components/ui/Table.jsx'
import EBPBadge from '../components/EBPBadge.jsx'
import EmptyState from '../components/ui/EmptyState.jsx'

const PLACEHOLDER_ALERTS = [
  { id: 1, ts: '2026-07-20 14:30', symbol: 'EURUSD', tf: '1H', direction: 'bull', aligned: true, candleTime: '2026-07-20 14:00' },
  { id: 2, ts: '2026-07-20 10:15', symbol: 'XAUUSD', tf: '4H', direction: 'bear', aligned: false, candleTime: '2026-07-20 08:00' },
  { id: 3, ts: '2026-07-19 21:00', symbol: 'RELIANCE', tf: 'D', direction: 'bull', aligned: true, candleTime: '2026-07-19 00:00' },
]

export default function Alerts() {
  const alerts = PLACEHOLDER_ALERTS

  return (
    <div>
      {alerts.length === 0 ? (
        <EmptyState
          icon={Bell}
          title="No alerts fired yet"
          description="No alerts fired yet. Add assets and connect Telegram to get started."
        />
      ) : (
        <Table>
          <THead>
            <tr>
              <TH>Timestamp</TH>
              <TH>Symbol</TH>
              <TH>Timeframe</TH>
              <TH>Direction</TH>
              <TH>Trend Aligned</TH>
              <TH>Candle Time</TH>
            </tr>
          </THead>
          <TBody>
            {alerts.map((alert) => (
              <TR key={alert.id}>
                <TD className="text-text-secondary">{alert.ts}</TD>
                <TD className="font-semibold">{alert.symbol}</TD>
                <TD>
                  <span className="px-2 py-0.5 bg-bg-elevated border border-border rounded text-xs font-mono text-text-secondary">
                    {alert.tf}
                  </span>
                </TD>
                <TD><EBPBadge direction={alert.direction} /></TD>
                <TD>
                  {alert.aligned ? (
                    <div className="flex items-center gap-1 text-bull text-xs">
                      <CheckCircle size={12} />
                      <span>Yes</span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1 text-accent-yellow text-xs">
                      <AlertTriangle size={12} />
                      <span>No</span>
                    </div>
                  )}
                </TD>
                <TD className="text-text-muted">{alert.candleTime}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </div>
  )
}

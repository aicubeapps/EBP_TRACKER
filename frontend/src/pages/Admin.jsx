import { useState } from 'react'
import { ShieldOff, Check, X, Plus } from 'lucide-react'
import { Table, THead, TBody, TR, TH, TD } from '../components/ui/Table.jsx'
import Button from '../components/ui/Button.jsx'
import Badge from '../components/ui/Badge.jsx'

const IS_ADMIN = false

const TABS = ['Users', 'Payments', 'Invite Tokens']

const PLACEHOLDER_USERS = [
  { id: 1, email: 'trader@example.com', plan: 'BEER', expiry: '2026-08-20', assets: 4, alerts: 23, telegram: true },
  { id: 2, email: 'user2@example.com', plan: 'FREE', expiry: '—', assets: 1, alerts: 0, telegram: false },
]

const PLACEHOLDER_PAYMENTS = [
  { id: 1, email: 'newuser@example.com', tier: 'Coffee', amount: '₹99', ref: 'UTR12345', submitted: '2026-07-20', status: 'pending' },
]

const PLACEHOLDER_TOKENS = [
  { id: 1, token: 'inv_abc123', used: true, usedBy: 'trader@example.com', createdAt: '2026-07-01' },
  { id: 2, token: 'inv_xyz789', used: false, usedBy: null, createdAt: '2026-07-15' },
]

export default function Admin() {
  const [tab, setTab] = useState('Users')

  if (!IS_ADMIN) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <ShieldOff size={40} className="text-bear mb-4" />
        <h2 className="text-lg font-semibold text-text-primary mb-1">Access Denied</h2>
        <p className="text-sm text-text-muted">This panel is restricted to administrators.</p>
      </div>
    )
  }

  return (
    <div>
      <div className="flex gap-1 mb-5 bg-bg-elevated border border-border rounded-lg p-1 w-fit">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-1.5 text-sm rounded-md font-medium transition-colors ${
              tab === t ? 'bg-bg-card text-text-primary shadow-sm' : 'text-text-muted hover:text-text-secondary'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'Users' && (
        <Table>
          <THead><tr><TH>Email</TH><TH>Plan</TH><TH>Expiry</TH><TH>Assets</TH><TH>Alerts</TH><TH>Telegram</TH></tr></THead>
          <TBody>
            {PLACEHOLDER_USERS.map((u) => (
              <TR key={u.id}>
                <TD className="text-text-secondary">{u.email}</TD>
                <TD><Badge variant={u.plan.toLowerCase()}>{u.plan}</Badge></TD>
                <TD className="text-text-muted">{u.expiry}</TD>
                <TD>{u.assets}</TD>
                <TD>{u.alerts}</TD>
                <TD>{u.telegram ? <Check size={14} className="text-bull" /> : <X size={14} className="text-text-muted" />}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}

      {tab === 'Payments' && (
        <Table>
          <THead><tr><TH>Email</TH><TH>Tier</TH><TH>Amount</TH><TH>UTR Ref</TH><TH>Submitted</TH><TH>Actions</TH></tr></THead>
          <TBody>
            {PLACEHOLDER_PAYMENTS.map((p) => (
              <TR key={p.id}>
                <TD className="text-text-secondary">{p.email}</TD>
                <TD>{p.tier}</TD>
                <TD className="tabular-nums">{p.amount}</TD>
                <TD className="font-mono text-text-muted">{p.ref}</TD>
                <TD className="text-text-muted">{p.submitted}</TD>
                <TD>
                  <div className="flex gap-1">
                    <Button variant="success" size="sm"><Check size={12} /> Approve</Button>
                    <Button variant="danger" size="sm"><X size={12} /> Reject</Button>
                  </div>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}

      {tab === 'Invite Tokens' && (
        <div>
          <div className="flex justify-end mb-3">
            <Button size="sm"><Plus size={12} /> Generate Token</Button>
          </div>
          <Table>
            <THead><tr><TH>Token</TH><TH>Status</TH><TH>Used By</TH><TH>Created</TH></tr></THead>
            <TBody>
              {PLACEHOLDER_TOKENS.map((t) => (
                <TR key={t.id}>
                  <TD className="font-mono text-accent-blue">{t.token}</TD>
                  <TD><Badge variant={t.used ? 'neutral' : 'bull'}>{t.used ? 'Used' : 'Unused'}</Badge></TD>
                  <TD className="text-text-muted">{t.usedBy || '—'}</TD>
                  <TD className="text-text-muted">{t.createdAt}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      )}
    </div>
  )
}

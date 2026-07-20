import { useState } from 'react'
import Box from '@mui/material/Box'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import Tabs from '@mui/material/Tabs'
import Tab from '@mui/material/Tab'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import Paper from '@mui/material/Paper'
import { Table, THead, TBody, TR, TH, TD } from '../components/ui/Table.jsx'
import CheckOutlinedIcon from '@mui/icons-material/CheckOutlined'
import CloseOutlinedIcon from '@mui/icons-material/CloseOutlined'
import AddOutlinedIcon from '@mui/icons-material/AddOutlined'
import BlockOutlinedIcon from '@mui/icons-material/BlockOutlined'
import CheckCircleOutlinedIcon from '@mui/icons-material/CheckCircleOutlined'

const IS_ADMIN = false

const PLAN_SX = {
  FREE:   { bgcolor: '#0d0d0d', color: '#8888a8', border: '1px solid #2a2a2a' },
  COFFEE: { bgcolor: '#1a1100', color: '#f5a623', border: '1px solid #f5a623' },
  BEER:   { bgcolor: '#001033', color: '#4488ff', border: '1px solid #4488ff' },
  WINE:   { bgcolor: '#110022', color: '#8855ff', border: '1px solid #8855ff' },
}

const PLACEHOLDER_USERS = [
  { id: 1, email: 'trader@example.com', plan: 'BEER',  expiry: '2026-08-20', assets: 4, alerts: 23, telegram: true },
  { id: 2, email: 'user2@example.com',  plan: 'FREE',  expiry: '—',          assets: 1, alerts: 0,  telegram: false },
]

const PLACEHOLDER_PAYMENTS = [
  { id: 1, email: 'newuser@example.com', tier: 'Coffee', amount: '₹99', ref: 'UTR12345', submitted: '2026-07-20', status: 'pending' },
]

const PLACEHOLDER_TOKENS = [
  { id: 1, token: 'inv_abc123', used: true,  usedBy: 'trader@example.com', createdAt: '2026-07-01' },
  { id: 2, token: 'inv_xyz789', used: false, usedBy: null,                 createdAt: '2026-07-15' },
]

export default function Admin() {
  const [tab, setTab] = useState(0)

  if (!IS_ADMIN) {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', py: 10 }}>
        <BlockOutlinedIcon sx={{ fontSize: 48, color: '#ff4466', mb: 2 }} />
        <Typography variant="h4" sx={{ mb: 0.5 }}>Access Denied</Typography>
        <Typography variant="body2">This panel is restricted to administrators.</Typography>
      </Box>
    )
  }

  return (
    <Box>
      <Box sx={{ borderBottom: '1px solid #1a1a1a', mb: 3 }}>
        <Tabs value={tab} onChange={(_, v) => setTab(v)}>
          <Tab label="Users" />
          <Tab label="Payments" />
          <Tab label="Invite Tokens" />
        </Tabs>
      </Box>

      {tab === 0 && (
        <Table>
          <THead><TR><TH>Email</TH><TH>Plan</TH><TH>Expiry</TH><TH>Assets</TH><TH>Alerts</TH><TH>Telegram</TH></TR></THead>
          <TBody>
            {PLACEHOLDER_USERS.map((u) => (
              <TR key={u.id}>
                <TD sx={{ color: '#8888a8' }}>{u.email}</TD>
                <TD><Chip label={u.plan} size="small" sx={{ borderRadius: '4px', fontWeight: 700, fontSize: '0.7rem', height: 20, ...PLAN_SX[u.plan] }} /></TD>
                <TD sx={{ color: '#55556a' }} className="tabular-nums">{u.expiry}</TD>
                <TD className="tabular-nums">{u.assets}</TD>
                <TD className="tabular-nums">{u.alerts}</TD>
                <TD>{u.telegram ? <CheckCircleOutlinedIcon sx={{ color: '#00c896', fontSize: 16 }} /> : <CloseOutlinedIcon sx={{ color: '#55556a', fontSize: 16 }} />}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}

      {tab === 1 && (
        <Table>
          <THead><TR><TH>Email</TH><TH>Tier</TH><TH>Amount</TH><TH>UTR Ref</TH><TH>Submitted</TH><TH>Actions</TH></TR></THead>
          <TBody>
            {PLACEHOLDER_PAYMENTS.map((p) => (
              <TR key={p.id}>
                <TD sx={{ color: '#8888a8' }}>{p.email}</TD>
                <TD>{p.tier}</TD>
                <TD className="tabular-nums">{p.amount}</TD>
                <TD sx={{ fontFamily: 'monospace', color: '#55556a' }}>{p.ref}</TD>
                <TD sx={{ color: '#55556a' }}>{p.submitted}</TD>
                <TD>
                  <Stack direction="row" spacing={0.75}>
                    <Button variant="contained" color="success" size="small" startIcon={<CheckOutlinedIcon />}>Approve</Button>
                    <Button variant="outlined" color="error" size="small" startIcon={<CloseOutlinedIcon />}>Reject</Button>
                  </Stack>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}

      {tab === 2 && (
        <Box>
          <Stack direction="row" justifyContent="flex-end" sx={{ mb: 2 }}>
            <Button variant="contained" startIcon={<AddOutlinedIcon />}>Generate Token</Button>
          </Stack>
          <Table>
            <THead><TR><TH>Token</TH><TH>Status</TH><TH>Used By</TH><TH>Created</TH></TR></THead>
            <TBody>
              {PLACEHOLDER_TOKENS.map((t) => (
                <TR key={t.id}>
                  <TD sx={{ fontFamily: 'monospace', color: '#4488ff' }}>{t.token}</TD>
                  <TD>
                    <Chip label={t.used ? 'Used' : 'Unused'} size="small" sx={{ borderRadius: '4px', fontWeight: 600, fontSize: '0.7rem', height: 20, ...(t.used ? { bgcolor: '#0d0d0d', color: '#55556a', border: '1px solid #2a2a2a' } : { bgcolor: '#001a12', color: '#00c896', border: '1px solid #00c896' }) }} />
                  </TD>
                  <TD sx={{ color: '#55556a' }}>{t.usedBy || '—'}</TD>
                  <TD sx={{ color: '#55556a' }}>{t.createdAt}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Box>
      )}
    </Box>
  )
}

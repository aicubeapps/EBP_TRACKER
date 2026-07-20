import { useState, useEffect } from 'react'
import { useAuth } from '@clerk/clerk-react'
import Box from '@mui/material/Box'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import Tabs from '@mui/material/Tabs'
import Tab from '@mui/material/Tab'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import { Table, THead, TBody, TR, TH, TD } from '../components/ui/Table.jsx'
import CheckOutlinedIcon from '@mui/icons-material/CheckOutlined'
import CloseOutlinedIcon from '@mui/icons-material/CloseOutlined'
import AddOutlinedIcon from '@mui/icons-material/AddOutlined'
import BlockOutlinedIcon from '@mui/icons-material/BlockOutlined'
import CheckCircleOutlinedIcon from '@mui/icons-material/CheckCircleOutlined'
import api from '../lib/api'

const PLAN_SX = {
  FREE:   { bgcolor: '#0d0d0d', color: '#8888a8', border: '1px solid #2a2a2a' },
  COFFEE: { bgcolor: '#1a1100', color: '#f5a623', border: '1px solid #f5a623' },
  BEER:   { bgcolor: '#001033', color: '#4488ff', border: '1px solid #4488ff' },
  WINE:   { bgcolor: '#110022', color: '#8855ff', border: '1px solid #8855ff' },
}

export default function Admin() {
  const { getToken }              = useAuth()
  const [tab, setTab]             = useState(0)
  const [isAdmin, setIsAdmin]     = useState(null)
  const [users, setUsers]         = useState([])
  const [payments, setPayments]   = useState([])
  const [tokens, setTokens]       = useState([])
  const [loading, setLoading]     = useState(true)

  useEffect(() => {
    (async () => {
      try {
        const token = await getToken()
        const me    = await api.get('/user/me', token)
        const admin = me.is_admin === 1
        setIsAdmin(admin)
        if (admin) {
          const [u, p, t] = await Promise.all([
            api.get('/admin/users',    token),
            api.get('/admin/payments', token),
            api.get('/admin/tokens',   token),
          ])
          setUsers(Array.isArray(u) ? u : [])
          setPayments(Array.isArray(p) ? p : [])
          setTokens(Array.isArray(t) ? t : [])
        }
      } catch (e) {
        console.error('Admin load error:', e)
        setIsAdmin(false)
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  const handleApprove = async (paymentId) => {
    const token = await getToken()
    await api.post(`/admin/approve/${paymentId}`, {}, token)
    const p = await api.get('/admin/payments', token)
    setPayments(Array.isArray(p) ? p : [])
  }

  const handleReject = async (paymentId) => {
    const token = await getToken()
    await api.post(`/admin/reject/${paymentId}`, {}, token)
    const p = await api.get('/admin/payments', token)
    setPayments(Array.isArray(p) ? p : [])
  }

  const handleGenerateToken = async () => {
    const token = await getToken()
    const data  = await api.post('/admin/invite', {}, token)
    alert(`New invite URL:\n${data.url}`)
    const t = await api.get('/admin/tokens', token)
    setTokens(Array.isArray(t) ? t : [])
  }

  const handleExpire = async (userId) => {
    if (!window.confirm('Expire this user account?')) return
    const token = await getToken()
    await api.post(`/admin/expire/${userId}`, {}, token)
    const u = await api.get('/admin/users', token)
    setUsers(Array.isArray(u) ? u : [])
  }

  if (loading) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center',
        justifyContent: 'center', py: 10 }}>
        <Typography variant="body2" color="text.secondary">
          Loading...
        </Typography>
      </Box>
    )
  }

  if (!isAdmin) {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', py: 10 }}>
        <BlockOutlinedIcon sx={{ fontSize: 48, color: '#ff4466', mb: 2 }} />
        <Typography variant="h4" sx={{ mb: 0.5 }}>Access Denied</Typography>
        <Typography variant="body2">
          This panel is restricted to administrators.
        </Typography>
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

      {/* Users Tab */}
      {tab === 0 && (
        <Table>
          <THead>
            <TR>
              <TH>Email</TH><TH>Plan</TH><TH>Expiry</TH>
              <TH>Assets</TH><TH>Alerts</TH><TH>Telegram</TH><TH>Actions</TH>
            </TR>
          </THead>
          <TBody>
            {users.length === 0 ? (
              <TR>
                <TD colSpan={7} sx={{ textAlign: 'center', color: '#55556a' }}>
                  No users yet
                </TD>
              </TR>
            ) : users.map(u => (
              <TR key={u.id}>
                <TD sx={{ color: '#8888a8' }}>
                  {u.email || u.id.slice(0, 16) + '...'}
                </TD>
                <TD>
                  <Chip
                    label={u.plan?.toUpperCase() ?? 'FREE'}
                    size="small"
                    sx={{
                      borderRadius: '4px', fontWeight: 700,
                      fontSize: '0.7rem', height: 20,
                      ...(PLAN_SX[u.plan?.toUpperCase()] ?? PLAN_SX.FREE),
                    }}
                  />
                </TD>
                <TD sx={{ color: '#55556a' }} className="tabular-nums">
                  {new Date(u.expires_at).toLocaleDateString()}
                </TD>
                <TD className="tabular-nums">{u.asset_count}</TD>
                <TD className="tabular-nums">{u.alert_count}</TD>
                <TD>
                  {u.telegram_verified
                    ? <CheckCircleOutlinedIcon sx={{ color: '#00c896', fontSize: 16 }} />
                    : <CloseOutlinedIcon sx={{ color: '#55556a', fontSize: 16 }} />
                  }
                </TD>
                <TD>
                  <Button variant="outlined" color="error" size="small"
                    startIcon={<BlockOutlinedIcon />}
                    onClick={() => handleExpire(u.id)}>
                    Expire
                  </Button>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}

      {/* Payments Tab */}
      {tab === 1 && (
        <Table>
          <THead>
            <TR>
              <TH>Email</TH><TH>Tier</TH><TH>Amount</TH>
              <TH>UTR Ref</TH><TH>Submitted</TH><TH>Actions</TH>
            </TR>
          </THead>
          <TBody>
            {payments.length === 0 ? (
              <TR>
                <TD colSpan={6} sx={{ textAlign: 'center', color: '#55556a' }}>
                  No payments yet
                </TD>
              </TR>
            ) : payments.map(p => (
              <TR key={p.id}>
                <TD sx={{ color: '#8888a8' }}>{p.email}</TD>
                <TD>{p.tier}</TD>
                <TD className="tabular-nums">₹{p.amount_inr}</TD>
                <TD sx={{ fontFamily: 'monospace', color: '#55556a' }}>
                  {p.upi_ref || '—'}
                </TD>
                <TD sx={{ color: '#55556a' }}>
                  {new Date(p.submitted_at).toLocaleDateString()}
                </TD>
                <TD>
                  {p.status === 'pending' ? (
                    <Stack direction="row" spacing={0.75}>
                      <Button variant="contained" color="success" size="small"
                        startIcon={<CheckOutlinedIcon />}
                        onClick={() => handleApprove(p.id)}>
                        Approve
                      </Button>
                      <Button variant="outlined" color="error" size="small"
                        startIcon={<CloseOutlinedIcon />}
                        onClick={() => handleReject(p.id)}>
                        Reject
                      </Button>
                    </Stack>
                  ) : (
                    <Chip
                      label={p.status.toUpperCase()} size="small"
                      sx={{
                        borderRadius: '4px', fontWeight: 600,
                        fontSize: '0.7rem', height: 20,
                        bgcolor: p.status === 'approved' ? '#001a12' : '#1a0008',
                        color:   p.status === 'approved' ? '#00c896' : '#ff4466',
                        border:  `1px solid ${p.status === 'approved' ? '#00c896' : '#ff4466'}`,
                      }}
                    />
                  )}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}

      {/* Invite Tokens Tab */}
      {tab === 2 && (
        <Box>
          <Stack direction="row" justifyContent="flex-end" sx={{ mb: 2 }}>
            <Button variant="contained" startIcon={<AddOutlinedIcon />}
              onClick={handleGenerateToken}>
              Generate Token
            </Button>
          </Stack>
          <Table>
            <THead>
              <TR>
                <TH>Token</TH><TH>Status</TH><TH>Used By</TH><TH>Created</TH>
              </TR>
            </THead>
            <TBody>
              {tokens.length === 0 ? (
                <TR>
                  <TD colSpan={4} sx={{ textAlign: 'center', color: '#55556a' }}>
                    No tokens yet
                  </TD>
                </TR>
              ) : tokens.map(t => (
                <TR key={t.token}>
                  <TD sx={{ fontFamily: 'monospace', color: '#4488ff' }}>
                    {t.token}
                  </TD>
                  <TD>
                    <Chip
                      label={t.used_by ? 'Used' : 'Unused'} size="small"
                      sx={{
                        borderRadius: '4px', fontWeight: 600,
                        fontSize: '0.7rem', height: 20,
                        ...(t.used_by
                          ? { bgcolor: '#0d0d0d', color: '#55556a', border: '1px solid #2a2a2a' }
                          : { bgcolor: '#001a12', color: '#00c896', border: '1px solid #00c896' }
                        ),
                      }}
                    />
                  </TD>
                  <TD sx={{ color: '#55556a' }}>{t.used_by || '—'}</TD>
                  <TD sx={{ color: '#55556a' }}>
                    {new Date(t.created_at).toLocaleDateString()}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Box>
      )}
    </Box>
  )
}

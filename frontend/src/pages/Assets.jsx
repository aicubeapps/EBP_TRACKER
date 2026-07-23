import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@clerk/clerk-react'
import Box from '@mui/material/Box'
import Card from '@mui/material/Card'
import CardContent from '@mui/material/CardContent'
import Stack from '@mui/material/Stack'
import Paper from '@mui/material/Paper'
import Typography from '@mui/material/Typography'
import TextField from '@mui/material/TextField'
import Select from '@mui/material/Select'
import MenuItem from '@mui/material/MenuItem'
import InputLabel from '@mui/material/InputLabel'
import FormControl from '@mui/material/FormControl'
import Button from '@mui/material/Button'
import IconButton from '@mui/material/IconButton'
import List from '@mui/material/List'
import ListItem from '@mui/material/ListItem'
import ListItemText from '@mui/material/ListItemText'
import Alert from '@mui/material/Alert'
import LinearProgress from '@mui/material/LinearProgress'
import Dialog from '@mui/material/Dialog'
import DialogTitle from '@mui/material/DialogTitle'
import DialogContent from '@mui/material/DialogContent'
import DialogActions from '@mui/material/DialogActions'
import Chip from '@mui/material/Chip'
import Skeleton from '@mui/material/Skeleton'
import InputAdornment from '@mui/material/InputAdornment'
import CircularProgress from '@mui/material/CircularProgress'
import Divider from '@mui/material/Divider'
import AddOutlined from '@mui/icons-material/AddOutlined'
import SearchOutlinedIcon from '@mui/icons-material/SearchOutlined'
import DeleteOutlineOutlinedIcon from '@mui/icons-material/DeleteOutlineOutlined'
import { useAssets } from '../hooks/useAssets.js'
import api from '../lib/api.js'
import { useUser } from '../hooks/useUser.js'
import { useTheme } from '@mui/material/styles'

const ASSET_TYPES   = ['Forex', 'Commodity', 'Index', 'NSE Asset', 'Crypto']
const ASSET_LIMIT_MAP = { free: 3, coffee: 5, beer: 15, wine: 30 }
const EBP_TFS       = ['M15', '1H', '4H', 'D', 'W']
const SWEEP_TFS     = ['M5', 'M15', 'M30', '1H', '4H']
const ALERT_MODES   = [
  { value: 'aligned',      label: 'Aligned' },
  { value: 'price_action', label: 'PA Only' },
  { value: 'all',          label: 'All' },
]
const T3_PAIRS = {
  '4H': ['1H', 'M30', 'M15'],
  '1H': ['M30', 'M15', 'M5'],
  'D':  ['4H', '1H'],
  'W':  ['D', '4H'],
}

function ModeChip({ mode }) {
  const label = { aligned: 'Aligned', price_action: 'PA', all: 'All' }[mode] ?? mode
  return (
    <Chip
      label={label}
      size="small"
      sx={{ borderRadius: '3px', fontSize: '0.6rem', height: 16, '& .MuiChip-label': { px: 0.75 } }}
    />
  )
}

function AssetConfigPanel({ asset, userPlan }) {
  const { getToken } = useAuth()
  const theme = useTheme()
  const [open, setOpen]         = useState(false)
  const [loading, setLoading]   = useState(false)
  const [ebpConfigs, setEbpConfigs]       = useState([])
  const [sweepConfigs, setSweepConfigs]   = useState([])
  const [templates, setTemplates]         = useState([])
  const [addingEbp, setAddingEbp]         = useState(false)
  const [newEbpTF, setNewEbpTF]           = useState('M15')
  const [newEbpMode, setNewEbpMode]       = useState('aligned')
  const [savingEbp, setSavingEbp]         = useState(false)
  const [addingSweep, setAddingSweep]     = useState(false)
  const [newSweepTF, setNewSweepTF]       = useState('M15')
  const [newSweepMode, setNewSweepMode]   = useState('aligned')
  const [savingSweep, setSavingSweep]     = useState(false)
  const [addingT3, setAddingT3]           = useState(false)
  const [newT3HTF, setNewT3HTF]           = useState('4H')
  const [newT3LTF, setNewT3LTF]           = useState('M15')
  const [newT3Win, setNewT3Win]           = useState(60)
  const [savingT3, setSavingT3]           = useState(false)

  const canUseTemplates = ['beer', 'wine', 'whiskey'].includes(userPlan)

  const load = async () => {
    setLoading(true)
    try {
      const token = await getToken()
      const [ebp, sweep, tmpl] = await Promise.all([
        api.get(`/user/ebp-configs/${asset.id}`, token),
        api.get(`/user/sweep-configs/${asset.id}`, token),
        api.get(`/user/templates/${asset.id}`, token),
      ])
      setEbpConfigs(Array.isArray(ebp) ? ebp : [])
      setSweepConfigs(Array.isArray(sweep) ? sweep : [])
      setTemplates(Array.isArray(tmpl) ? tmpl : [])
    } catch {}
    setLoading(false)
  }

  useEffect(() => { if (open) load() }, [open])

  const addEbpConfig = async () => {
    setSavingEbp(true)
    try {
      const token   = await getToken()
      const created = await api.post(`/user/ebp-configs/${asset.id}`, { timeframe: newEbpTF, alert_mode: newEbpMode }, token)
      setEbpConfigs(prev => [...prev, created])
      setAddingEbp(false)
    } catch {} finally { setSavingEbp(false) }
  }

  const deleteEbpConfig = async (id) => {
    const token = await getToken()
    await api.delete(`/user/ebp-config/${id}`, token)
    setEbpConfigs(prev => prev.filter(c => c.id !== id))
  }

  const addSweepConfig = async () => {
    setSavingSweep(true)
    try {
      const token   = await getToken()
      const created = await api.post(`/user/sweep-configs/${asset.id}`, { timeframe: newSweepTF, alert_mode: newSweepMode }, token)
      setSweepConfigs(prev => [...prev, created])
      setAddingSweep(false)
    } catch {} finally { setSavingSweep(false) }
  }

  const deleteSweepConfig = async (id) => {
    const token = await getToken()
    await api.delete(`/user/sweep-config/${id}`, token)
    setSweepConfigs(prev => prev.filter(c => c.id !== id))
  }

  const addT3Template = async () => {
    setSavingT3(true)
    try {
      const token   = await getToken()
      const created = await api.post(`/user/templates/${asset.id}`, {
        template: 't3', htf: newT3HTF, ltf: newT3LTF, window_mins: newT3Win, enabled: 1,
      }, token)
      setTemplates(prev => [...prev, created])
      setAddingT3(false)
    } catch {} finally { setSavingT3(false) }
  }

  const toggleTemplate = async (tmpl) => {
    const token = await getToken()
    await api.patch(`/user/template/${tmpl.id}`, { enabled: tmpl.enabled === 1 ? 0 : 1 }, token)
    setTemplates(prev => prev.map(t => t.id === tmpl.id ? { ...t, enabled: t.enabled === 1 ? 0 : 1 } : t))
  }

  const deleteTemplate = async (id) => {
    const token = await getToken()
    await api.delete(`/user/template/${id}`, token)
    setTemplates(prev => prev.filter(t => t.id !== id))
  }

  const validT3LTFs = T3_PAIRS[newT3HTF] ?? ['M15']

  return (
    <Box sx={{ mt: 0.5 }}>
      <Button size="small" variant="text"
        onClick={() => setOpen(o => !o)}
        sx={{
          color: theme.palette.primary.main, fontSize: '0.7rem',
          p: 0, minWidth: 0, justifyContent: 'flex-start',
          '&:hover': { bgcolor: 'transparent', textDecoration: 'underline' },
        }}
      >
        {open ? 'Hide' : 'Configure'} Alerts
      </Button>

      {open && (
        <Box sx={{
          mt: 1, p: 1.5,
          bgcolor: 'background.default',
          border: `1px solid ${theme.palette.divider}`,
          borderRadius: 1,
        }}>
          {loading ? <CircularProgress size={16} /> : (
            <Stack spacing={1.5}>

              {/* ── EBP Alerts ── */}
              <Box>
                <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 0.5 }}>
                  <Typography variant="caption" fontWeight={700} color="primary">EBP Alerts</Typography>
                  <Button size="small" onClick={() => setAddingEbp(a => !a)}
                    sx={{ fontSize: '0.65rem', minWidth: 0, p: 0, lineHeight: 1 }}>
                    {addingEbp ? 'Cancel' : '+ Add'}
                  </Button>
                </Stack>

                {ebpConfigs.length === 0 && !addingEbp && (
                  <Typography variant="caption" color="text.disabled">No EBP alerts configured.</Typography>
                )}

                <Stack spacing={0.5}>
                  {ebpConfigs.map(c => (
                    <Stack key={c.id} direction="row" alignItems="center" spacing={0.5}>
                      <Chip label={c.timeframe} size="small"
                        sx={{ borderRadius: '3px', fontSize: '0.65rem', height: 18, '& .MuiChip-label': { px: 0.75 } }} />
                      <ModeChip mode={c.alert_mode} />
                      <IconButton size="small" onClick={() => deleteEbpConfig(c.id)}
                        sx={{ p: 0.25, color: 'text.disabled', '&:hover': { color: 'error.main' } }}>
                        <DeleteOutlineOutlinedIcon sx={{ fontSize: 13 }} />
                      </IconButton>
                    </Stack>
                  ))}
                </Stack>

                {addingEbp && (
                  <Stack direction="row" spacing={0.75} alignItems="center" sx={{ mt: 0.75 }}>
                    <Select size="small" value={newEbpTF} onChange={e => setNewEbpTF(e.target.value)}
                      sx={{ minWidth: 68, fontSize: '0.75rem' }}>
                      {EBP_TFS.map(tf => <MenuItem key={tf} value={tf}>{tf}</MenuItem>)}
                    </Select>
                    <Select size="small" value={newEbpMode} onChange={e => setNewEbpMode(e.target.value)}
                      sx={{ minWidth: 86, fontSize: '0.75rem' }}>
                      {ALERT_MODES.map(m => <MenuItem key={m.value} value={m.value}>{m.label}</MenuItem>)}
                    </Select>
                    <Button size="small" variant="contained" onClick={addEbpConfig}
                      disabled={savingEbp}
                      startIcon={savingEbp ? <CircularProgress size={12} color="inherit" /> : null}
                      sx={{ fontSize: '0.7rem', py: 0.4, px: 1 }}>
                      Add
                    </Button>
                  </Stack>
                )}
              </Box>

              <Divider />

              {/* ── Sweep Alerts ── */}
              <Box>
                <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 0.5 }}>
                  <Typography variant="caption" fontWeight={700} color="secondary">Sweep Alerts</Typography>
                  <Button size="small" onClick={() => setAddingSweep(a => !a)}
                    sx={{ fontSize: '0.65rem', minWidth: 0, p: 0, lineHeight: 1 }}>
                    {addingSweep ? 'Cancel' : '+ Add'}
                  </Button>
                </Stack>

                {sweepConfigs.length === 0 && !addingSweep && (
                  <Typography variant="caption" color="text.disabled">No sweep alerts configured.</Typography>
                )}

                <Stack spacing={0.5}>
                  {sweepConfigs.map(c => (
                    <Stack key={c.id} direction="row" alignItems="center" spacing={0.5}>
                      <Chip label={c.timeframe} size="small"
                        sx={{ borderRadius: '3px', fontSize: '0.65rem', height: 18, '& .MuiChip-label': { px: 0.75 } }} />
                      <ModeChip mode={c.alert_mode} />
                      <IconButton size="small" onClick={() => deleteSweepConfig(c.id)}
                        sx={{ p: 0.25, color: 'text.disabled', '&:hover': { color: 'error.main' } }}>
                        <DeleteOutlineOutlinedIcon sx={{ fontSize: 13 }} />
                      </IconButton>
                    </Stack>
                  ))}
                </Stack>

                {addingSweep && (
                  <Stack direction="row" spacing={0.75} alignItems="center" sx={{ mt: 0.75 }}>
                    <Select size="small" value={newSweepTF} onChange={e => setNewSweepTF(e.target.value)}
                      sx={{ minWidth: 68, fontSize: '0.75rem' }}>
                      {SWEEP_TFS.map(tf => <MenuItem key={tf} value={tf}>{tf}</MenuItem>)}
                    </Select>
                    <Select size="small" value={newSweepMode} onChange={e => setNewSweepMode(e.target.value)}
                      sx={{ minWidth: 86, fontSize: '0.75rem' }}>
                      {ALERT_MODES.map(m => <MenuItem key={m.value} value={m.value}>{m.label}</MenuItem>)}
                    </Select>
                    <Button size="small" variant="contained" onClick={addSweepConfig}
                      disabled={savingSweep}
                      startIcon={savingSweep ? <CircularProgress size={12} color="inherit" /> : null}
                      sx={{ fontSize: '0.7rem', py: 0.4, px: 1 }}>
                      Add
                    </Button>
                  </Stack>
                )}
              </Box>

              <Divider />

              {/* ── Templates ── */}
              <Box>
                <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 0.5 }}>
                  <Typography variant="caption" fontWeight={700}
                    sx={{ color: canUseTemplates ? 'text.primary' : 'text.disabled' }}>
                    Templates (T3)
                  </Typography>
                  {canUseTemplates && (
                    <Button size="small" onClick={() => setAddingT3(a => !a)}
                      sx={{ fontSize: '0.65rem', minWidth: 0, p: 0, lineHeight: 1 }}>
                      {addingT3 ? 'Cancel' : '+ Add'}
                    </Button>
                  )}
                </Stack>

                {!canUseTemplates ? (
                  <Typography variant="caption" color="text.disabled">
                    Available on Beer plan and above.
                  </Typography>
                ) : (
                  <>
                    {templates.length === 0 && !addingT3 && (
                      <Typography variant="caption" color="text.disabled">No templates configured.</Typography>
                    )}

                    <Stack spacing={0.5}>
                      {templates.map(t => (
                        <Stack key={t.id} direction="row" alignItems="center" spacing={0.5}>
                          <Chip label="T3" size="small"
                            sx={{ borderRadius: '3px', fontSize: '0.6rem', height: 16, '& .MuiChip-label': { px: 0.75 },
                              bgcolor: `${theme.palette.warning.main}20`, color: 'warning.main',
                              border: `1px solid ${theme.palette.warning.main}44` }} />
                          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                            {t.htf} EBP → {t.ltf} Sweep/MSS
                          </Typography>
                          <Chip
                            label={t.enabled ? 'ON' : 'OFF'}
                            size="small"
                            onClick={() => toggleTemplate(t)}
                            sx={{
                              cursor: 'pointer', borderRadius: '3px', fontSize: '0.6rem',
                              height: 16, '& .MuiChip-label': { px: 0.75 },
                              bgcolor: t.enabled ? `${theme.palette.success.main}20` : 'transparent',
                              color: t.enabled ? 'success.main' : 'text.disabled',
                              border: `1px solid ${t.enabled ? theme.palette.success.main : theme.palette.divider}`,
                            }}
                          />
                          <IconButton size="small" onClick={() => deleteTemplate(t.id)}
                            sx={{ p: 0.25, color: 'text.disabled', '&:hover': { color: 'error.main' } }}>
                            <DeleteOutlineOutlinedIcon sx={{ fontSize: 13 }} />
                          </IconButton>
                        </Stack>
                      ))}
                    </Stack>

                    {addingT3 && (
                      <Box sx={{ mt: 0.75 }}>
                        <Stack direction="row" spacing={0.75} alignItems="center" sx={{ mb: 0.5 }}>
                          <Select size="small" value={newT3HTF}
                            onChange={e => { setNewT3HTF(e.target.value); setNewT3LTF((T3_PAIRS[e.target.value] ?? ['M15'])[0]) }}
                            sx={{ minWidth: 68, fontSize: '0.75rem' }}>
                            {Object.keys(T3_PAIRS).map(tf => <MenuItem key={tf} value={tf}>{tf} HTF</MenuItem>)}
                          </Select>
                          <Select size="small" value={newT3LTF} onChange={e => setNewT3LTF(e.target.value)}
                            sx={{ minWidth: 68, fontSize: '0.75rem' }}>
                            {validT3LTFs.map(tf => <MenuItem key={tf} value={tf}>{tf} LTF</MenuItem>)}
                          </Select>
                          <Select size="small" value={newT3Win} onChange={e => setNewT3Win(Number(e.target.value))}
                            sx={{ minWidth: 68, fontSize: '0.75rem' }}>
                            {[30, 60, 120, 240].map(m => <MenuItem key={m} value={m}>{m}m</MenuItem>)}
                          </Select>
                        </Stack>
                        <Button size="small" variant="contained" onClick={addT3Template}
                          disabled={savingT3}
                          startIcon={savingT3 ? <CircularProgress size={12} color="inherit" /> : null}
                          sx={{ fontSize: '0.7rem', py: 0.4, px: 1 }}>
                          Add T3
                        </Button>
                      </Box>
                    )}
                  </>
                )}
              </Box>

            </Stack>
          )}
        </Box>
      )}
    </Box>
  )
}

export default function Assets() {
  const theme = useTheme()
  const navigate = useNavigate()
  const { getToken } = useAuth()
  const { assets, loading, error, addAsset, removeAsset } = useAssets()

  const TYPE_SX = {
    Forex:       { bgcolor: `${theme.palette.primary.main}20`,   color: theme.palette.primary.main,   border: `1px solid ${theme.palette.primary.main}` },
    Commodity:   { bgcolor: `${theme.palette.warning.main}20`,   color: theme.palette.warning.main,   border: `1px solid ${theme.palette.warning.main}` },
    Index:       { bgcolor: `${theme.palette.secondary.main}20`, color: theme.palette.secondary.main, border: `1px solid ${theme.palette.secondary.main}` },
    'NSE Asset': { bgcolor: `${theme.palette.text.disabled}20`,  color: theme.palette.text.secondary, border: `1px solid ${theme.palette.divider}` },
    Crypto:      { bgcolor: `${theme.palette.warning.main}20`,   color: theme.palette.warning.main,   border: `1px solid ${theme.palette.warning.main}` },
  }

  const [searchQuery, setSearchQuery] = useState('')
  const [modalOpen, setModalOpen]     = useState(false)
  const [newSymbol, setNewSymbol]     = useState('')
  const [newType, setNewType]         = useState('Forex')
  const [adding, setAdding]           = useState(false)
  const [addError, setAddError]       = useState(null)

  const { user } = useUser()
  const maxSlots  = user?.asset_limit ?? 3
  const slotsUsed = assets.length
  const slotPct   = (slotsUsed / maxSlots) * 100
  const filtered  = assets.filter((a) =>
    (a.symbol || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
    (a.display_name || '').toLowerCase().includes(searchQuery.toLowerCase())
  )

  const handleAdd = async () => {
    if (!newSymbol.trim()) return
    setAdding(true)
    setAddError(null)
    try {
      await addAsset(newSymbol.trim(), newSymbol.trim(), newType.toLowerCase())
      setModalOpen(false)
      setNewSymbol('')
      setNewType('Forex')
    } catch (e) {
      setAddError(e.message)
    } finally {
      setAdding(false)
    }
  }

  return (
    <Box sx={{ maxWidth: 600 }}>
      {/* Search + Add */}
      <Stack direction="row" spacing={1} alignItems="stretch" sx={{ mb: 2 }}>
        <TextField
          placeholder="Search symbol e.g. EUR/USD, RELIANCE.NS"
          size="small"
          fullWidth
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchOutlinedIcon sx={{ fontSize: 16, color: 'text.disabled' }} />
              </InputAdornment>
            ),
          }}
        />
        <Button
          variant="contained"
          startIcon={<AddOutlined />}
          disabled={slotsUsed >= maxSlots || loading}
          onClick={() => setModalOpen(true)}
          sx={{ whiteSpace: 'nowrap', flexShrink: 0 }}
        >
          Add Asset
        </Button>
      </Stack>

      {/* Slot usage */}
      <Paper sx={{ p: 2, mb: 2 }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
          <Typography variant="body2" color="text.secondary">Asset slots used</Typography>
          <Typography variant="body2" fontWeight={600}>
            {slotsUsed} / {maxSlots}
          </Typography>
        </Stack>
        <LinearProgress variant="determinate" value={Math.min(slotPct, 100)} sx={{ height: 4, borderRadius: 2 }} />
        <Typography variant="caption" color="text.disabled" sx={{ mt: 0.75, display: 'block' }}>
          Upgrade to track more assets.
        </Typography>
      </Paper>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      {loading ? (
        <Stack spacing={1}>
          {[1,2,3].map(i => <Skeleton key={i} variant="rounded" height={56} />)}
        </Stack>
      ) : filtered.length === 0 ? (
        <Typography variant="body2" sx={{ textAlign: 'center', py: 4 }} color="text.disabled">
          No assets found.
        </Typography>
      ) : (
        <Paper variant="outlined">
          <List disablePadding>
            {filtered.map((asset, idx) => (
              <Box key={asset.id}>
                <ListItem
                  sx={{ py: 1, px: 1.5, alignItems: 'flex-start' }}
                  secondaryAction={
                    <IconButton
                      size="small" edge="end"
                      onClick={() => removeAsset(asset.id)}
                      sx={{ '&:hover': { color: '#ff4466' } }}
                    >
                      <DeleteOutlineOutlinedIcon fontSize="small" />
                    </IconButton>
                  }
                >
                  <ListItemText
                    disableTypography
                    primary={
                      <Stack direction="row" alignItems="center" spacing={1}>
                        <Typography variant="body1" fontWeight={700}
                          sx={{ fontFamily: 'monospace', letterSpacing: '-0.01em' }}>
                          {asset.symbol}
                        </Typography>
                        <Chip
                          label={asset.asset_type?.replace('_', ' ').toUpperCase()}
                          size="small"
                          sx={{
                            borderRadius: '3px', fontSize: '0.6rem', fontWeight: 600,
                            height: 16,
                            '& .MuiChip-label': { px: 0.75 },
                            ...(TYPE_SX[asset.asset_type] || TYPE_SX['NSE Asset']),
                          }}
                        />
                      </Stack>
                    }
                    secondary={
                      <AssetConfigPanel asset={asset} userPlan={user?.plan ?? 'free'} />
                    }
                  />
                </ListItem>
                {idx < filtered.length - 1 && (
                  <Box sx={{ borderBottom: `1px solid ${theme.palette.divider}` }} />
                )}
              </Box>
            ))}
          </List>
        </Paper>
      )}

      {slotsUsed >= maxSlots && (
        <Card sx={{ border: `1px solid ${theme.palette.warning.main}`, mt: 2, bgcolor: `${theme.palette.warning.main}10` }}>
          <CardContent sx={{ textAlign: 'center', py: 3 }}>
            <Typography variant="body1" sx={{ color: 'warning.main', mb: 1 }}>
              All {maxSlots} slots used
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Upgrade to track more assets and receive more alerts
            </Typography>
            <Button variant="contained" onClick={() => navigate('/upgrade')}>
              View Plans
            </Button>
          </CardContent>
        </Card>
      )}

      <Dialog open={modalOpen} onClose={() => !adding && setModalOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>Add Asset</DialogTitle>
        <DialogContent>
          <Stack spacing={2.5} sx={{ mt: 1 }}>
            {addError && <Alert severity="error">{addError}</Alert>}
            <TextField
              label="Symbol"
              fullWidth
              value={newSymbol}
              onChange={(e) => setNewSymbol(e.target.value.toUpperCase())}
              placeholder="e.g. EURUSD, RELIANCE, BTCUSDT"
              inputProps={{ style: { fontFamily: 'monospace' } }}
              disabled={adding}
            />
            <FormControl fullWidth size="small">
              <InputLabel>Asset Type</InputLabel>
              <Select value={newType} label="Asset Type" onChange={(e) => setNewType(e.target.value)} disabled={adding}>
                {ASSET_TYPES.map((t) => <MenuItem key={t} value={t}>{t}</MenuItem>)}
              </Select>
            </FormControl>
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button variant="text" onClick={() => setModalOpen(false)} disabled={adding}>Cancel</Button>
          <Button
            variant="contained"
            onClick={handleAdd}
            disabled={!newSymbol.trim() || adding}
            startIcon={adding ? <CircularProgress size={14} color="inherit" /> : null}
          >
            {adding ? 'Validating…' : 'Add'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}

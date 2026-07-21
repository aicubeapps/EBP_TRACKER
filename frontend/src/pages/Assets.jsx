import { useState } from 'react'
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
import Slider from '@mui/material/Slider'
import Switch from '@mui/material/Switch'
import SearchOutlinedIcon from '@mui/icons-material/SearchOutlined'
import DeleteOutlineOutlinedIcon from '@mui/icons-material/DeleteOutlineOutlined'
import AddOutlinedIcon from '@mui/icons-material/AddOutlined'
import { useAssets } from '../hooks/useAssets.js'
import api from '../lib/api.js'

const ASSET_TYPES = ['Forex', 'Commodity', 'Index', 'NSE Asset', 'Crypto']

const TYPE_SX = {
  Forex:       { bgcolor: '#001033', color: '#4488ff', border: '1px solid #4488ff' },
  Commodity:   { bgcolor: '#1a1100', color: '#f5a623', border: '1px solid #f5a623' },
  Index:       { bgcolor: '#110022', color: '#8855ff', border: '1px solid #8855ff' },
  'NSE Asset': { bgcolor: '#0d0d0d', color: '#8888a8', border: '1px solid #2a2a2a' },
  Crypto:      { bgcolor: '#1a1100', color: '#f5a623', border: '1px solid #f5a623' },
}

const ASSET_LIMIT_MAP = { free: 3, coffee: 5, beer: 15, wine: 30 }

const VALID_PAIRS = {
  'W':   ['4H', '1H', 'M30'],
  'D':   ['4H', '1H', 'M30'],
  '4H':  ['1H', 'M30', 'M15', 'M5'],
  '1H':  ['M30', 'M15', 'M5'],
  'M15': ['M5'],
}

function CombinedPairBuilder({ asset, onSave }) {
  const [open, setOpen]       = useState(false)
  const [enabled, setEnabled] = useState(asset.combined_enabled === 1)
  const [pairs, setPairs]     = useState(() => {
    try { return JSON.parse(asset.combined_pairs ?? '[]') } catch { return [] }
  })
  const [window_, setWindow]  = useState(asset.combined_window_mins ?? 60)
  const [htf, setHtf]         = useState('4H')
  const [ltf, setLtf]         = useState('M15')
  const [saving, setSaving]   = useState(false)

  const validLTFs = VALID_PAIRS[htf] ?? []

  const addPair = () => {
    if (pairs.find(p => p.htf === htf && p.ltf === ltf)) return
    setPairs(prev => [...prev, { htf, ltf }])
  }

  const removePair = (idx) => {
    setPairs(prev => prev.filter((_, i) => i !== idx))
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      await onSave(asset.id, { enabled, pairs, windowMins: window_ })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Box sx={{ mt: 1 }}>
      <Button
        size="small" variant="text"
        onClick={() => setOpen(o => !o)}
        sx={{ color: '#8855ff', fontSize: '0.7rem', p: 0 }}
        startIcon={<span>⚡</span>}
      >
        {open ? 'Hide' : 'Configure'} Combined Signals
      </Button>

      {open && (
        <Box sx={{
          mt: 1, p: 2,
          bgcolor: '#0a0a12',
          border: '1px solid #2a2a3a',
          borderRadius: 1,
        }}>
          <Stack spacing={2}>
            <Stack direction="row" justifyContent="space-between" alignItems="center">
              <Typography variant="body2">Combined Signal Alerts</Typography>
              <Switch
                size="small"
                checked={enabled}
                onChange={e => setEnabled(e.target.checked)}
              />
            </Stack>

            {enabled && (
              <>
                <Box>
                  <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
                    Add HTF EBP → LTF Sweep pair
                  </Typography>
                  <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                    <Select
                      size="small" value={htf}
                      onChange={e => {
                        setHtf(e.target.value)
                        setLtf(VALID_PAIRS[e.target.value]?.[0] ?? 'M15')
                      }}
                      sx={{ minWidth: 80, fontSize: '0.8rem' }}
                    >
                      {['W', 'D', '4H', '1H', 'M15'].map(t => (
                        <MenuItem key={t} value={t}>{t} EBP</MenuItem>
                      ))}
                    </Select>
                    <Typography variant="caption" color="text.secondary">→</Typography>
                    <Select
                      size="small" value={ltf}
                      onChange={e => setLtf(e.target.value)}
                      sx={{ minWidth: 80, fontSize: '0.8rem' }}
                    >
                      {validLTFs.map(t => (
                        <MenuItem key={t} value={t}>{t} Sweep</MenuItem>
                      ))}
                    </Select>
                    <Button
                      size="small" variant="outlined"
                      onClick={addPair}
                      disabled={!validLTFs.length}
                      sx={{ fontSize: '0.7rem' }}
                    >
                      Add
                    </Button>
                  </Stack>
                </Box>

                {pairs.length > 0 && (
                  <Box>
                    <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 0.5 }}>
                      Active pairs
                    </Typography>
                    <Stack spacing={0.5}>
                      {pairs.map((p, i) => (
                        <Box key={i}>
                          <Chip
                            label={`${p.htf} EBP → ${p.ltf} Sweep`}
                            size="small"
                            onDelete={() => removePair(i)}
                            sx={{
                              borderRadius: '4px', fontSize: '0.7rem',
                              bgcolor: '#1a0a2a', color: '#8855ff',
                              border: '1px solid #8855ff44',
                            }}
                          />
                        </Box>
                      ))}
                    </Stack>
                  </Box>
                )}

                <Box>
                  <Typography variant="caption" color="text.secondary">
                    Confluence window: {window_} minutes
                  </Typography>
                  <Slider
                    value={window_}
                    onChange={(_, v) => setWindow(v)}
                    min={15} max={240} step={15}
                    marks={[
                      { value: 15, label: '15m' },
                      { value: 60, label: '1h' },
                      { value: 120, label: '2h' },
                      { value: 240, label: '4h' },
                    ]}
                    sx={{
                      color: '#8855ff',
                      '& .MuiSlider-markLabel': { fontSize: '0.6rem', color: '#55556a' },
                    }}
                  />
                </Box>
              </>
            )}

            <Button
              variant="contained" size="small"
              onClick={handleSave} disabled={saving}
              startIcon={saving ? <CircularProgress size={12} /> : null}
              sx={{ alignSelf: 'flex-start', bgcolor: '#8855ff', '&:hover': { bgcolor: '#9966ff' } }}
            >
              {saving ? 'Saving...' : 'Save'}
            </Button>
          </Stack>
        </Box>
      )}
    </Box>
  )
}

export default function Assets() {
  const navigate = useNavigate()
  const { getToken } = useAuth()
  const { assets, loading, error, addAsset, removeAsset, refetch } = useAssets()
  const [search, setSearch]       = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [newSymbol, setNewSymbol] = useState('')
  const [newType, setNewType]     = useState('Forex')
  const [adding, setAdding]       = useState(false)
  const [addError, setAddError]   = useState(null)

  const maxSlots  = ASSET_LIMIT_MAP['free']
  const slotsUsed = assets.length
  const slotPct   = (slotsUsed / maxSlots) * 100
  const filtered  = assets.filter((a) =>
    (a.symbol || '').toLowerCase().includes(search.toLowerCase()) ||
    (a.display_name || '').toLowerCase().includes(search.toLowerCase())
  )

  const handleAdd = async () => {
    if (!newSymbol.trim()) return
    setAdding(true)
    setAddError(null)
    try {
      await addAsset({ symbol: newSymbol.trim(), display_name: newSymbol.trim(), asset_type: newType })
      setModalOpen(false)
      setNewSymbol('')
      setNewType('Forex')
    } catch (e) {
      setAddError(e.message)
    } finally {
      setAdding(false)
    }
  }

  const handleSaveCombined = async (id, config) => {
    const token = await getToken()
    await api.patch(`/user/assets/${id}/combined`, config, token)
    await refetch()
  }

  return (
    <Box sx={{ maxWidth: 600 }}>
      <Stack direction="row" spacing={1.5} sx={{ mb: 2.5 }}>
        <TextField
          fullWidth size="small"
          placeholder="Search symbol e.g. EURUSD, RELIANCE, BTC"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          InputProps={{
            startAdornment: <InputAdornment position="start"><SearchOutlinedIcon sx={{ fontSize: 16, color: '#55556a' }} /></InputAdornment>,
          }}
        />
        <Button
          variant="contained"
          startIcon={<AddOutlinedIcon />}
          disabled={slotsUsed >= maxSlots || loading}
          onClick={() => setModalOpen(true)}
          sx={{ whiteSpace: 'nowrap' }}
        >
          Add Asset
        </Button>
      </Stack>

      <Paper sx={{ p: 2, mb: 2.5, border: '1px solid #1a1a1a' }}>
        <Stack direction="row" justifyContent="space-between" sx={{ mb: 1 }}>
          <Typography variant="body2">Slot usage</Typography>
          <Typography variant="caption" className="tabular-nums" sx={{ color: '#e8e8f0' }}>
            {slotsUsed} / {maxSlots} slots used
          </Typography>
        </Stack>
        <LinearProgress variant="determinate" value={Math.min(slotPct, 100)} sx={{ height: 4, borderRadius: 2 }} />
        <Typography variant="caption" sx={{ mt: 1, display: 'block' }}>Upgrade your plan to track more assets.</Typography>
      </Paper>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      {loading ? (
        <Stack spacing={1}>
          {[1,2,3].map(i => <Skeleton key={i} variant="rounded" height={56} sx={{ bgcolor: '#0d0d0d' }} />)}
        </Stack>
      ) : filtered.length === 0 ? (
        <Typography variant="body2" sx={{ textAlign: 'center', py: 4 }}>No assets found.</Typography>
      ) : (
        <Paper sx={{ border: '1px solid #1a1a1a' }}>
          <List disablePadding>
            {filtered.map((asset, idx) => (
              <Box key={asset.id}>
                <ListItem
                  divider={false}
                  sx={{ px: 2, py: 1.5 }}
                  secondaryAction={
                    <IconButton size="small" edge="end" onClick={() => removeAsset(asset.id)} sx={{ '&:hover': { color: '#ff4466' } }}>
                      <DeleteOutlineOutlinedIcon fontSize="small" />
                    </IconButton>
                  }
                >
                  <ListItemText
                    primary={
                      <Stack direction="row" alignItems="center" spacing={1.5}>
                        <Typography variant="body1" sx={{ fontWeight: 600, color: '#e8e8f0' }} className="tabular-nums">
                          {asset.symbol}
                        </Typography>
                        <Chip
                          label={asset.asset_type}
                          size="small"
                          sx={{ borderRadius: '4px', fontWeight: 600, fontSize: '0.7rem', height: 20, ...(TYPE_SX[asset.asset_type] || TYPE_SX['NSE Asset']) }}
                        />
                      </Stack>
                    }
                  />
                </ListItem>
                <Box sx={{ px: 2, pb: 1.5 }}>
                  <CombinedPairBuilder
                    asset={asset}
                    onSave={handleSaveCombined}
                  />
                </Box>
                {idx < filtered.length - 1 && (
                  <Box sx={{ borderBottom: '1px solid #1a1a1a' }} />
                )}
              </Box>
            ))}
          </List>
        </Paper>
      )}

      {slotsUsed >= maxSlots && (
        <Card sx={{ border: '1px solid #f5a623', mt: 2, bgcolor: '#1a1100' }}>
          <CardContent sx={{ textAlign: 'center', py: 3 }}>
            <Typography variant="body1" sx={{ color: '#f5a623', mb: 1 }}>
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

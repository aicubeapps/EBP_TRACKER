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
import AddOutlined from '@mui/icons-material/AddOutlined'
import SearchOutlinedIcon from '@mui/icons-material/SearchOutlined'
import DeleteOutlineOutlinedIcon from '@mui/icons-material/DeleteOutlineOutlined'
import { useAssets } from '../hooks/useAssets.js'
import api from '../lib/api.js'
import { useUser } from '../hooks/useUser.js'
import { useTheme } from '@mui/material/styles'

const ASSET_TYPES = ['Forex', 'Commodity', 'Index', 'NSE Asset', 'Crypto']

const ASSET_LIMIT_MAP = { free: 3, coffee: 5, beer: 15, wine: 30 }

const VALID_PAIRS = {
  'W':   ['4H', '1H', 'M30'],
  'D':   ['4H', '1H', 'M30'],
  '4H':  ['1H', 'M30', 'M15', 'M5'],
  '1H':  ['M30', 'M15', 'M5'],
  'M15': ['M5'],
}

function CombinedPairBuilder({ asset, onSave }) {
  const theme = useTheme()
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
    <Box>
      <Button
        size="small" variant="text"
        onClick={() => setOpen(o => !o)}
        sx={{
          color: theme.palette.secondary.main, fontSize: '0.7rem',
          p: 0, mt: 0.5, minWidth: 0,
          justifyContent: 'flex-start',
          '&:hover': { bgcolor: 'transparent', textDecoration: 'underline' },
        }}
        startIcon={<span style={{ fontSize: '0.8rem' }}>⚡</span>}
      >
        {open ? 'Hide' : 'Configure'} Combined Signals
      </Button>

      {open && (
        <Box sx={{
          mt: 1, p: 1.5,
          bgcolor: 'background.default',
          border: `1px solid ${theme.palette.divider}`,
          borderRadius: 1,
        }}>
          <Stack spacing={1.5}>
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
                              bgcolor: `${theme.palette.secondary.main}20`,
                              color: theme.palette.secondary.main,
                              border: `1px solid ${theme.palette.secondary.main}44`,
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
                      color: theme.palette.secondary.main,
                      '& .MuiSlider-markLabel': { fontSize: '0.6rem', color: theme.palette.text.disabled },
                    }}
                  />
                </Box>
              </>
            )}

            <Button
              variant="contained" size="small"
              onClick={handleSave} disabled={saving}
              startIcon={saving ? <CircularProgress size={12} /> : null}
              sx={{ alignSelf: 'flex-start' }}
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
  const theme = useTheme()
  const navigate = useNavigate()
  const { getToken } = useAuth()
  const { assets, loading, error, addAsset, removeAsset, refetch } = useAssets()

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

  const handleSaveCombined = async (id, config) => {
    const token = await getToken()
    await api.patch(`/user/assets/${id}/combined`, config, token)
    await refetch()
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
                      <CombinedPairBuilder asset={asset} onSave={handleSaveCombined} />
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

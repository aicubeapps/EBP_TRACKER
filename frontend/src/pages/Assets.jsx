import { useState } from 'react'
import Box from '@mui/material/Box'
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
import InputAdornment from '@mui/material/InputAdornment'
import SearchOutlinedIcon from '@mui/icons-material/SearchOutlined'
import DeleteOutlineOutlinedIcon from '@mui/icons-material/DeleteOutlineOutlined'
import AddOutlinedIcon from '@mui/icons-material/AddOutlined'

const ASSET_TYPES = ['Forex', 'Commodity', 'Index', 'NSE Asset', 'Crypto']
const MAX_SLOTS = 3

const TYPE_SX = {
  Forex:       { bgcolor: '#001033', color: '#4488ff', border: '1px solid #4488ff' },
  Commodity:   { bgcolor: '#1a1100', color: '#f5a623', border: '1px solid #f5a623' },
  Index:       { bgcolor: '#110022', color: '#8855ff', border: '1px solid #8855ff' },
  'NSE Asset': { bgcolor: '#0d0d0d', color: '#8888a8', border: '1px solid #2a2a2a' },
  Crypto:      { bgcolor: '#1a1100', color: '#f5a623', border: '1px solid #f5a623' },
}

const PLACEHOLDER_ASSETS = [
  { id: 1, symbol: 'EURUSD', type: 'Forex' },
  { id: 2, symbol: 'XAUUSD', type: 'Commodity' },
  // placeholder only — real data from Worker
]

export default function Assets() {
  const [search, setSearch] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [newSymbol, setNewSymbol] = useState('')
  const [newType, setNewType] = useState('Forex')
  const [assets] = useState(PLACEHOLDER_ASSETS)

  const filtered = assets.filter((a) => a.symbol.toLowerCase().includes(search.toLowerCase()))
  const slotsUsed = assets.length
  const slotPct = (slotsUsed / MAX_SLOTS) * 100

  return (
    <Box sx={{ maxWidth: 600 }}>
      {/* Search + Add */}
      <Stack direction="row" spacing={1.5} sx={{ mb: 2.5 }}>
        <TextField
          fullWidth
          size="small"
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
          disabled={slotsUsed >= MAX_SLOTS}
          onClick={() => setModalOpen(true)}
          sx={{ whiteSpace: 'nowrap' }}
        >
          Add Asset
        </Button>
      </Stack>

      {/* Slot usage */}
      <Paper sx={{ p: 2, mb: 2.5, border: '1px solid #1a1a1a' }}>
        <Stack direction="row" justifyContent="space-between" sx={{ mb: 1 }}>
          <Typography variant="body2">Slot usage</Typography>
          <Typography variant="caption" className="tabular-nums" sx={{ color: '#e8e8f0' }}>
            {slotsUsed} / {MAX_SLOTS} slots used
          </Typography>
        </Stack>
        <LinearProgress variant="determinate" value={Math.min(slotPct, 100)} sx={{ height: 4, borderRadius: 2 }} />
        <Typography variant="caption" sx={{ mt: 1, display: 'block' }}>Upgrade your plan to track more assets.</Typography>
      </Paper>

      {slotsUsed >= MAX_SLOTS && (
        <Alert severity="warning" sx={{ mb: 2 }}>Slot limit reached. Upgrade to add more assets.</Alert>
      )}

      {/* Asset list */}
      {filtered.length === 0 ? (
        <Typography variant="body2" sx={{ textAlign: 'center', py: 4 }}>No assets found.</Typography>
      ) : (
        <Paper sx={{ border: '1px solid #1a1a1a' }}>
          <List disablePadding>
            {filtered.map((asset, idx) => (
              <ListItem
                key={asset.id}
                divider={idx < filtered.length - 1}
                sx={{ px: 2, py: 1.5 }}
                secondaryAction={
                  <IconButton size="small" edge="end" sx={{ '&:hover': { color: '#ff4466' } }}>
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
                      <Chip label={asset.type} size="small" sx={{ borderRadius: '4px', fontWeight: 600, fontSize: '0.7rem', height: 20, ...TYPE_SX[asset.type] }} />
                    </Stack>
                  }
                />
              </ListItem>
            ))}
          </List>
        </Paper>
      )}

      {/* Add Asset Dialog */}
      <Dialog open={modalOpen} onClose={() => setModalOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>Add Asset</DialogTitle>
        <DialogContent>
          <Stack spacing={2.5} sx={{ mt: 1 }}>
            <TextField
              label="Symbol"
              fullWidth
              value={newSymbol}
              onChange={(e) => setNewSymbol(e.target.value.toUpperCase())}
              placeholder="e.g. EURUSD, RELIANCE, BTCUSDT"
              inputProps={{ style: { fontFamily: 'monospace' } }}
            />
            <FormControl fullWidth size="small">
              <InputLabel>Asset Type</InputLabel>
              <Select value={newType} label="Asset Type" onChange={(e) => setNewType(e.target.value)}>
                {ASSET_TYPES.map((t) => <MenuItem key={t} value={t}>{t}</MenuItem>)}
              </Select>
            </FormControl>
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button variant="text" onClick={() => setModalOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={() => setModalOpen(false)} disabled={!newSymbol}>Add</Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}

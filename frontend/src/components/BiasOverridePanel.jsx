import { Box, Stack, Select, MenuItem, Typography } from '@mui/material';

const BIAS_TFS     = ['W', 'D', '4H', '1H'];
const BIAS_OPTIONS = ['auto', 'bullish', 'bearish', 'neutral'];

export default function BiasOverridePanel({ overrides, onChange }) {
  return (
    <Box sx={{ ml: 3, mt: 1, mb: 1 }}>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
        Override HTF bias per timeframe
      </Typography>
      {BIAS_TFS.map(tf => (
        <Stack key={tf} direction="row" alignItems="center" spacing={2} sx={{ mt: 0.5 }}>
          <Typography variant="body2" sx={{ width: 32 }}>{tf}:</Typography>
          <Select
            size="small"
            value={overrides?.[tf] ?? 'auto'}
            onChange={e => onChange(tf, e.target.value)}
            sx={{ minWidth: 110, fontSize: '0.8rem' }}
          >
            {BIAS_OPTIONS.map(opt => (
              <MenuItem key={opt} value={opt}>
                {opt.charAt(0).toUpperCase() + opt.slice(1)}
              </MenuItem>
            ))}
          </Select>
        </Stack>
      ))}
    </Box>
  );
}

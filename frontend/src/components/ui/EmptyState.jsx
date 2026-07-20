import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import Paper from '@mui/material/Paper'

export default function EmptyState({ icon: Icon, title, description, action }) {
  return (
    <Paper sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', py: 8, px: 4, textAlign: 'center', border: '1px solid #1a1a1a' }}>
      {Icon && (
        <Box sx={{ width: 48, height: 48, borderRadius: 2, bgcolor: '#0d0d0d', border: '1px solid #1a1a1a', display: 'flex', alignItems: 'center', justifyContent: 'center', mb: 2 }}>
          <Icon size={20} color="#55556a" />
        </Box>
      )}
      <Typography variant="h5" sx={{ mb: 0.5, color: '#e8e8f0' }}>{title}</Typography>
      {description && (
        <Typography variant="body2" sx={{ maxWidth: 320, mb: action ? 2 : 0 }}>{description}</Typography>
      )}
      {action}
    </Paper>
  )
}

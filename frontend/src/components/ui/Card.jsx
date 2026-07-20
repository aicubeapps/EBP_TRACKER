import MuiCard from '@mui/material/Card'
import CardContent from '@mui/material/CardContent'

export default function Card({ children, sx = {}, contentSx = {} }) {
  return (
    <MuiCard sx={sx}>
      <CardContent sx={{ p: 2, '&:last-child': { pb: 2 }, ...contentSx }}>
        {children}
      </CardContent>
    </MuiCard>
  )
}

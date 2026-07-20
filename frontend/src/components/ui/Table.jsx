import MuiTable from '@mui/material/Table'
import TableContainer from '@mui/material/TableContainer'
import MuiTableHead from '@mui/material/TableHead'
import MuiTableBody from '@mui/material/TableBody'
import MuiTableRow from '@mui/material/TableRow'
import MuiTableCell from '@mui/material/TableCell'
import Paper from '@mui/material/Paper'

export function Table({ children, sx = {} }) {
  return (
    <TableContainer component={Paper} sx={{ border: '1px solid #1a1a1a', ...sx }}>
      <MuiTable size="small">{children}</MuiTable>
    </TableContainer>
  )
}

export function THead({ children }) {
  return <MuiTableHead>{children}</MuiTableHead>
}

export function TBody({ children }) {
  return <MuiTableBody>{children}</MuiTableBody>
}

export function TR({ children, sx = {} }) {
  return <MuiTableRow sx={sx}>{children}</MuiTableRow>
}

export function TH({ children, sx = {} }) {
  return <MuiTableCell component="th" sx={sx}>{children}</MuiTableCell>
}

export function TD({ children, sx = {} }) {
  return <MuiTableCell sx={{ color: '#e8e8f0', ...sx }}>{children}</MuiTableCell>
}

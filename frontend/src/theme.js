import { createTheme } from '@mui/material/styles';

const theme = createTheme({
  palette: {
    mode: 'dark',
    background: {
      default: '#000000',
      paper: '#0a0a0a',
    },
    primary: {
      main: '#4488ff',
      contrastText: '#ffffff',
    },
    secondary: {
      main: '#8855ff',
    },
    success: {
      main: '#00c896',
    },
    error: {
      main: '#ff4466',
    },
    warning: {
      main: '#f5a623',
    },
    divider: '#1a1a1a',
    text: {
      primary: '#e8e8f0',
      secondary: '#8888a8',
      disabled: '#55556a',
    },
  },
  typography: {
    fontFamily: '"Inter", "Roboto", "Helvetica", "Arial", sans-serif',
    fontWeightLight: 300,
    fontWeightRegular: 400,
    fontWeightMedium: 500,
    fontWeightBold: 700,
    h1: { fontSize: '2rem', fontWeight: 700, letterSpacing: '-0.02em' },
    h2: { fontSize: '1.5rem', fontWeight: 700, letterSpacing: '-0.01em' },
    h3: { fontSize: '1.25rem', fontWeight: 600 },
    h4: { fontSize: '1rem', fontWeight: 600 },
    h5: { fontSize: '0.875rem', fontWeight: 600 },
    h6: { fontSize: '0.75rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em' },
    body1: { fontSize: '0.875rem' },
    body2: { fontSize: '0.8125rem', color: '#8888a8' },
    caption: { fontSize: '0.75rem', color: '#55556a' },
    overline: { fontSize: '0.6875rem', fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase' },
  },
  shape: {
    borderRadius: 8,
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: {
          backgroundColor: '#000000',
          backgroundImage: 'none',
          scrollbarColor: '#1a1a1a #000000',
          '&::-webkit-scrollbar': { width: '6px' },
          '&::-webkit-scrollbar-track': { background: '#000000' },
          '&::-webkit-scrollbar-thumb': { background: '#2a2a2a', borderRadius: '3px' },
        },
      },
    },
    MuiCard: {
      styleOverrides: {
        root: {
          backgroundColor: '#0a0a0a',
          backgroundImage: 'none',
          border: '1px solid #1a1a1a',
          borderRadius: 8,
          '&:hover': {
            borderColor: '#2a2a2a',
            boxShadow: '0 0 0 1px #2a2a2a',
          },
        },
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: 'none',
          backgroundColor: '#0a0a0a',
          border: '1px solid #1a1a1a',
        },
      },
    },
    MuiButton: {
      styleOverrides: {
        root: {
          textTransform: 'none',
          fontWeight: 500,
          borderRadius: 6,
          fontSize: '0.875rem',
        },
        containedPrimary: {
          background: 'linear-gradient(135deg, #4488ff 0%, #3366dd 100%)',
          '&:hover': {
            background: 'linear-gradient(135deg, #5599ff 0%, #4477ee 100%)',
          },
        },
      },
    },
    MuiIconButton: {
      styleOverrides: {
        root: {
          color: '#8888a8',
          '&:hover': { color: '#e8e8f0', backgroundColor: '#1a1a1a' },
        },
      },
    },
    MuiTextField: {
      defaultProps: { variant: 'outlined', size: 'small' },
      styleOverrides: {
        root: {
          '& .MuiOutlinedInput-root': {
            backgroundColor: '#0a0a0a',
            '& fieldset': { borderColor: '#2a2a2a' },
            '&:hover fieldset': { borderColor: '#4488ff' },
            '&.Mui-focused fieldset': { borderColor: '#4488ff' },
          },
        },
      },
    },
    MuiSelect: {
      styleOverrides: {
        root: {
          backgroundColor: '#0a0a0a',
        },
      },
    },
    MuiTableCell: {
      styleOverrides: {
        root: {
          borderBottom: '1px solid #1a1a1a',
          fontSize: '0.8125rem',
        },
        head: {
          backgroundColor: '#000000',
          color: '#8888a8',
          fontWeight: 600,
          fontSize: '0.6875rem',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
        },
      },
    },
    MuiTableRow: {
      styleOverrides: {
        root: {
          '&:hover': { backgroundColor: '#0d0d0d' },
          '&:last-child td': { borderBottom: 0 },
        },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: {
          borderRadius: 4,
          fontSize: '0.75rem',
          fontWeight: 600,
          height: 22,
        },
      },
    },
    MuiDialog: {
      styleOverrides: {
        paper: {
          backgroundColor: '#0a0a0a',
          border: '1px solid #2a2a2a',
          borderRadius: 12,
        },
      },
    },
    MuiDrawer: {
      styleOverrides: {
        paper: {
          backgroundColor: '#000000',
          borderRight: '1px solid #1a1a1a',
        },
      },
    },
    MuiListItemButton: {
      styleOverrides: {
        root: {
          borderRadius: 6,
          margin: '2px 8px',
          '&.Mui-selected': {
            backgroundColor: '#0d1a33',
            borderLeft: '2px solid #4488ff',
            color: '#e8e8f0',
            '&:hover': { backgroundColor: '#0d1a33' },
          },
          '&:hover': { backgroundColor: '#0d0d0d' },
        },
      },
    },
    MuiDivider: {
      styleOverrides: {
        root: { borderColor: '#1a1a1a' },
      },
    },
    MuiTooltip: {
      styleOverrides: {
        tooltip: {
          backgroundColor: '#1a1a1a',
          border: '1px solid #2a2a2a',
          fontSize: '0.75rem',
          borderRadius: 4,
        },
      },
    },
    MuiAlert: {
      styleOverrides: {
        root: {
          borderRadius: 8,
          border: '1px solid',
        },
        standardSuccess: {
          backgroundColor: '#001a12',
          borderColor: '#00c896',
          color: '#00c896',
        },
        standardError: {
          backgroundColor: '#1a0008',
          borderColor: '#ff4466',
          color: '#ff4466',
        },
        standardWarning: {
          backgroundColor: '#1a1100',
          borderColor: '#f5a623',
          color: '#f5a623',
        },
        standardInfo: {
          backgroundColor: '#001033',
          borderColor: '#4488ff',
          color: '#4488ff',
        },
      },
    },
    MuiLinearProgress: {
      styleOverrides: {
        root: { backgroundColor: '#1a1a1a', borderRadius: 4 },
        bar: { borderRadius: 4 },
      },
    },
    MuiSkeleton: {
      styleOverrides: {
        root: { backgroundColor: '#1a1a1a' },
      },
    },
    MuiTab: {
      styleOverrides: {
        root: {
          textTransform: 'none',
          fontWeight: 500,
          fontSize: '0.875rem',
          color: '#8888a8',
          '&.Mui-selected': { color: '#4488ff' },
        },
      },
    },
    MuiTabs: {
      styleOverrides: {
        indicator: { backgroundColor: '#4488ff' },
      },
    },
    MuiSwitch: {
      styleOverrides: {
        track: { backgroundColor: '#2a2a2a' },
      },
    },
    MuiDataGrid: {
      styleOverrides: {
        root: {
          border: 'none',
          backgroundColor: '#000000',
          '& .MuiDataGrid-columnHeaders': {
            backgroundColor: '#000000',
            borderBottom: '1px solid #1a1a1a',
          },
          '& .MuiDataGrid-columnHeaderTitle': {
            color: '#8888a8',
            fontWeight: 600,
            fontSize: '0.6875rem',
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
          },
          '& .MuiDataGrid-cell': {
            borderBottom: '1px solid #0d0d0d',
            fontSize: '0.8125rem',
          },
          '& .MuiDataGrid-row:hover': {
            backgroundColor: '#0d0d0d',
          },
          '& .MuiDataGrid-footerContainer': {
            borderTop: '1px solid #1a1a1a',
            backgroundColor: '#000000',
          },
        },
      },
    },
  },
});

export default theme;

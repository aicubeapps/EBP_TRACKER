import { createTheme } from '@mui/material/styles';

const DARK = {
  bg:        '#0d1117',
  surface:   '#161b22',
  elevated:  '#1c2128',
  border:    '#30363d',
  borderSub: '#21262d',
  textPri:   '#e6edf3',
  textSec:   '#8b949e',
  textMuted: '#484f58',
  bull:      '#3fb950',
  bear:      '#f85149',
  blue:      '#58a6ff',
  purple:    '#bc8cff',
  amber:     '#d29922',
  bullBg:    '#0d1f12',
  bearBg:    '#1e0f0f',
  blueBg:    '#0c1929',
  purpleBg:  '#1a1040',
};

const LIGHT = {
  bg:        '#f2ede4',
  surface:   '#ebe5db',
  elevated:  '#e2dbd0',
  border:    '#c8bfb0',
  borderSub: '#d5cec4',
  textPri:   '#1c1a17',
  textSec:   '#5c5649',
  textMuted: '#9c9488',
  bull:      '#1a7f37',
  bear:      '#c82020',
  blue:      '#0969da',
  purple:    '#7c3aed',
  amber:     '#92620a',
  bullBg:    '#d4f0dc',
  bearBg:    '#fde8e8',
  blueBg:    '#dbeafe',
  purpleBg:  '#ede9fe',
};

export const createAppTheme = (mode = 'dark') => {
  const C = mode === 'dark' ? DARK : LIGHT;

  return createTheme({
    palette: {
      mode,
      background: { default: C.bg, paper: C.surface },
      primary:    { main: C.blue },
      secondary:  { main: C.purple },
      success:    { main: C.bull },
      error:      { main: C.bear },
      warning:    { main: C.amber },
      divider:    C.border,
      text: {
        primary:   C.textPri,
        secondary: C.textSec,
        disabled:  C.textMuted,
      },
    },

    typography: {
      fontFamily: '"Inter", "SF Pro Display", system-ui, sans-serif',
      h1: { fontSize: '1.75rem',   fontWeight: 600, letterSpacing: '-0.02em' },
      h2: { fontSize: '1.375rem',  fontWeight: 600, letterSpacing: '-0.01em' },
      h3: { fontSize: '1.125rem',  fontWeight: 600 },
      h4: { fontSize: '1rem',      fontWeight: 600 },
      h5: { fontSize: '0.9375rem', fontWeight: 600 },
      h6: { fontSize: '0.8125rem', fontWeight: 600 },
      body1:    { fontSize: '0.875rem',  lineHeight: 1.6 },
      body2:    { fontSize: '0.8125rem', lineHeight: 1.5 },
      caption:  { fontSize: '0.75rem',   lineHeight: 1.4 },
      overline: {
        fontSize: '0.6875rem', fontWeight: 600,
        letterSpacing: '0.06em', textTransform: 'uppercase',
      },
      subtitle1: { fontSize: '0.9375rem', fontWeight: 600 },
      subtitle2: { fontSize: '0.8125rem', fontWeight: 600 },
    },

    shape: { borderRadius: 6 },

    components: {
      MuiCssBaseline: {
        styleOverrides: {
          body: {
            backgroundColor: C.bg,
            color: C.textPri,
            scrollbarWidth: 'thin',
            scrollbarColor: `${C.border} ${C.bg}`,
            '&::-webkit-scrollbar': { width: '6px', height: '6px' },
            '&::-webkit-scrollbar-track': { background: C.bg },
            '&::-webkit-scrollbar-thumb': {
              background: C.border,
              borderRadius: '3px',
              '&:hover': { background: C.textMuted },
            },
          },
        },
      },

      MuiCard: {
        styleOverrides: {
          root: {
            backgroundColor: C.surface,
            backgroundImage: 'none',
            border: `1px solid ${C.border}`,
            borderRadius: 8,
            boxShadow: 'none',
            transition: 'border-color 0.15s ease',
            '&:hover': { borderColor: C.textMuted },
          },
        },
      },

      MuiPaper: {
        styleOverrides: {
          root: {
            backgroundImage: 'none',
            backgroundColor: C.surface,
            border: `1px solid ${C.border}`,
            boxShadow: 'none',
          },
        },
      },

      MuiButton: {
        styleOverrides: {
          root: {
            textTransform: 'none',
            fontWeight: 500,
            fontSize: '0.875rem',
            borderRadius: 6,
            boxShadow: 'none',
            '&:hover': { boxShadow: 'none' },
          },
          containedPrimary: {
            backgroundColor: C.blue,
            color: '#ffffff',
            '&:hover': {
              backgroundColor: mode === 'dark' ? '#79b8ff' : '#0860ca',
            },
          },
          outlined: {
            borderColor: C.border,
            color: C.textPri,
            '&:hover': {
              borderColor: C.textSec,
              backgroundColor: C.elevated,
            },
          },
          text: {
            color: C.textSec,
            '&:hover': { backgroundColor: C.elevated, color: C.textPri },
          },
        },
      },

      MuiIconButton: {
        styleOverrides: {
          root: {
            color: C.textSec,
            borderRadius: 6,
            '&:hover': { color: C.textPri, backgroundColor: C.elevated },
          },
        },
      },

      MuiTextField: {
        defaultProps: { variant: 'outlined', size: 'small' },
        styleOverrides: {
          root: {
            '& .MuiOutlinedInput-root': {
              backgroundColor: C.bg,
              fontSize: '0.875rem',
              '& fieldset': { borderColor: C.border },
              '&:hover fieldset': { borderColor: C.textMuted },
              '&.Mui-focused fieldset': {
                borderColor: C.blue,
                borderWidth: '1px',
              },
            },
            '& .MuiInputLabel-root': {
              fontSize: '0.875rem',
              color: C.textSec,
              '&.Mui-focused': { color: C.blue },
            },
          },
        },
      },

      MuiSelect: {
        styleOverrides: {
          root: { fontSize: '0.875rem' },
        },
      },

      MuiMenuItem: {
        styleOverrides: {
          root: {
            fontSize: '0.875rem',
            '&:hover': { backgroundColor: C.elevated },
            '&.Mui-selected': {
              backgroundColor: C.blueBg,
              '&:hover': { backgroundColor: C.elevated },
            },
          },
        },
      },

      MuiTableCell: {
        styleOverrides: {
          root: {
            borderBottom: `1px solid ${C.borderSub}`,
            fontSize: '0.8125rem',
            padding: '10px 16px',
          },
          head: {
            backgroundColor: C.bg,
            color: C.textMuted,
            fontWeight: 600,
            fontSize: '0.6875rem',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
          },
        },
      },

      MuiTableRow: {
        styleOverrides: {
          root: {
            '&:hover': { backgroundColor: C.elevated },
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
          label: { paddingLeft: 8, paddingRight: 8 },
        },
      },

      MuiDialog: {
        styleOverrides: {
          paper: {
            backgroundColor: C.surface,
            border: `1px solid ${C.border}`,
            borderRadius: 10,
            boxShadow: mode === 'dark'
              ? '0 16px 48px rgba(0,0,0,0.6)'
              : '0 16px 48px rgba(0,0,0,0.12)',
          },
        },
      },

      MuiDrawer: {
        styleOverrides: {
          paper: {
            backgroundColor: C.bg,
            borderRight: `1px solid ${C.border}`,
            boxShadow: 'none',
          },
        },
      },

      MuiListItemButton: {
        styleOverrides: {
          root: {
            borderRadius: 6,
            margin: '1px 6px',
            padding: '7px 10px',
            '&.Mui-selected': {
              backgroundColor: C.blueBg,
              color: C.blue,
              borderLeft: `2px solid ${C.blue}`,
              '&:hover': { backgroundColor: C.blueBg },
              '& .MuiListItemIcon-root': { color: C.blue },
            },
            '&:hover': { backgroundColor: C.elevated },
          },
        },
      },

      MuiListItemIcon: {
        styleOverrides: {
          root: { color: C.textSec, minWidth: 36 },
        },
      },

      MuiListItemText: {
        styleOverrides: {
          primary: { fontSize: '0.875rem', fontWeight: 500 },
        },
      },

      MuiDivider: {
        styleOverrides: {
          root: { borderColor: C.borderSub },
        },
      },

      MuiAlert: {
        styleOverrides: {
          root: { borderRadius: 6, border: '1px solid', fontSize: '0.8125rem' },
          standardSuccess: {
            backgroundColor: C.bullBg,
            borderColor: C.bull,
            color: mode === 'dark' ? '#3fb950' : '#1a7f37',
          },
          standardError: {
            backgroundColor: C.bearBg,
            borderColor: C.bear,
            color: mode === 'dark' ? '#f85149' : '#c82020',
          },
          standardWarning: {
            backgroundColor: mode === 'dark' ? '#1f1600' : '#fef9c3',
            borderColor: C.amber,
            color: C.amber,
          },
          standardInfo: {
            backgroundColor: C.blueBg,
            borderColor: C.blue,
            color: C.blue,
          },
        },
      },

      MuiLinearProgress: {
        styleOverrides: {
          root: { backgroundColor: C.elevated, borderRadius: 4, height: 5 },
          bar: { borderRadius: 4 },
        },
      },

      MuiSkeleton: {
        styleOverrides: {
          root: { backgroundColor: C.elevated, borderRadius: 4 },
        },
      },

      MuiTabs: {
        styleOverrides: {
          root: { borderBottom: `1px solid ${C.border}` },
          indicator: { backgroundColor: C.blue, height: 2 },
        },
      },

      MuiTab: {
        styleOverrides: {
          root: {
            textTransform: 'none',
            fontWeight: 500,
            fontSize: '0.875rem',
            color: C.textSec,
            minHeight: 44,
            padding: '0 16px',
            '&.Mui-selected': { color: C.textPri, fontWeight: 600 },
          },
        },
      },

      MuiSwitch: {
        styleOverrides: {
          track: { backgroundColor: C.border },
          thumb: { boxShadow: 'none' },
        },
      },

      MuiTooltip: {
        styleOverrides: {
          tooltip: {
            backgroundColor: C.elevated,
            border: `1px solid ${C.border}`,
            color: C.textPri,
            fontSize: '0.75rem',
            borderRadius: 4,
            boxShadow: mode === 'dark'
              ? '0 4px 12px rgba(0,0,0,0.4)'
              : '0 4px 12px rgba(0,0,0,0.1)',
          },
          arrow: { color: C.elevated },
        },
      },

      MuiAppBar: {
        styleOverrides: {
          root: {
            backgroundColor: C.bg,
            borderBottom: `1px solid ${C.border}`,
            boxShadow: 'none',
            color: C.textPri,
          },
        },
      },

      MuiDataGrid: {
        styleOverrides: {
          root: {
            border: 'none',
            backgroundColor: C.surface,
            '& .MuiDataGrid-columnHeaders': {
              backgroundColor: C.bg,
              borderBottom: `1px solid ${C.border}`,
            },
            '& .MuiDataGrid-columnHeaderTitle': {
              color: C.textMuted,
              fontWeight: 600,
              fontSize: '0.6875rem',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
            },
            '& .MuiDataGrid-cell': {
              borderBottom: `1px solid ${C.borderSub}`,
              fontSize: '0.8125rem',
              color: C.textPri,
            },
            '& .MuiDataGrid-row:hover': { backgroundColor: C.elevated },
            '& .MuiDataGrid-footerContainer': {
              borderTop: `1px solid ${C.border}`,
              backgroundColor: C.bg,
            },
          },
        },
      },

      MuiBottomNavigation: {
        styleOverrides: {
          root: {
            backgroundColor: C.bg,
            borderTop: `1px solid ${C.border}`,
            height: 56,
          },
        },
      },

      MuiBottomNavigationAction: {
        styleOverrides: {
          root: {
            color: C.textMuted,
            '&.Mui-selected': { color: C.blue },
            '& .MuiBottomNavigationAction-label': {
              fontSize: '0.6875rem',
              fontWeight: 500,
            },
          },
        },
      },
    },
  });
};

export default createAppTheme('dark');

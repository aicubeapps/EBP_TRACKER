import MuiButton from '@mui/material/Button'

const VARIANT_MAP = {
  primary: { variant: 'contained', color: 'primary' },
  secondary: { variant: 'outlined', color: 'primary' },
  ghost: { variant: 'text', color: 'inherit' },
  danger: { variant: 'outlined', color: 'error' },
  success: { variant: 'outlined', color: 'success' },
}

const SIZE_MAP = { sm: 'small', md: 'medium', lg: 'large' }

export default function Button({
  children,
  variant = 'primary',
  size = 'md',
  disabled = false,
  onClick,
  type = 'button',
  className = '',
  sx = {},
  startIcon,
  fullWidth = false,
}) {
  const { variant: muiVariant, color } = VARIANT_MAP[variant] || VARIANT_MAP.primary
  return (
    <MuiButton
      type={type}
      variant={muiVariant}
      color={color}
      size={SIZE_MAP[size] || 'medium'}
      disabled={disabled}
      onClick={onClick}
      startIcon={startIcon}
      fullWidth={fullWidth}
      className={className}
      sx={sx}
    >
      {children}
    </MuiButton>
  )
}

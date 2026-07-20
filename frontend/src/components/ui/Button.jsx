export default function Button({
  children,
  variant = 'primary',
  size = 'md',
  className = '',
  disabled = false,
  onClick,
  type = 'button',
}) {
  const variants = {
    primary: 'bg-accent-blue text-white hover:bg-accent-blue/90 border-transparent',
    secondary: 'bg-bg-elevated text-text-primary hover:bg-border border-border',
    ghost: 'bg-transparent text-text-secondary hover:text-text-primary hover:bg-bg-elevated border-transparent',
    danger: 'bg-bear/10 text-bear hover:bg-bear/20 border-bear/20',
    success: 'bg-bull/10 text-bull hover:bg-bull/20 border-bull/20',
  }

  const sizes = {
    sm: 'px-3 py-1.5 text-xs',
    md: 'px-4 py-2 text-sm',
    lg: 'px-6 py-3 text-base',
  }

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center justify-center gap-2 font-medium rounded-lg border transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed ${variants[variant]} ${sizes[size]} ${className}`}
    >
      {children}
    </button>
  )
}

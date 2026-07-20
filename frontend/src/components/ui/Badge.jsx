export default function Badge({ variant = 'neutral', children, className = '' }) {
  const variants = {
    bull: 'bg-bull/10 text-bull border-bull/20',
    bear: 'bg-bear/10 text-bear border-bear/20',
    neutral: 'bg-neutral/10 text-neutral border-neutral/20',
    blue: 'bg-accent-blue/10 text-accent-blue border-accent-blue/20',
    yellow: 'bg-accent-yellow/10 text-accent-yellow border-accent-yellow/20',
    purple: 'bg-accent-purple/10 text-accent-purple border-accent-purple/20',
    expired: 'bg-bear/10 text-bear border-bear/20',
    free: 'bg-text-muted/10 text-text-secondary border-border',
    coffee: 'bg-accent-yellow/10 text-accent-yellow border-accent-yellow/20',
    beer: 'bg-accent-blue/10 text-accent-blue border-accent-blue/20',
    wine: 'bg-accent-purple/10 text-accent-purple border-accent-purple/20',
  }

  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 text-xs font-medium rounded-md border ${variants[variant] || variants.neutral} ${className}`}
    >
      {children}
    </span>
  )
}

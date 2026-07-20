export default function Card({ children, className = '', hover = false }) {
  return (
    <div
      className={`bg-bg-card border border-border rounded-lg p-4 ${hover ? 'card-hover cursor-pointer' : ''} ${className}`}
    >
      {children}
    </div>
  )
}

export function Table({ children, className = '' }) {
  return (
    <div className={`overflow-x-auto rounded-lg border border-border ${className}`}>
      <table className="w-full text-sm">{children}</table>
    </div>
  )
}

export function THead({ children }) {
  return (
    <thead className="bg-bg-elevated border-b border-border text-text-secondary text-xs uppercase tracking-wider">
      {children}
    </thead>
  )
}

export function TBody({ children }) {
  return <tbody className="divide-y divide-border-subtle">{children}</tbody>
}

export function TR({ children, className = '' }) {
  return (
    <tr className={`transition-colors even:bg-bg-secondary odd:bg-bg-card hover:bg-bg-elevated ${className}`}>
      {children}
    </tr>
  )
}

export function TH({ children, className = '' }) {
  return <th className={`px-4 py-3 text-left font-medium ${className}`}>{children}</th>
}

export function TD({ children, className = '' }) {
  return <td className={`px-4 py-3 text-text-primary tabular-nums ${className}`}>{children}</td>
}

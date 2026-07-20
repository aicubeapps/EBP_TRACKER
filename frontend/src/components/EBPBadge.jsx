export default function EBPBadge({ direction }) {
  if (direction === 'bull') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-semibold rounded-md bg-bull/10 text-bull border border-bull/20">
        <span className="w-1.5 h-1.5 rounded-full bg-bull" />
        Bull EBP
      </span>
    )
  }
  if (direction === 'bear') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-semibold rounded-md bg-bear/10 text-bear border border-bear/20">
        <span className="w-1.5 h-1.5 rounded-full bg-bear" />
        Bear EBP
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-md bg-neutral/10 text-neutral border border-neutral/20">
      <span className="w-1.5 h-1.5 rounded-full bg-neutral" />
      None
    </span>
  )
}

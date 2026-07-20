const TIMEFRAMES = ['M15', '1H', '4H', 'D', 'W']

const dotColors = {
  bull: 'bg-bull shadow-[0_0_6px_rgba(0,200,150,0.5)]',
  bear: 'bg-bear shadow-[0_0_6px_rgba(255,68,102,0.5)]',
  none: 'bg-text-muted',
}

const labelColors = {
  bull: 'text-bull',
  bear: 'text-bear',
  none: 'text-text-muted',
}

export default function TFGrid({ data = {} }) {
  return (
    <div className="flex items-stretch gap-1.5">
      {TIMEFRAMES.map((tf) => {
        const signal = data[tf] || 'none'
        return (
          <div
            key={tf}
            className="flex flex-col items-center justify-center gap-1.5 flex-1 px-1 py-2 bg-bg-elevated border border-border rounded-md min-w-0"
          >
            <span className={`text-[10px] font-semibold uppercase tracking-wide ${labelColors[signal]}`}>
              {tf}
            </span>
            <span className={`w-2 h-2 rounded-full shrink-0 ${dotColors[signal]}`} />
          </div>
        )
      })}
    </div>
  )
}

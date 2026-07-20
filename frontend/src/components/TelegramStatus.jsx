import { MessageCircle, CheckCircle, XCircle } from 'lucide-react'

export default function TelegramStatus({ connected }) {
  return (
    <div className="flex items-center gap-1.5 text-xs">
      <MessageCircle size={12} className="text-accent-blue" />
      {connected ? (
        <>
          <CheckCircle size={12} className="text-bull" />
          <span className="text-bull">Telegram connected</span>
        </>
      ) : (
        <>
          <XCircle size={12} className="text-bear" />
          <span className="text-text-muted">Telegram not connected</span>
        </>
      )}
    </div>
  )
}

export default function ApiErrorAlert({ error, onRetry }) {
  if (!error) return null;
  return (
    <div className="banner banner-error">
      <span>{error}</span>
      {onRetry && (
        <button className="banner-action" onClick={onRetry}>Retry</button>
      )}
    </div>
  );
}

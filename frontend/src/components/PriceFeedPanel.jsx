import { useState, useRef, useEffect } from 'react';

const DEFAULT_SYMBOL = 'EUR/USD';
const WS_ENDPOINT    = 'wss://ws.twelvedata.com/v1/quotes/price';

function fmtPrice(price, symbol) {
  if (price == null) return '—';
  return price.toFixed(symbol.includes('JPY') ? 3 : 5);
}

function fmtTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString('en-GB', {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function normalisePair(raw) {
  const s = raw.trim().toUpperCase();
  if (s.length === 6 && !s.includes('/')) return `${s.slice(0, 3)}/${s.slice(3)}`;
  return s;
}

function maskKey(key) {
  if (!key || key.length < 4) return '****';
  return '****' + key.slice(-4);
}

export default function PriceFeedPanel({ keys = [] }) {
  const wsRef  = useRef(null);
  const symRef = useRef(DEFAULT_SYMBOL); // tracks current subscribed symbol across async gaps
  const logRef = useRef([]);

  const [apiKey, setApiKey]                   = useState('');
  const [symbol, setSymbol]                   = useState(DEFAULT_SYMBOL);
  const [pendingSym, setPendingSym]           = useState('');
  const [changingSymbol, setChangingSymbol]   = useState(false);
  const [switching, setSwitching]             = useState(false);
  const [status, setStatus]                   = useState('disconnected');
  const [subOk, setSubOk]                     = useState(false);
  const [subFailed, setSubFailed]             = useState(false);
  const [price, setPrice]                     = useState(null); // { price, direction, updatedAt }
  const [errorMsg, setErrorMsg]               = useState('');
  const [rawLog, setRawLog]                   = useState([]);
  const [connInfo, setConnInfo]               = useState(null);

  const twelveKeys = keys.filter(k => k.source === 'twelvedata' && k.enabled && !k.exhausted);

  useEffect(() => () => {
    wsRef.current?.close();
    wsRef.current = null;
  }, []);

  const pushLog = (line) => {
    const ts    = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const entry = `[${ts}] ${line}`;
    logRef.current = [entry, ...logRef.current].slice(0, 20);
    setRawLog([...logRef.current]);
  };

  const connect = () => {
    if (!apiKey.trim()) {
      setErrorMsg('Enter your Twelve Data API key to connect.');
      return;
    }
    wsRef.current?.close();
    wsRef.current = null;

    const sym = normalisePair(symbol) || DEFAULT_SYMBOL;
    setSymbol(sym);
    symRef.current = sym;

    setStatus('connecting');
    setErrorMsg('');
    setPrice(null);
    setSubOk(false);
    setSubFailed(false);
    setChangingSymbol(false);
    setPendingSym('');
    logRef.current = [];
    setRawLog([]);

    const url          = `${WS_ENDPOINT}?apikey=${encodeURIComponent(apiKey.trim())}`;
    const maskedUrl    = `${WS_ENDPOINT}?apikey=${maskKey(apiKey.trim())}`;
    const subscribeMsg = JSON.stringify({ action: 'subscribe', params: { symbols: sym } });

    setConnInfo({ url: maskedUrl });
    pushLog(`CONNECTING → ${maskedUrl}`);

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus('connected');
      pushLog(`OPEN — subscribing ${sym}`);
      ws.send(subscribeMsg);
    };

    ws.onmessage = (evt) => {
      pushLog(`MSG: ${evt.data}`);
      try {
        const msg = JSON.parse(evt.data);

        if (msg.event === 'subscribe-status') {
          const ok   = (msg.success ?? []).some(s => s.symbol === symRef.current);
          const fail = (msg.fails   ?? []).some(s => s.symbol === symRef.current);
          if (ok)   setSubOk(true);
          if (fail) setSubFailed(true);
          return;
        }

        if (msg.event === 'price' && msg.symbol === symRef.current && msg.price != null) {
          setPrice(prev => {
            const dir =
              prev?.price == null      ? null
              : msg.price > prev.price ? 'up'
              : msg.price < prev.price ? 'down'
              : prev.direction;
            return { price: msg.price, direction: dir, updatedAt: Date.now() };
          });
        }
      } catch { /* ignore non-JSON frames */ }
    };

    ws.onerror = (evt) => {
      const detail = evt.message ?? evt.type ?? 'unknown error';
      setStatus('error');
      setErrorMsg('WebSocket error — see raw log for details.');
      pushLog(`ERROR: ${detail}`);
    };

    ws.onclose = (evt) => {
      pushLog(`CLOSE — code ${evt.code} reason: "${evt.reason || 'none'}"`);
      setStatus(prev => (prev === 'error' ? prev : 'disconnected'));
      wsRef.current = null;
    };
  };

  const disconnect = () => {
    wsRef.current?.close();
    wsRef.current = null;
    setStatus('disconnected');
    setChangingSymbol(false);
    setSwitching(false);
  };

  const handleChangeSymbol = async () => {
    const newSym = normalisePair(pendingSym);
    if (!newSym || newSym === symRef.current) {
      setChangingSymbol(false);
      setPendingSym('');
      return;
    }

    setSwitching(true);
    setSubOk(false);
    setSubFailed(false);
    setPrice(null);

    // Unsubscribe current symbol first
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const unsubMsg = JSON.stringify({ action: 'unsubscribe', params: { symbols: symRef.current } });
      wsRef.current.send(unsubMsg);
      pushLog(`SEND: ${unsubMsg}`);
    }

    // 500ms gap before subscribing the new symbol
    await new Promise(r => setTimeout(r, 500));

    symRef.current = newSym;
    setSymbol(newSym);
    setPendingSym('');
    setChangingSymbol(false);

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const subMsg = JSON.stringify({ action: 'subscribe', params: { symbols: newSym } });
      wsRef.current.send(subMsg);
      pushLog(`SEND: ${subMsg}`);
    }

    setSwitching(false);
  };

  const isActive   = status === 'connected' || status === 'connecting';
  const dotColor   = { connected: '#22c55e', connecting: '#f59e0b', error: '#ef4444', disconnected: '#6b7280' }[status];
  const dotLabel   = { connected: 'CONNECTED', connecting: 'CONNECTING…', error: 'ERROR', disconnected: 'DISCONNECTED' }[status];
  const dir        = price?.direction;
  const priceColor = dir === 'up' ? 'var(--bull)' : dir === 'down' ? 'var(--bear)' : 'inherit';

  return (
    <div>
      {/* ── Key + symbol entry ────────────────────────────────── */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-title">Twelve Data WebSocket</div>
        <p className="text-muted" style={{ fontSize: 12, marginBottom: 12 }}>
          Keys stored in the DB are masked in the API Keys tab.
          Enter the full key here to open a live WebSocket connection.
          {twelveKeys.length > 0 && (
            <> Active key{twelveKeys.length > 1 ? 's' : ''} in DB:{' '}
              <strong>{twelveKeys.map(k => k.label).join(', ')}</strong>.
            </>
          )}
        </p>

        <div className="config-row" style={{ marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
          <input
            className="search-input"
            type="password"
            placeholder="Enter full Twelve Data API key"
            value={apiKey}
            disabled={isActive}
            onChange={e => setApiKey(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !isActive && connect()}
            style={{ flex: '1 1 240px', maxWidth: 380, fontFamily: 'var(--font-mono)', fontSize: 13 }}
          />
          <input
            className="search-input"
            placeholder="Symbol e.g. EUR/USD"
            value={symbol}
            disabled={isActive}
            onChange={e => setSymbol(e.target.value.toUpperCase())}
            onKeyDown={e => e.key === 'Enter' && !isActive && connect()}
            style={{ width: 130, fontFamily: 'var(--font-mono)', fontSize: 13 }}
          />
        </div>

        <div className="config-row" style={{ marginBottom: 0, flexWrap: 'wrap', gap: 8 }}>
          {isActive ? (
            <button className="btn btn-danger btn-sm" onClick={disconnect}>Disconnect</button>
          ) : (
            <button className="btn btn-primary btn-sm" onClick={connect} disabled={!apiKey.trim()}>
              Connect
            </button>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{
              display: 'inline-block', width: 9, height: 9, borderRadius: '50%',
              background: dotColor,
              boxShadow: status === 'connected' ? `0 0 0 3px ${dotColor}33` : 'none',
              transition: 'background 0.25s',
            }} />
            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', color: dotColor }}>
              {dotLabel}
            </span>
          </div>
        </div>

        <div style={{
          marginTop: 10, padding: '6px 10px', borderRadius: 'var(--radius-sm)',
          background: '#eff6ff', border: '1px solid #bfdbfe', color: '#1e40af', fontSize: 11,
        }}>
          ℹ️ Basic plan: 1 symbol at a time. Use "Change Symbol" while connected to switch pairs.
        </div>

        {errorMsg && (
          <div style={{
            marginTop: 8, padding: '8px 12px', borderRadius: 'var(--radius-sm)',
            background: 'var(--bear-lt)', color: 'var(--bear)',
            fontSize: 12, fontWeight: 500, border: '1px solid #f0b8b8',
          }}>
            {errorMsg}
          </div>
        )}
      </div>

      {/* ── Live price card ───────────────────────────────────── */}
      {isActive && (
        <div className="card" style={{ marginBottom: 16 }}>
          {/* Symbol + badge */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 20, letterSpacing: '0.04em' }}>
              {symbol}
            </span>
            {subOk && (
              <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.08em',
                color: '#16a34a', background: '#dcfce7', borderRadius: 3, padding: '2px 6px' }}>
                LIVE
              </span>
            )}
            {subFailed && (
              <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.08em',
                color: '#dc2626', background: '#fee2e2', borderRadius: 3, padding: '2px 6px' }}>
                FAILED
              </span>
            )}
          </div>

          {/* Price */}
          <div style={{
            fontFamily: 'var(--font-mono)', fontWeight: 700, lineHeight: 1, marginBottom: 8,
            fontSize: switching || subFailed || !price ? 18 : 40,
            color: subFailed ? '#dc2626' : switching ? 'var(--muted)' : priceColor,
            transition: 'color 0.3s',
          }}>
            {subFailed   ? 'subscription rejected — plan limit or invalid symbol'
             : switching ? 'switching…'
             : price     ? fmtPrice(price.price, symbol)
             :             <span style={{ color: 'var(--muted)' }}>waiting for tick…</span>
            }
          </div>

          {/* Direction + timestamp */}
          {!subFailed && !switching && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <span style={{ fontSize: 18 }}>
                {dir === 'up'   ? <span style={{ color: '#22c55e' }}>▲</span>
                 : dir === 'down' ? <span style={{ color: '#ef4444' }}>▼</span>
                 :                  <span style={{ color: 'var(--muted)' }}>—</span>}
              </span>
              {price && (
                <span style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}>
                  {fmtTime(price.updatedAt)}
                </span>
              )}
            </div>
          )}

          {/* Change symbol controls */}
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
            {changingSymbol ? (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <input
                  className="search-input"
                  placeholder="New pair e.g. GBP/USD"
                  value={pendingSym}
                  disabled={switching}
                  autoFocus
                  onChange={e => setPendingSym(e.target.value.toUpperCase())}
                  onKeyDown={e => e.key === 'Enter' && !switching && handleChangeSymbol()}
                  style={{ width: 160, fontFamily: 'var(--font-mono)' }}
                />
                <button
                  className="btn btn-primary btn-sm"
                  disabled={!pendingSym.trim() || switching}
                  onClick={handleChangeSymbol}
                >
                  {switching ? 'Switching…' : 'Switch'}
                </button>
                <button
                  className="btn btn-outline btn-sm"
                  disabled={switching}
                  onClick={() => { setChangingSymbol(false); setPendingSym(''); }}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                className="btn btn-outline btn-sm"
                disabled={switching}
                onClick={() => setChangingSymbol(true)}
              >
                Change Symbol
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── Raw message log ───────────────────────────────────── */}
      {rawLog.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div className="section-heading" style={{ marginBottom: 6 }}>Raw WS Log</div>
          {connInfo && (
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: '#94a3b8', marginBottom: 4 }}>
              {connInfo.url}
            </div>
          )}
          <div style={{
            background: '#0f172a', color: '#e2e8f0',
            fontFamily: 'var(--font-mono)', fontSize: 11,
            padding: '10px 12px', borderRadius: 'var(--radius-sm)',
            maxHeight: 220, overflowY: 'auto', border: '1px solid #1e293b',
          }}>
            {rawLog.map((line, i) => (
              <div key={i} style={{
                padding: '1px 0',
                color: line.includes('ERROR') || line.includes('CLOSE') || line.includes('"fail')
                  ? '#f87171'
                  : line.includes('OPEN') || line.includes('"price"')
                    ? '#86efac'
                    : '#e2e8f0',
              }}>
                {line}
              </div>
            ))}
          </div>
          <button
            className="add-link"
            style={{ fontSize: 11, marginTop: 4 }}
            onClick={() => { logRef.current = []; setRawLog([]); }}
          >
            Clear log
          </button>
        </div>
      )}

      <p className="text-muted" style={{ fontSize: 11, marginTop: 4 }}>
        Non-JPY: 5 dp · JPY: 3 dp · No auto-reconnect — click Connect each session.
      </p>
    </div>
  );
}

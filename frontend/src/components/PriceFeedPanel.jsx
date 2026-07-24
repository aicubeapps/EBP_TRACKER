import { useState, useRef, useEffect } from 'react';

const DEFAULT_SYMBOLS = [
  'EUR/USD', 'GBP/USD', 'USD/CHF', 'USD/CAD',
  'EUR/CHF', 'GBP/CHF', 'GBP/JPY', 'EUR/JPY',
];
const WS_ENDPOINT = 'wss://ws.twelvedata.com/v1/quotes/price';

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
  const logRef = useRef([]);

  const [apiKey, setApiKey]     = useState('');
  const [symbols, setSymbols]   = useState([...DEFAULT_SYMBOLS]);
  const [newSym, setNewSym]     = useState('');
  const [status, setStatus]     = useState('disconnected');
  const [errorMsg, setErrorMsg] = useState('');
  const [prices, setPrices]     = useState({});
  const [rawLog, setRawLog]     = useState([]);   // visible log lines
  const [connInfo, setConnInfo] = useState(null); // { url, subscribeMsg }

  const twelveKeys = keys.filter(k => k.source === 'twelvedata' && k.enabled && !k.exhausted);

  useEffect(() => () => {
    wsRef.current?.close();
    wsRef.current = null;
  }, []);

  const pushLog = (line) => {
    const ts  = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
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

    setStatus('connecting');
    setErrorMsg('');
    setPrices({});
    logRef.current = [];
    setRawLog([]);

    const url = `${WS_ENDPOINT}?apikey=${encodeURIComponent(apiKey.trim())}`;
    const maskedUrl = `${WS_ENDPOINT}?apikey=${maskKey(apiKey.trim())}`;
    const subscribeMsg = JSON.stringify({ action: 'subscribe', params: { symbols: symbols.join(',') } });

    setConnInfo({ url: maskedUrl, subscribeMsg });
    pushLog(`CONNECTING → ${maskedUrl}`);

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus('connected');
      pushLog(`OPEN — sending: ${subscribeMsg}`);
      ws.send(subscribeMsg);
    };

    ws.onmessage = (evt) => {
      pushLog(`MSG: ${evt.data}`);
      try {
        const msg = JSON.parse(evt.data);
        if (msg.event === 'price' && msg.symbol && msg.price != null) {
          setPrices(prev => {
            const old = prev[msg.symbol];
            const dir =
              old?.price == null    ? null
              : msg.price > old.price ? 'up'
              : msg.price < old.price ? 'down'
              : old.direction;
            return {
              ...prev,
              [msg.symbol]: { price: msg.price, direction: dir, updatedAt: Date.now() },
            };
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
  };

  const addSymbol = () => {
    const s = normalisePair(newSym);
    if (!s || symbols.includes(s)) { setNewSym(''); return; }
    setSymbols(prev => [...prev, s]);
    setNewSym('');
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const msg = JSON.stringify({ action: 'subscribe', params: { symbols: s } });
      wsRef.current.send(msg);
      pushLog(`SEND: ${msg}`);
    }
  };

  const removeSymbol = (sym) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const msg = JSON.stringify({ action: 'unsubscribe', params: { symbols: sym } });
      wsRef.current.send(msg);
      pushLog(`SEND: ${msg}`);
    }
    setSymbols(prev => prev.filter(s => s !== sym));
    setPrices(prev => { const n = { ...prev }; delete n[sym]; return n; });
  };

  const isActive  = status === 'connected' || status === 'connecting';
  const dotColor  = { connected: '#22c55e', connecting: '#f59e0b', error: '#ef4444', disconnected: '#6b7280' }[status];
  const dotLabel  = { connected: 'CONNECTED', connecting: 'CONNECTING…', error: 'ERROR', disconnected: 'DISCONNECTED' }[status];

  return (
    <div>
      {/* ── Key entry + connect controls ─────────────────────── */}
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

        <div className="config-row" style={{ marginBottom: 0, flexWrap: 'wrap', gap: 8 }}>
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

        {errorMsg && (
          <div style={{
            marginTop: 10, padding: '8px 12px',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--bear-lt)', color: 'var(--bear)',
            fontSize: 12, fontWeight: 500,
            border: '1px solid #f0b8b8',
          }}>
            {errorMsg}
          </div>
        )}
      </div>

      {/* ── Raw message log ───────────────────────────────────── */}
      {(rawLog.length > 0 || connInfo) && (
        <div style={{ marginBottom: 16 }}>
          <div className="section-heading" style={{ marginBottom: 6 }}>Raw WS Log</div>
          {connInfo && (
            <div style={{
              fontFamily: 'var(--font-mono)', fontSize: 11,
              color: '#94a3b8', marginBottom: 4,
            }}>
              URL: {connInfo.url}<br />
              Subscribe: {connInfo.subscribeMsg}
            </div>
          )}
          <div style={{
            background: '#0f172a', color: '#e2e8f0',
            fontFamily: 'var(--font-mono)', fontSize: 11,
            padding: '10px 12px', borderRadius: 'var(--radius-sm)',
            maxHeight: 260, overflowY: 'auto',
            border: '1px solid #1e293b',
          }}>
            {rawLog.length === 0
              ? <span style={{ color: '#475569' }}>No messages yet…</span>
              : rawLog.map((line, i) => (
                <div key={i} style={{
                  padding: '1px 0',
                  color: line.includes('ERROR') || line.includes('CLOSE')
                    ? '#f87171'
                    : line.includes('OPEN') || line.includes('price')
                      ? '#86efac'
                      : '#e2e8f0',
                }}>
                  {line}
                </div>
              ))
            }
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

      {/* ── Symbol toolbar ────────────────────────────────────── */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        marginBottom: 12, flexWrap: 'wrap', gap: 8,
      }}>
        <div className="section-heading" style={{ marginBottom: 0 }}>
          Live Prices
          <span className="text-muted" style={{ fontWeight: 400, fontSize: 12, marginLeft: 8 }}>
            {symbols.length} pair{symbols.length !== 1 ? 's' : ''} · {symbols.length} WS credit{symbols.length !== 1 ? 's' : ''}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            className="search-input"
            placeholder="Add pair e.g. AUD/USD"
            value={newSym}
            onChange={e => setNewSym(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addSymbol()}
            style={{ maxWidth: 160 }}
          />
          <button className="search-btn" onClick={addSymbol}>Add</button>
        </div>
      </div>

      {/* ── Price cards ───────────────────────────────────────── */}
      {symbols.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 32, color: 'var(--muted)' }}>
          No pairs added — type a symbol above and click Add
        </div>
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
          gap: 12,
        }}>
          {symbols.map(sym => {
            const tick = prices[sym];
            const dir  = tick?.direction;
            const priceColor = dir === 'up' ? 'var(--bull)' : dir === 'down' ? 'var(--bear)' : 'inherit';
            return (
              <div key={sym} className="card" style={{ position: 'relative', padding: '14px 16px' }}>
                <button
                  className="add-link"
                  onClick={() => removeSymbol(sym)}
                  title={`Remove ${sym}`}
                  style={{
                    position: 'absolute', top: 8, right: 8,
                    color: 'var(--muted)', fontSize: 13, padding: '2px 6px',
                    lineHeight: 1,
                  }}
                >
                  ✕
                </button>

                <div style={{
                  fontFamily: 'var(--font-mono)', fontWeight: 700,
                  fontSize: 13, letterSpacing: '0.04em', marginBottom: 6,
                }}>
                  {sym}
                </div>

                <div style={{
                  fontFamily: 'var(--font-mono)', fontSize: 22, fontWeight: 700,
                  color: priceColor, transition: 'color 0.3s',
                  marginBottom: 6,
                }}>
                  {tick ? fmtPrice(tick.price, sym) : <span style={{ color: 'var(--muted)' }}>—</span>}
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 14 }}>
                    {dir === 'up'
                      ? <span style={{ color: '#22c55e' }}>▲</span>
                      : dir === 'down'
                        ? <span style={{ color: '#ef4444' }}>▼</span>
                        : <span style={{ color: 'var(--muted)' }}>—</span>
                    }
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}>
                    {tick ? fmtTime(tick.updatedAt) : 'waiting…'}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <p className="text-muted" style={{ fontSize: 11, marginTop: 8 }}>
        Non-JPY: 5 dp · JPY: 3 dp · No auto-reconnect — click Connect each session.
      </p>
    </div>
  );
}

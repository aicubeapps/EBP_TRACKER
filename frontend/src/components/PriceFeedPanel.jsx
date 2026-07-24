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

// Normalise bare 6-char input (EURUSD) → EUR/USD
function normalisePair(raw) {
  const s = raw.trim().toUpperCase();
  if (s.length === 6 && !s.includes('/')) return `${s.slice(0, 3)}/${s.slice(3)}`;
  return s;
}

export default function PriceFeedPanel({ keys = [] }) {
  const wsRef = useRef(null);

  const [apiKey, setApiKey]     = useState('');
  const [symbols, setSymbols]   = useState([...DEFAULT_SYMBOLS]);
  const [newSym, setNewSym]     = useState('');
  const [status, setStatus]     = useState('disconnected'); // disconnected | connecting | connected | error
  const [errorMsg, setErrorMsg] = useState('');
  const [prices, setPrices]     = useState({});            // { 'EUR/USD': { price, direction, updatedAt } }

  const twelveKeys = keys.filter(k => k.source === 'twelvedata' && k.enabled && !k.exhausted);

  // Clean up WebSocket on unmount (tab navigation)
  useEffect(() => () => {
    wsRef.current?.close();
    wsRef.current = null;
  }, []);

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

    const ws = new WebSocket(`${WS_ENDPOINT}?apikey=${encodeURIComponent(apiKey.trim())}`);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus('connected');
      ws.send(JSON.stringify({
        action: 'subscribe',
        params: { symbols: symbols.join(',') },
      }));
    };

    ws.onmessage = (evt) => {
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

    ws.onerror = () => {
      setStatus('error');
      setErrorMsg('WebSocket error — verify the API key and try again.');
    };

    ws.onclose = () => {
      // Keep 'error' state if already set; otherwise revert to disconnected
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
      wsRef.current.send(JSON.stringify({ action: 'subscribe', params: { symbols: s } }));
    }
  };

  const removeSymbol = (sym) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ action: 'unsubscribe', params: { symbols: sym } }));
    }
    setSymbols(prev => prev.filter(s => s !== sym));
    setPrices(prev => { const n = { ...prev }; delete n[sym]; return n; });
  };

  const isActive   = status === 'connected' || status === 'connecting';
  const dotColor   = { connected: '#22c55e', connecting: '#f59e0b', error: '#ef4444', disconnected: '#6b7280' }[status];
  const dotLabel   = { connected: 'CONNECTED', connecting: 'CONNECTING…', error: 'ERROR', disconnected: 'DISCONNECTED' }[status];

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

      {/* ── Symbol toolbar ────────────────────────────────────── */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        marginBottom: 10, flexWrap: 'wrap', gap: 8,
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

      {/* ── Price table ───────────────────────────────────────── */}
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table className="alert-table">
            <thead>
              <tr>
                <th>Pair</th>
                <th style={{ textAlign: 'right' }}>Price</th>
                <th style={{ textAlign: 'center', width: 40 }}>Dir</th>
                <th>Updated</th>
                <th>Pip Δ</th>
                <th style={{ width: 32 }}></th>
              </tr>
            </thead>
            <tbody>
              {symbols.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', color: 'var(--muted)', padding: 24 }}>
                    No pairs added — type a symbol above and click Add
                  </td>
                </tr>
              ) : symbols.map(sym => {
                const tick = prices[sym];
                const dir  = tick?.direction;
                return (
                  <tr key={sym}>
                    {/* Symbol */}
                    <td style={{ fontWeight: 600, fontFamily: 'var(--font-mono)', fontSize: 13 }}>
                      {sym}
                    </td>

                    {/* Price — colour shifts on tick direction */}
                    <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 15, fontWeight: 700 }}>
                      {tick
                        ? <span style={{
                            color: dir === 'up' ? 'var(--bull)' : dir === 'down' ? 'var(--bear)' : 'inherit',
                            transition: 'color 0.3s',
                          }}>
                            {fmtPrice(tick.price, sym)}
                          </span>
                        : <span style={{ color: 'var(--muted)' }}>—</span>
                      }
                    </td>

                    {/* Direction arrow */}
                    <td style={{ textAlign: 'center', fontSize: 14 }}>
                      {dir === 'up'
                        ? <span style={{ color: '#22c55e' }}>▲</span>
                        : dir === 'down'
                          ? <span style={{ color: '#ef4444' }}>▼</span>
                          : <span style={{ color: 'var(--muted)' }}>—</span>
                      }
                    </td>

                    {/* Timestamp */}
                    <td style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}>
                      {tick ? fmtTime(tick.updatedAt) : '—'}
                    </td>

                    {/* Pip Δ — admin fills by eye */}
                    <td style={{ color: 'var(--muted)', fontSize: 12 }}>—</td>

                    {/* Remove */}
                    <td>
                      <button
                        className="add-link"
                        style={{ color: '#ef4444', fontSize: 13, padding: '2px 4px' }}
                        onClick={() => removeSymbol(sym)}
                        title={`Remove ${sym}`}
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-muted" style={{ fontSize: 11, marginTop: 8 }}>
        Non-JPY: 5 dp · JPY: 3 dp · No auto-reconnect — click Connect each session.
      </p>
    </div>
  );
}

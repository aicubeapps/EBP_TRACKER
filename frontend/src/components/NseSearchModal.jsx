import { useState, useEffect, useRef } from 'react';
import { useAuth } from '@clerk/clerk-react';
import api from '../lib/api';

export default function NseSearchModal({ isOpen, onClose, onAdded }) {
  const { getToken } = useAuth();
  const [query, setQuery]         = useState('');
  const [results, setResults]     = useState([]);
  const [searching, setSearching] = useState(false);
  const [adding, setAdding]       = useState(null); // symbol currently being added
  const [error, setError]        = useState(null);
  const debounceRef = useRef(null);

  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setResults([]);
      setError(null);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    clearTimeout(debounceRef.current);
    if (!query.trim()) {
      setResults([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const token = await getToken();
        const data  = await api.get(`/nse/search?q=${encodeURIComponent(query.trim())}`, token);
        setResults(Array.isArray(data) ? data : []);
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 400);
    return () => clearTimeout(debounceRef.current);
  }, [query, isOpen, getToken]);

  if (!isOpen) return null;

  async function handleAdd(symbol) {
    setAdding(symbol);
    setError(null);
    try {
      const token = await getToken();
      await api.post('/user/assets', { symbol, displayName: symbol, assetType: 'nse' }, token);
      onAdded?.(symbol);
      onClose();
    } catch (e) {
      setError(e.message || 'Failed to add asset');
    } finally {
      setAdding(null);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" style={{ maxWidth: 460 }} onClick={e => e.stopPropagation()}>
        <div className="modal-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Add Share Market Asset</span>
          <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <input
          className="search-input"
          placeholder="Search NSE/BSE stocks, indices, ETFs…"
          value={query}
          onChange={e => setQuery(e.target.value)}
          autoFocus
          style={{ width: '100%', marginBottom: 'var(--sp-md)' }}
        />

        {error && (
          <p style={{ color: '#ef4444', fontSize: 12, marginBottom: 'var(--sp-sm)' }}>{error}</p>
        )}

        <div style={{ maxHeight: 320, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {searching ? (
            <p className="text-muted" style={{ textAlign: 'center', padding: 24, fontSize: 12 }}>Searching…</p>
          ) : !query.trim() ? (
            <p className="text-muted" style={{ textAlign: 'center', padding: 24, fontSize: 12 }}>
              Search for NSE/BSE stocks, indices or ETFs
            </p>
          ) : results.length === 0 ? (
            <p className="text-muted" style={{ textAlign: 'center', padding: 24, fontSize: 12 }}>
              No results found for '{query}'
            </p>
          ) : results.map(r => (
            <div key={r.symbol} className="nse-search-row">
              <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                <span className="text-mono" style={{ fontWeight: 700, fontSize: 13 }}>{r.symbol}</span>
                <span className="text-muted" style={{ fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {r.shortName}
                </span>
              </div>
              <button
                className="nse-search-add-btn"
                disabled={adding === r.symbol}
                onClick={() => handleAdd(r.symbol)}
              >
                {adding === r.symbol ? '…' : '+ Add'}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

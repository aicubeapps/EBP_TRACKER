import { useState, useEffect } from 'react';
import { FOREX_PAIRS, CRYPTO_PAIRS, FOREX_MAJORS } from '../data/assetLists';

export default function AssetBrowserModal({ isOpen, onClose, onAdd, existingSymbols, slotsUsed, slotLimit }) {
  const [activeTab, setActiveTab]             = useState('forex'); // 'forex' | 'crypto'
  const [filter, setFilter]                   = useState('all');   // 'all' | 'majors' | 'minors'
  const [search, setSearch]                   = useState('');
  const [pending, setPending]                 = useState({});
  const [added, setAdded]                     = useState({});
  const [rowErrors, setRowErrors]             = useState({});
  const [bannerDismissed, setBannerDismissed] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setActiveTab('forex');
      setFilter('all');
      setSearch('');
      setRowErrors({});
      setBannerDismissed(false);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const limitReached = slotsUsed >= slotLimit;
  const isOwned       = (symbol) => existingSymbols.includes(symbol) || added[symbol];
  const list           = activeTab === 'forex' ? FOREX_PAIRS : CRYPTO_PAIRS;

  const filtered = list.filter(pair => {
    if (activeTab === 'forex') {
      if (filter === 'majors' && !FOREX_MAJORS.includes(pair)) return false;
      if (filter === 'minors' && FOREX_MAJORS.includes(pair)) return false;
    }
    if (search.trim() && !pair.toUpperCase().includes(search.trim().toUpperCase())) return false;
    return true;
  });

  async function handleAdd(symbol) {
    setRowErrors(p => ({ ...p, [symbol]: undefined }));
    setAdded(p => ({ ...p, [symbol]: true }));
    setPending(p => ({ ...p, [symbol]: true }));
    try {
      await onAdd(symbol);
    } catch (e) {
      setAdded(p => ({ ...p, [symbol]: false }));
      setRowErrors(p => ({
        ...p,
        [symbol]: e.message === 'asset_limit_reached' ? 'Slot limit reached' : (e.message || 'Failed to add'),
      }));
    } finally {
      setPending(p => ({ ...p, [symbol]: false }));
    }
  }

  return (
    <div className="browser-modal-overlay" onClick={onClose}>
      <div className="browser-modal-box" onClick={e => e.stopPropagation()}>
        <div className="browser-modal-header">
          <div className="modal-title" style={{ marginBottom: 0, border: 'none', paddingBottom: 0 }}>Add Asset</div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="tabs">
          <button className={`tab ${activeTab === 'forex' ? 'active' : ''}`} onClick={() => setActiveTab('forex')}>Forex</button>
          <button className={`tab ${activeTab === 'crypto' ? 'active' : ''}`} onClick={() => setActiveTab('crypto')}>Crypto</button>
        </div>

        {limitReached && !bannerDismissed && (
          <div className="browser-limit-banner">
            <span>Pay $30.00 to unlock more assets. This is for server maintenance and data access.</span>
            <button onClick={() => setBannerDismissed(true)} aria-label="Dismiss">✕</button>
          </div>
        )}

        {activeTab === 'forex' && (
          <>
            <div className="chip-row">
              {[['all', 'All'], ['majors', 'Majors'], ['minors', 'Minors']].map(([key, label]) => (
                <button
                  key={key}
                  className={`chip ${filter === key ? 'active' : ''}`}
                  onClick={() => setFilter(key)}
                >
                  {label}
                </button>
              ))}
            </div>
            <input
              className="search-input"
              placeholder="Search pairs…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ marginBottom: 'var(--sp-md)' }}
            />
          </>
        )}

        <div className="browser-list">
          {filtered.length === 0 ? (
            <p className="text-muted" style={{ textAlign: 'center', padding: 24 }}>No matches</p>
          ) : filtered.map(symbol => {
            const owned      = isOwned(symbol);
            const isPending  = pending[symbol];
            const rowError   = rowErrors[symbol];
            const locked     = limitReached && !owned;

            return (
              <div className="browser-row-wrap" key={symbol}>
                <div className="browser-row">
                  <span className="browser-symbol">{symbol}</span>
                  {owned ? (
                    <span className="browser-added">✓ Added</span>
                  ) : locked ? (
                    <button className="browser-add-btn browser-add-btn-locked" disabled>🔒</button>
                  ) : (
                    <button
                      className="browser-add-btn"
                      disabled={isPending}
                      onClick={() => handleAdd(symbol)}
                    >
                      {isPending ? '…' : '+ Add'}
                    </button>
                  )}
                </div>
                {rowError && <p className="browser-row-error">{rowError}</p>}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

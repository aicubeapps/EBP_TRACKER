import { useState, useEffect } from 'react';
import { useAuth } from '@clerk/clerk-react';
import api from '../lib/api';
import PriceFeedPanel from '../components/PriceFeedPanel';

const TABS = ['Users', 'API Keys', 'User Limits', 'Price Feed'];
const ALL_TFS      = ['M5', 'M15', 'M30', '1H', '4H', 'D', 'W'];
const ALL_NSE_TFS  = ['M1', 'M5', 'M15', 'M30', '1H', 'D'];

export default function Admin() {
  const { getToken }                    = useAuth();
  const [tab, setTab]                   = useState(0);
  const [isAdmin, setIsAdmin]           = useState(null);
  const [users, setUsers]               = useState([]);
  const [keys, setKeys]                 = useState([]);
  const [loading, setLoading]           = useState(true);
  const [newKey, setNewKey]             = useState({ source: 'twelvedata', key_value: '', label: '' });
  const [addingKey, setAddingKey]       = useState(false);
  const [editingLimit, setEditingLimit] = useState({});
  const [expandedUsers, setExpandedUsers] = useState({});
  const [userAssets, setUserAssets]       = useState({});
  const [userTfAccess, setUserTfAccess]   = useState({});
  const [userNseTfAccess, setUserNseTfAccess] = useState({});
  const [detailLoading, setDetailLoading] = useState({});
  const [tfError, setTfError]             = useState({});
  const [nseTfError, setNseTfError]       = useState({});
  const [upstoxToken, setUpstoxToken]     = useState('');
  const [savingUpstox, setSavingUpstox]   = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const token = await getToken();
        const me    = await api.get('/user/me', token);
        const admin = me.is_admin === 1;
        setIsAdmin(admin);
        if (admin) {
          const [u, k] = await Promise.all([
            api.get('/admin/users',    token),
            api.get('/admin/api-keys', token),
          ]);
          setUsers(Array.isArray(u) ? u : []);
          setKeys(Array.isArray(k) ? k : []);
        }
      } catch (e) {
        console.error('Admin load error:', e);
        setIsAdmin(false);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const handleExpire = async (userId) => {
    if (!window.confirm('Expire this user account?')) return;
    const token = await getToken();
    await api.post(`/admin/expire/${userId}`, {}, token);
    const u = await api.get('/admin/users', token);
    setUsers(Array.isArray(u) ? u : []);
  };

  const loadKeys = async () => {
    const token = await getToken();
    const k = await api.get('/admin/api-keys', token);
    setKeys(Array.isArray(k) ? k : []);
  };

  const handleAddKey = async () => {
    setAddingKey(true);
    try {
      const token = await getToken();
      await api.post('/admin/api-keys', newKey, token);
      setNewKey({ source: 'twelvedata', key_value: '', label: '' });
      await loadKeys();
    } finally {
      setAddingKey(false);
    }
  };

  const handleToggleKey = async (id, enabled) => {
    const token = await getToken();
    await api.patch(`/admin/api-keys/${id}`, { enabled }, token);
    await loadKeys();
  };

  const handleDeleteKey = async (id) => {
    if (!window.confirm('Delete this API key?')) return;
    const token = await getToken();
    await api.delete(`/admin/api-keys/${id}`, token);
    await loadKeys();
  };

  const handleUpdateLimit = async (userId, limit) => {
    const token = await getToken();
    await api.patch(`/admin/users/${userId}/asset-limit`, { asset_limit: parseInt(limit, 10) }, token);
    setEditingLimit(p => ({ ...p, [userId]: undefined }));
    const u = await api.get('/admin/users', token);
    setUsers(Array.isArray(u) ? u : []);
  };

  const toggleUserExpand = async (userId) => {
    const nowExpanded = !expandedUsers[userId];
    setExpandedUsers(p => ({ ...p, [userId]: nowExpanded }));
    if (!nowExpanded || userTfAccess[userId] !== undefined) return;

    setDetailLoading(p => ({ ...p, [userId]: true }));
    try {
      const token = await getToken();
      const [assets, tf, nseTf] = await Promise.all([
        api.get(`/admin/users/${userId}/assets`, token),
        api.get(`/admin/users/${userId}/tf-access`, token),
        api.get(`/admin/users/${userId}/nse-tf-access`, token),
      ]);
      setUserAssets(p => ({ ...p, [userId]: Array.isArray(assets) ? assets : [] }));
      setUserTfAccess(p => ({ ...p, [userId]: tf?.tf_access ?? ALL_TFS }));
      setUserNseTfAccess(p => ({ ...p, [userId]: nseTf?.nse_tf_access ?? ALL_NSE_TFS }));
    } catch (e) {
      setUserAssets(p => ({ ...p, [userId]: [] }));
      setUserTfAccess(p => ({ ...p, [userId]: ALL_TFS }));
      setUserNseTfAccess(p => ({ ...p, [userId]: ALL_NSE_TFS }));
      setTfError(p => ({ ...p, [userId]: 'Failed to load user details' }));
    } finally {
      setDetailLoading(p => ({ ...p, [userId]: false }));
    }
  };

  const handleTfToggle = async (userId, tf, checked) => {
    const prev = userTfAccess[userId] ?? ALL_TFS;
    const next = checked ? [...prev, tf] : prev.filter(t => t !== tf);
    setUserTfAccess(p => ({ ...p, [userId]: next }));
    setTfError(p => ({ ...p, [userId]: undefined }));
    try {
      const token = await getToken();
      await api.patch(`/admin/users/${userId}/tf-access`, { tf_access: next }, token);
    } catch (e) {
      setUserTfAccess(p => ({ ...p, [userId]: prev }));
      setTfError(p => ({ ...p, [userId]: e.message || 'Failed to update timeframe access' }));
    }
  };

  const handleNseTfToggle = async (userId, tf, checked) => {
    const prev = userNseTfAccess[userId] ?? ALL_NSE_TFS;
    const next = checked ? [...prev, tf] : prev.filter(t => t !== tf);
    setUserNseTfAccess(p => ({ ...p, [userId]: next }));
    setNseTfError(p => ({ ...p, [userId]: undefined }));
    try {
      const token = await getToken();
      await api.patch(`/admin/users/${userId}/nse-tf-access`, { nse_tf_access: next }, token);
    } catch (e) {
      setUserNseTfAccess(p => ({ ...p, [userId]: prev }));
      setNseTfError(p => ({ ...p, [userId]: e.message || 'Failed to update timeframe access' }));
    }
  };

  const handleSaveUpstox = async () => {
    if (!upstoxToken.trim()) return;
    setSavingUpstox(true);
    try {
      const token = await getToken();
      await api.post('/admin/api-keys', { source: 'upstox', key_value: upstoxToken.trim(), label: 'Upstox Analytics Token' }, token);
      setUpstoxToken('');
      await loadKeys();
    } finally {
      setSavingUpstox(false);
    }
  };

  if (loading) {
    return <div className="shell" style={{ textAlign: 'center', paddingTop: 60 }}><span className="spinner" /></div>;
  }

  if (!isAdmin) {
    return (
      <div className="shell" style={{ textAlign: 'center', paddingTop: 60 }}>
        <div style={{ fontSize: 40, marginBottom: 8 }}>🚫</div>
        <div className="page-title" style={{ marginBottom: 4 }}>Access Denied</div>
        <p className="text-muted">This panel is restricted to administrators.</p>
      </div>
    );
  }

  return (
    <div className="shell-wide">
      <div className="page-title">Admin Panel</div>

      <div className="tabs">
        {TABS.map((t, i) => (
          <button key={t} className={`tab ${tab === i ? 'active' : ''}`} onClick={() => setTab(i)}>
            {t}
          </button>
        ))}
      </div>

      {tab === 0 && (
        <div>
          {users.length === 0 ? (
            <div className="card" style={{ textAlign: 'center', color: 'var(--muted)', padding: 24 }}>
              No users yet
            </div>
          ) : users.map(u => {
            const expanded    = !!expandedUsers[u.id];
            const assets      = userAssets[u.id] ?? [];
            const tfAccess    = userTfAccess[u.id] ?? ALL_TFS;
            const nseTfAccess = userNseTfAccess[u.id] ?? ALL_NSE_TFS;

            return (
              <div key={u.id} className="card">
                <button className="user-card-header" onClick={() => toggleUserExpand(u.id)}>
                  <div>
                    <div className="card-title">{u.email || u.id.slice(0, 16) + '...'}</div>
                    <span className="text-muted" style={{ fontSize: 11 }}>
                      {u.asset_count ?? 0} / {u.asset_limit ?? 5} slots · {u.active ? 'Active' : 'Inactive'}
                    </span>
                  </div>
                  <span className={`user-card-chevron ${expanded ? 'expanded' : ''}`}>▸</span>
                </button>

                {expanded && (
                  <div className="user-card-body">
                    {/* Section A — user info + assets (view only) */}
                    <div className="section-heading">User Info</div>
                    <div style={{ fontSize: 12, marginBottom: 'var(--sp-md)', lineHeight: 1.8 }}>
                      <div><span className="text-muted">Name:</span> {u.name ?? '—'}</div>
                      <div><span className="text-muted">Created:</span> {new Date(u.created_at).toLocaleDateString()}</div>
                      <div>
                        <span className="text-muted">Status:</span>{' '}
                        <span className={`badge ${u.active ? 'badge-bull' : 'badge-bear'}`}>
                          {u.active ? 'ACTIVE' : 'INACTIVE'}
                        </span>
                      </div>
                    </div>

                    <div className="section-heading">
                      Assets ({u.asset_count ?? 0} / {u.asset_limit ?? 5} slots used)
                    </div>
                    {detailLoading[u.id] ? (
                      <span className="spinner" />
                    ) : (
                      <div className="table-wrap" style={{ marginBottom: 'var(--sp-md)' }}>
                        <table className="alert-table">
                          <thead><tr><th>Symbol</th><th>Type</th><th>Added</th></tr></thead>
                          <tbody>
                            {assets.length === 0 ? (
                              <tr><td colSpan={3} style={{ textAlign: 'center', color: 'var(--muted)', padding: 16 }}>No assets</td></tr>
                            ) : assets.map(a => (
                              <tr key={a.symbol + a.added_at}>
                                <td className="text-mono">{a.symbol}</td>
                                <td>
                                  <span className={`badge badge-${(a.asset_type ?? 'forex').toLowerCase().replace(/\s/g, '_')}`}>
                                    {a.asset_type}
                                  </span>
                                </td>
                                <td className="ts-cell">{new Date(a.added_at).toLocaleDateString()}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}

                    <div className="divider" />

                    {/* Section B — slot limit control */}
                    <div className="section-heading">Slot Limit</div>
                    <div className="config-row">
                      <span className="text-muted" style={{ fontSize: 11 }}>{u.asset_limit ?? 5} slots</span>
                      <button className="add-link" onClick={() => handleUpdateLimit(u.id, (u.asset_limit ?? 5) + 3)}>
                        +3 Slots
                      </button>
                    </div>

                    <div className="divider" />

                    {/* Section C — TF access checkboxes */}
                    <div className="section-heading">Timeframe Access</div>
                    <div className="tf-check-grid">
                      {ALL_TFS.map(tf => (
                        <label key={tf} className="tf-check-row">
                          <input
                            type="checkbox"
                            checked={tfAccess.includes(tf)}
                            onChange={e => handleTfToggle(u.id, tf, e.target.checked)}
                          />
                          <span>{tf}</span>
                        </label>
                      ))}
                    </div>
                    <p className="text-muted" style={{ fontSize: 11, marginTop: 'var(--sp-sm)' }}>
                      Disabling a TF stops alerts for that user on that timeframe. Existing configs are preserved.
                    </p>
                    {tfError[u.id] && (
                      <p style={{ color: '#ef4444', fontSize: 11, marginTop: 4 }}>{tfError[u.id]}</p>
                    )}

                    <div className="divider" />

                    {/* NSE TF access checkboxes — separate column, separate default set */}
                    <div className="section-heading">NSE Market TF Access</div>
                    <div className="tf-check-grid">
                      {ALL_NSE_TFS.map(tf => (
                        <label key={tf} className="tf-check-row">
                          <input
                            type="checkbox"
                            checked={nseTfAccess.includes(tf)}
                            onChange={e => handleNseTfToggle(u.id, tf, e.target.checked)}
                          />
                          <span>{tf}</span>
                        </label>
                      ))}
                    </div>
                    <p className="text-muted" style={{ fontSize: 11, marginTop: 'var(--sp-sm)' }}>
                      Disabling a TF stops NSE alerts for that user on that timeframe. Existing configs are preserved.
                    </p>
                    {nseTfError[u.id] && (
                      <p style={{ color: '#ef4444', fontSize: 11, marginTop: 4 }}>{nseTfError[u.id]}</p>
                    )}

                    <div className="divider" />
                    <button className="btn btn-danger btn-sm" onClick={() => handleExpire(u.id)}>Expire Account</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {tab === 1 && (
        <div>
          <div className="section-heading">Upstox Analytics Token</div>
          {(() => {
            const upstoxKey = keys.find(k => k.source === 'upstox');
            if (!upstoxKey) {
              return (
                <div className="card">
                  <p className="text-muted" style={{ fontSize: 12, marginBottom: 'var(--sp-sm)' }}>
                    Not configured — Yahoo Finance active
                  </p>
                  <div className="config-row" style={{ marginBottom: 0 }}>
                    <input className="search-input" style={{ maxWidth: 320 }}
                      type="password"
                      placeholder="Upstox Analytics Token"
                      value={upstoxToken}
                      onChange={e => setUpstoxToken(e.target.value)} />
                    <button className="search-btn" onClick={handleSaveUpstox} disabled={savingUpstox || !upstoxToken.trim()}>
                      {savingUpstox ? '…' : 'Save'}
                    </button>
                  </div>
                </div>
              );
            }
            const expiry        = upstoxKey.added_at + 365 * 24 * 60 * 60 * 1000;
            const daysLeft       = Math.floor((expiry - Date.now()) / (24 * 60 * 60 * 1000));
            const expiringSoon   = daysLeft <= 30;
            return (
              <div className="card">
                <div className="card-header">
                  <span className="card-title">Upstox Analytics Token</span>
                  <span className="badge badge-bull">Active — Upstox primary</span>
                </div>
                <div style={{ fontSize: 12, lineHeight: 1.8, marginBottom: 'var(--sp-sm)' }}>
                  <div><span className="text-muted">Created:</span> {new Date(upstoxKey.added_at).toLocaleDateString()}</div>
                  <div>
                    <span className="text-muted">Expires:</span> {new Date(expiry).toLocaleDateString()}
                    {expiringSoon && (
                      <span className="badge" style={{ marginLeft: 6, background: 'var(--gold-lt)', color: 'var(--gold)' }}>
                        {daysLeft <= 0 ? 'Expired' : `Expires in ${daysLeft}d`}
                      </span>
                    )}
                  </div>
                </div>
                <div className="divider" />
                <button className="add-link" style={{ color: '#ef4444' }} onClick={() => handleDeleteKey(upstoxKey.id)}>
                  Delete Token
                </button>
              </div>
            );
          })()}

          <div className="divider" />
          <div className="section-heading">API Keys</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 'var(--sp-md)' }}>
            {/* Card 1 — every key regardless of active status */}
            <div className="card">
              <div className="card-header">
                <span className="card-title">Available API Keys</span>
              </div>
              {keys.filter(k => k.source !== 'upstox').length === 0 ? (
                <div style={{ textAlign: 'center', color: 'var(--muted)', padding: 24 }}>No API keys yet</div>
              ) : keys.filter(k => k.source !== 'upstox').map((k, i) => (
                <div key={k.id}>
                  {i > 0 && <div className="divider" />}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span className="card-title" style={{ fontSize: 13 }}>{k.label}</span>
                    <span className={`badge ${k.enabled ? 'badge-t3' : 'badge-bear'}`}>
                      {k.enabled ? 'Active' : 'Inactive'}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, marginTop: 4, marginBottom: 6 }}>
                    <span className="text-muted">Key:</span> <span className="text-mono">{k.key_preview}</span>
                  </div>
                  <button className="add-link" onClick={() => handleToggleKey(k.id, !k.enabled)}>
                    {k.enabled ? 'Disable' : 'Enable'}
                  </button>
                  {' · '}
                  <button className="add-link" style={{ color: '#ef4444' }} onClick={() => handleDeleteKey(k.id)}>
                    Delete
                  </button>
                </div>
              ))}

              <div className="divider" />
              <div className="section-heading">Add New Key</div>
              <div className="config-row">
                <select className="select-sm" value={newKey.source}
                  onChange={e => setNewKey(p => ({ ...p, source: e.target.value }))}>
                  <option value="twelvedata">Twelve Data</option>
                  <option value="yahoo">Yahoo</option>
                </select>
                <input className="search-input" style={{ maxWidth: 200 }}
                  placeholder="Label e.g. Key 4"
                  value={newKey.label}
                  onChange={e => setNewKey(p => ({ ...p, label: e.target.value }))} />
                <input className="search-input" style={{ maxWidth: 300 }}
                  placeholder="API key value"
                  type="password"
                  value={newKey.key_value}
                  onChange={e => setNewKey(p => ({ ...p, key_value: e.target.value }))} />
                <button className="search-btn" onClick={handleAddKey} disabled={addingKey || !newKey.key_value || !newKey.label}>
                  {addingKey ? '…' : 'Add'}
                </button>
              </div>
            </div>

            {/* Card 2 — usage for active keys only */}
            <div className="card">
              <div className="card-header">
                <span className="card-title">Active API Keys</span>
              </div>
              {(() => {
                const activeKeys = keys.filter(k => k.source !== 'upstox' && k.enabled);
                if (activeKeys.length === 0) {
                  return <div style={{ textAlign: 'center', color: 'var(--muted)', padding: 24 }}>No active API keys configured</div>;
                }
                return activeKeys.map((k, i) => {
                  const pct = k.credits_pct ?? 0;
                  const barClass = (k.exhausted || pct >= 85) ? 'danger' : pct >= 60 ? 'warning' : 'ok';
                  return (
                    <div key={k.id}>
                      {i > 0 && <div className="divider" />}
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span className="card-title" style={{ fontSize: 13 }}>{k.label}</span>
                        {k.exhausted ? <span className="badge badge-bear">EXHAUSTED</span> : null}
                      </div>
                      <div style={{ fontSize: 12, marginTop: 4 }}>
                        <span className="text-muted">Key:</span> <span className="text-mono">{k.key_preview}</span>
                      </div>
                      <div className="progress-bar-wrap">
                        <div className="progress-bar-bg">
                          <div className={`progress-bar-fill ${barClass}`} style={{ width: `${Math.min(pct, 100)}%` }} />
                        </div>
                        <div className="progress-bar-label">
                          {k.calls_today} / {k.daily_limit ?? 800} today ({pct}%)
                        </div>
                      </div>
                      <div style={{ fontSize: 12, marginTop: 6 }}>
                        <span className="text-muted">Resets at:</span>{' '}
                        {k.resets_at_utc ? new Date(k.resets_at_utc).toLocaleString() : '—'}
                      </div>
                    </div>
                  );
                });
              })()}
            </div>
          </div>
        </div>
      )}

      {tab === 2 && (
        <div>
          <div className="section-heading">User Asset Limits</div>
          {users.length === 0 ? (
            <div className="card" style={{ textAlign: 'center', color: 'var(--muted)', padding: 24 }}>No users yet</div>
          ) : users.map(u => (
            <div key={u.id} className="card">
              <div className="card-header">
                <span className="card-title">{u.name ?? u.email}</span>
                <span className="text-muted" style={{ fontSize: 11 }}>{u.asset_count ?? 0} assets used</span>
              </div>
              <div style={{ fontSize: 12, marginBottom: 'var(--sp-sm)' }}>
                <span className="text-muted">Email:</span> <span className="text-mono">{u.email}</span>
              </div>
              <div className="config-row" style={{ marginBottom: 0 }}>
                <input
                  className="select-sm"
                  type="number"
                  min="1"
                  max="50"
                  style={{ width: 60 }}
                  value={editingLimit[u.id] ?? u.asset_limit ?? 5}
                  onChange={e => setEditingLimit(p => ({ ...p, [u.id]: e.target.value }))}
                />
                <button className="add-link"
                  onClick={() => handleUpdateLimit(u.id, editingLimit[u.id] ?? u.asset_limit ?? 5)}>
                  Save
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 3 && <PriceFeedPanel keys={keys} />}
    </div>
  );
}

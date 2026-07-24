import { useState, useEffect } from 'react';
import { useAuth } from '@clerk/clerk-react';
import api from '../lib/api';
import PriceFeedPanel from '../components/PriceFeedPanel';

const TABS = ['Users', 'Invite Tokens', 'API Keys', 'User Limits', 'Price Feed'];
const ALL_TFS      = ['M5', 'M15', 'M30', '1H', '4H', 'D', 'W'];
const SLOT_OPTIONS = [5, 7, 9, 11, 13];

export default function Admin() {
  const { getToken }                    = useAuth();
  const [tab, setTab]                   = useState(0);
  const [isAdmin, setIsAdmin]           = useState(null);
  const [users, setUsers]               = useState([]);
  const [tokens, setTokens]             = useState([]);
  const [keys, setKeys]                 = useState([]);
  const [loading, setLoading]           = useState(true);
  const [newKey, setNewKey]             = useState({ source: 'twelvedata', key_value: '', label: '' });
  const [addingKey, setAddingKey]       = useState(false);
  const [editingLimit, setEditingLimit] = useState({});
  const [expandedUsers, setExpandedUsers] = useState({});
  const [userAssets, setUserAssets]       = useState({});
  const [userTfAccess, setUserTfAccess]   = useState({});
  const [detailLoading, setDetailLoading] = useState({});
  const [tfError, setTfError]             = useState({});

  useEffect(() => {
    (async () => {
      try {
        const token = await getToken();
        const me    = await api.get('/user/me', token);
        const admin = me.is_admin === 1;
        setIsAdmin(admin);
        if (admin) {
          const [u, t, k] = await Promise.all([
            api.get('/admin/users',    token),
            api.get('/admin/tokens',   token),
            api.get('/admin/api-keys', token),
          ]);
          setUsers(Array.isArray(u) ? u : []);
          setTokens(Array.isArray(t) ? t : []);
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

  const handleGenerateToken = async () => {
    const token = await getToken();
    const data  = await api.post('/admin/invite', {}, token);
    alert(`New invite URL:\n${data.url}`);
    const t = await api.get('/admin/tokens', token);
    setTokens(Array.isArray(t) ? t : []);
  };

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
      const [assets, tf] = await Promise.all([
        api.get(`/admin/users/${userId}/assets`, token),
        api.get(`/admin/users/${userId}/tf-access`, token),
      ]);
      setUserAssets(p => ({ ...p, [userId]: Array.isArray(assets) ? assets : [] }));
      setUserTfAccess(p => ({ ...p, [userId]: tf?.tf_access ?? ALL_TFS }));
    } catch (e) {
      setUserAssets(p => ({ ...p, [userId]: [] }));
      setUserTfAccess(p => ({ ...p, [userId]: ALL_TFS }));
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
            const expanded  = !!expandedUsers[u.id];
            const assets    = userAssets[u.id] ?? [];
            const tfAccess  = userTfAccess[u.id] ?? ALL_TFS;
            const slotOptions = SLOT_OPTIONS.includes(u.asset_limit)
              ? SLOT_OPTIONS
              : [...SLOT_OPTIONS, u.asset_limit].sort((a, b) => a - b);

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
                      <select
                        className="select-sm"
                        value={u.asset_limit ?? 5}
                        onChange={e => handleUpdateLimit(u.id, e.target.value)}
                      >
                        {slotOptions.map(n => <option key={n} value={n}>{n}</option>)}
                      </select>
                      <span className="text-muted" style={{ fontSize: 11 }}>slots</span>
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
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
            <button className="btn btn-primary" onClick={handleGenerateToken}>+ Generate Token</button>
          </div>
          <div className="card" style={{ padding: 0 }}>
            <div className="table-wrap">
              <table className="alert-table">
                <thead>
                  <tr><th>Token</th><th>Status</th><th>Used By</th><th>Created</th></tr>
                </thead>
                <tbody>
                  {tokens.length === 0 ? (
                    <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--muted)', padding: 24 }}>No tokens yet</td></tr>
                  ) : tokens.map(t => (
                    <tr key={t.token}>
                      <td className="text-mono">{t.token}</td>
                      <td><span className="badge">{t.used_by ? 'USED' : 'UNUSED'}</span></td>
                      <td>{t.used_by || '—'}</td>
                      <td className="ts-cell">{new Date(t.created_at).toLocaleDateString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {tab === 2 && (
        <div>
          <div className="section-heading">API Keys</div>
          <div className="card" style={{ padding: 0 }}>
            <div className="table-wrap">
              <table className="alert-table">
                <thead>
                  <tr>
                    <th>Label</th><th>Source</th><th>Key</th>
                    <th>Status</th><th>Calls Today</th><th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {keys.length === 0 ? (
                    <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--muted)', padding: 24 }}>No API keys yet</td></tr>
                  ) : keys.map(k => (
                    <tr key={k.id}>
                      <td className="text-mono">{k.label}</td>
                      <td><span className="badge badge-forex">{k.source}</span></td>
                      <td className="text-mono">{k.key_preview}</td>
                      <td>
                        <span className={`badge ${k.exhausted ? 'badge-bear' : 'badge-t3'}`}>
                          {k.exhausted ? 'Exhausted' : k.enabled ? 'Active' : 'Disabled'}
                        </span>
                      </td>
                      <td className="tabular-nums">{k.calls_today}</td>
                      <td>
                        <button className="add-link" onClick={() => handleToggleKey(k.id, !k.enabled)}>
                          {k.enabled ? 'Disable' : 'Enable'}
                        </button>
                        {' · '}
                        <button className="add-link" style={{ color: '#ef4444' }} onClick={() => handleDeleteKey(k.id)}>
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

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
      )}

      {tab === 3 && (
        <div>
          <div className="section-heading">User Asset Limits</div>
          <div className="card" style={{ padding: 0 }}>
            <div className="table-wrap">
              <table className="alert-table">
                <thead>
                  <tr>
                    <th>User</th><th>Email</th><th>Current Limit</th>
                    <th>Assets Used</th><th>Update Limit</th>
                  </tr>
                </thead>
                <tbody>
                  {users.length === 0 ? (
                    <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--muted)', padding: 24 }}>No users yet</td></tr>
                  ) : users.map(u => (
                    <tr key={u.id}>
                      <td className="text-mono">{u.name ?? '—'}</td>
                      <td className="text-mono">{u.email}</td>
                      <td className="tabular-nums">{u.asset_limit ?? 5}</td>
                      <td className="tabular-nums">{u.asset_count ?? 0}</td>
                      <td>
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
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {tab === 4 && <PriceFeedPanel keys={keys} />}
    </div>
  );
}

import { useState, useEffect } from 'react';
import { useAuth } from '@clerk/clerk-react';
import api from '../lib/api';
import PriceFeedPanel from '../components/PriceFeedPanel';

const TABS = ['Users', 'Invite Tokens', 'API Keys', 'User Limits', 'Price Feed'];

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
        <div className="card" style={{ padding: 0 }}>
          <div className="table-wrap">
            <table className="alert-table">
              <thead>
                <tr>
                  <th>Email</th><th>Plan</th><th>Expiry</th>
                  <th>Assets</th><th>Alerts</th><th>Telegram</th><th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.length === 0 ? (
                  <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--muted)', padding: 24 }}>No users yet</td></tr>
                ) : users.map(u => (
                  <tr key={u.id}>
                    <td>{u.email || u.id.slice(0, 16) + '...'}</td>
                    <td><span className="badge">{u.plan?.toUpperCase() ?? 'FREE'}</span></td>
                    <td className="ts-cell tabular-nums">{new Date(u.expires_at).toLocaleDateString()}</td>
                    <td className="tabular-nums">{u.asset_count}</td>
                    <td className="tabular-nums">{u.alert_count}</td>
                    <td>{u.telegram_verified ? '✅' : '—'}</td>
                    <td>
                      <button className="btn btn-danger btn-sm" onClick={() => handleExpire(u.id)}>Expire</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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

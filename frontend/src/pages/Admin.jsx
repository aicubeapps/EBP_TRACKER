import { useState, useEffect } from 'react';
import { useAuth } from '@clerk/clerk-react';
import api from '../lib/api';

const TABS = ['Users', 'Payments', 'Invite Tokens', 'Tier Config'];

export default function Admin() {
  const { getToken }                  = useAuth();
  const [tab, setTab]                 = useState(0);
  const [isAdmin, setIsAdmin]         = useState(null);
  const [users, setUsers]             = useState([]);
  const [payments, setPayments]       = useState([]);
  const [tokens, setTokens]           = useState([]);
  const [tiers, setTiers]             = useState([]);
  const [loading, setLoading]         = useState(true);
  const [editingTier, setEditingTier] = useState(null);
  const [tierForm, setTierForm]       = useState({});
  const [savingTier, setSavingTier]   = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const token = await getToken();
        const me    = await api.get('/user/me', token);
        const admin = me.is_admin === 1;
        setIsAdmin(admin);
        if (admin) {
          const [u, p, t, tc] = await Promise.all([
            api.get('/admin/users',    token),
            api.get('/admin/payments', token),
            api.get('/admin/tokens',   token),
            api.get('/admin/tiers',    token),
          ]);
          setUsers(Array.isArray(u) ? u : []);
          setPayments(Array.isArray(p) ? p : []);
          setTokens(Array.isArray(t) ? t : []);
          setTiers(Array.isArray(tc) ? tc : []);
        }
      } catch (e) {
        console.error('Admin load error:', e);
        setIsAdmin(false);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const handleApprove = async (paymentId) => {
    const token = await getToken();
    await api.post(`/admin/approve/${paymentId}`, {}, token);
    const p = await api.get('/admin/payments', token);
    setPayments(Array.isArray(p) ? p : []);
  };

  const handleReject = async (paymentId) => {
    const token = await getToken();
    await api.post(`/admin/reject/${paymentId}`, {}, token);
    const p = await api.get('/admin/payments', token);
    setPayments(Array.isArray(p) ? p : []);
  };

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
        <div className="card" style={{ padding: 0 }}>
          <div className="table-wrap">
            <table className="alert-table">
              <thead>
                <tr>
                  <th>Email</th><th>Tier</th><th>Amount</th>
                  <th>UTR Ref</th><th>Submitted</th><th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {payments.length === 0 ? (
                  <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--muted)', padding: 24 }}>No payments yet</td></tr>
                ) : payments.map(p => (
                  <tr key={p.id}>
                    <td>{p.email}</td>
                    <td>{p.tier}</td>
                    <td className="tabular-nums">₹{p.amount_inr}</td>
                    <td className="text-mono">{p.upi_ref || '—'}</td>
                    <td className="ts-cell">{new Date(p.submitted_at).toLocaleDateString()}</td>
                    <td>
                      {p.status === 'pending' ? (
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button className="btn btn-success btn-sm" onClick={() => handleApprove(p.id)}>Approve</button>
                          <button className="btn btn-danger btn-sm" onClick={() => handleReject(p.id)}>Reject</button>
                        </div>
                      ) : (
                        <span className={`badge badge-${p.status === 'approved' ? 't3' : 'sweep'}`}>{p.status.toUpperCase()}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 2 && (
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

      {tab === 3 && (
        <div>
          <p className="text-muted mb-md" style={{ fontSize: 12 }}>
            Modify tier pricing and asset slot limits. Changes take effect immediately for new payments.
            Existing approved users are not affected.
          </p>

          {tiers.map(tier => (
            <div key={tier.tier} className="card">
              {editingTier === tier.tier ? (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                    <span style={{ fontSize: 20 }}>{tier.emoji}</span>
                    <span className="card-title">{tier.label}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 16, marginBottom: 12, flexWrap: 'wrap' }}>
                    <div style={{ width: 140 }}>
                      <label className="input-label">Price (₹)</label>
                      <input className="input" type="number" min={1}
                        value={tierForm.price_inr}
                        onChange={e => setTierForm(f => ({ ...f, price_inr: parseInt(e.target.value) }))} />
                    </div>
                    <div style={{ width: 140 }}>
                      <label className="input-label">Asset Slots</label>
                      <input className="input" type="number" min={1} max={100}
                        value={tierForm.asset_limit}
                        onChange={e => setTierForm(f => ({ ...f, asset_limit: parseInt(e.target.value) }))} />
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className="btn btn-success btn-sm" disabled={savingTier} onClick={async () => {
                      setSavingTier(true);
                      try {
                        const token = await getToken();
                        await api.patch(`/admin/tiers/${tier.tier}`, { ...tier, ...tierForm }, token);
                        const tc = await api.get('/admin/tiers', token);
                        setTiers(Array.isArray(tc) ? tc : []);
                        setEditingTier(null);
                      } finally {
                        setSavingTier(false);
                      }
                    }}>
                      {savingTier ? <span className="spinner" /> : null} Save
                    </button>
                    <button className="btn btn-outline btn-sm" onClick={() => setEditingTier(null)}>Cancel</button>
                  </div>
                </>
              ) : (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <span style={{ fontSize: 24 }}>{tier.emoji}</span>
                    <div>
                      <div className="card-title" style={{ borderBottom: 'none', paddingBottom: 0 }}>{tier.label}</div>
                      <div className="text-muted">₹{tier.price_inr} / 30 days · {tier.asset_limit} asset slots</div>
                    </div>
                  </div>
                  <button className="icon-btn" style={{ fontSize: 16 }} onClick={() => {
                    setEditingTier(tier.tier);
                    setTierForm({ price_inr: tier.price_inr, asset_limit: tier.asset_limit });
                  }}>✎</button>
                </div>
              )}
            </div>
          ))}

          {tiers.length === 0 && (
            <div className="banner banner-info">No tier config found. Run the SQL migration in D1 Console first.</div>
          )}
        </div>
      )}
    </div>
  );
}

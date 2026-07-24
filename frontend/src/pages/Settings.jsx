import { useState, useEffect } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { useUser } from '../hooks/useUser';
import api from '../lib/api';
import { fmtDate, fmtNY, capitalise } from '../lib/utils';

function dotClass(lastCall) {
  if (!lastCall) return 'dead';
  const age = Date.now() - lastCall;
  if (age < 30 * 60 * 1000) return 'live';
  if (age < 60 * 60 * 1000) return 'warn';
  return 'dead';
}

export default function Settings() {
  const { getToken } = useAuth();
  const { user }     = useUser();

  // Data sources
  const [dsHealth,  setDsHealth]  = useState(null);
  const [dsLoading, setDsLoading] = useState(true);

  const fetchDsHealth = async () => {
    try {
      const token = await getToken();
      const data  = await api.get('/health/datasources', token);
      setDsHealth(data);
    } catch (e) {
      console.error('Health fetch failed:', e);
      setDsHealth({
        sources: {
          finnhub:    { lastCall: null, callsToday: 0, lastSuccess: false },
          yahoo:      { lastCall: null, callsToday: 0, lastSuccess: false },
          twelvedata: { lastCall: null, callsToday: 0, lastSuccess: false },
        },
        twelvedataToday: 0,
        twelvedataLimit: 800,
      });
    }
    setDsLoading(false);
  };

  useEffect(() => {
    fetchDsHealth();
    const iv = setInterval(fetchDsHealth, 5 * 60 * 1000);
    return () => clearInterval(iv);
  }, []);

  // Telegram
  const [tgStatus, setTgStatus]     = useState(null);
  const [linkCode, setLinkCode]     = useState('');
  const [polling, setPolling]       = useState(false);
  const [testing, setTesting]       = useState(false);
  const [generating, setGenerating] = useState(false);
  const [msg, setMsg]               = useState({ text: '', kind: 'info' });

  const fetchTgStatus = async () => {
    try {
      const token = await getToken();
      const data  = await api.get('/user/telegram', token);
      setTgStatus(data);
      return data;
    } catch {}
  };

  useEffect(() => { fetchTgStatus(); }, []);

  useEffect(() => {
    if (!polling || !linkCode) return;
    const interval = setInterval(async () => {
      try {
        const token = await getToken();
        const data  = await api.post('/user/telegram/verify', {}, token);
        if (data?.verified) {
          setPolling(false);
          setLinkCode('');
          await fetchTgStatus();
          setMsg({ text: 'Telegram connected successfully!', kind: 'success' });
        }
      } catch {}
    }, 3000);
    return () => clearInterval(interval);
  }, [polling, linkCode]);

  const handleGetCode = async () => {
    setGenerating(true);
    setMsg({ text: '', kind: 'info' });
    try {
      const token = await getToken();
      const data  = await api.post('/user/telegram/initlink', {}, token);
      setLinkCode(data.code);
      setPolling(true);
    } catch (e) {
      setMsg({ text: e.message, kind: 'error' });
    } finally {
      setGenerating(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setMsg({ text: '', kind: 'info' });
    try {
      const token = await getToken();
      await api.post('/user/telegram/test', {}, token);
      setMsg({ text: 'Test message sent! Check your Telegram.', kind: 'success' });
    } catch (e) {
      setMsg({ text: e.message, kind: 'error' });
    } finally {
      setTesting(false);
    }
  };

  const handleDisconnect = async () => {
    if (!window.confirm('Disconnect Telegram? You will stop receiving alerts.')) return;
    try {
      const token = await getToken();
      await api.delete('/user/telegram', token);
      setTgStatus({ connected: false });
      setMsg({ text: 'Telegram disconnected.', kind: 'info' });
    } catch (e) {
      setMsg({ text: e.message, kind: 'error' });
    }
  };

  return (
    <div className="shell">
      <div className="page-title">Settings</div>

      {/* Account */}
      <div className="card">
        <div className="section-heading">Account</div>
        <div className="settings-row">
          <span className="settings-label">Joined On</span>
          <span className="settings-value">{fmtDate(user?.created_at)}</span>
        </div>
        <div className="settings-row">
          <span className="settings-label">Asset Slots</span>
          <span className="settings-value">{user?.asset_limit ?? 3}</span>
        </div>
      </div>

      {/* Data Sources */}
      <div className="card">
        <div className="section-heading">Data Sources</div>
        {dsLoading ? (
          <span className="spinner" />
        ) : !dsHealth ? (
          <p className="text-muted">Could not load data source status.</p>
        ) : (
          <>
            {Object.entries(dsHealth.sources ?? {}).map(([name, info]) => (
              <div key={name} className="datasource-row">
                <span className="datasource-name">{capitalise(name)}</span>
                <span className={`datasource-dot ${dotClass(info.lastCall)}`} />
                <span className="datasource-meta">Last: {info.lastCall ? fmtNY(info.lastCall) : 'Never'}</span>
                {name === 'twelvedata' && (
                  <span className="datasource-count">{dsHealth.twelvedataToday}/{dsHealth.twelvedataLimit ?? 800} today</span>
                )}
              </div>
            ))}
            {(dsHealth.twelvedataToday ?? 0) > 0 && (
              <div className="progress-bar-wrap">
                <div className="progress-bar-bg">
                  <div
                    className={`progress-bar-fill ${
                      dsHealth.twelvedataToday > 700 ? 'danger' :
                      dsHealth.twelvedataToday > 500 ? 'warning' : 'ok'
                    }`}
                    style={{ width: `${Math.min(100, (dsHealth.twelvedataToday / (dsHealth.twelvedataLimit ?? 800)) * 100)}%` }}
                  />
                </div>
                <div className="progress-bar-label">
                  Twelve Data daily limit: {dsHealth.twelvedataToday}/{dsHealth.twelvedataLimit ?? 800}
                </div>
              </div>
            )}
            <button className="add-link mt-sm" onClick={fetchDsHealth}>↻ Refresh</button>
          </>
        )}
      </div>

      {/* Telegram */}
      <div className="card">
        <div className="section-heading">Telegram Alerts</div>

        {tgStatus?.connected ? (
          <>
            <div className="banner banner-success">Connected — chat ID {tgStatus.chatIdMasked}</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-outline" onClick={handleTest} disabled={testing}>
                {testing ? <span className="spinner" /> : null} {testing ? 'Sending…' : 'Send Test Alert'}
              </button>
              <button className="btn btn-danger" onClick={handleDisconnect}>Disconnect</button>
            </div>
          </>
        ) : (
          <>
            <div className="banner banner-info">Connect your Telegram to receive EBP alerts directly in your chat.</div>

            {!linkCode ? (
              <>
                <p className="text-muted mb-sm">Steps:</p>
                <p className="text-muted">1. Open <strong>@EbP_Tracker_bot</strong> on Telegram and tap Start</p>
                <p className="text-muted">2. Click the button below to get your 4-digit code</p>
                <p className="text-muted mb-md">3. Send the code to the bot</p>
                <button className="btn btn-primary" onClick={handleGetCode} disabled={generating}>
                  {generating ? <span className="spinner" /> : null} {generating ? 'Generating…' : 'Get Connection Code'}
                </button>
              </>
            ) : (
              <>
                <div className="card" style={{ textAlign: 'center', background: 'var(--cream)' }}>
                  <p className="text-muted mb-sm">Send this code to @EbP_Tracker_bot on Telegram</p>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 32, color: 'var(--nav-bg)', letterSpacing: '0.3em', margin: '8px 0' }}>
                    {linkCode}
                  </div>
                  <p className="text-muted"><span className="spinner" style={{ marginRight: 6 }} /> Waiting for verification…</p>
                </div>
                <button className="add-link" onClick={() => { setLinkCode(''); setPolling(false); }}>Cancel</button>
              </>
            )}
          </>
        )}

        {msg.text && <div className={`banner banner-${msg.kind} mt-md`}>{msg.text}</div>}
      </div>
    </div>
  );
}

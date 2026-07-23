import { useState, useEffect } from 'react';
import { useAuth } from '@clerk/clerk-react';
import * as XLSX from 'xlsx';
import api from '../lib/api';
import { useAssets } from '../hooks/useAssets';
import { fmtNY, capitalise } from '../lib/utils';

function formatBiasAlignment(row) {
  if (!row.trend_bias) return '—';
  const aligned = row.direction === row.trend_bias;
  return `${capitalise(row.trend_bias)}, ${aligned ? 'Aligned' : 'Not Aligned'}`;
}

const TYPE_TABS = ['ALL', 'EBP', 'SWEEP', 'MSS', 'T3'];

export default function Alerts() {
  const { getToken }        = useAuth();
  const { assets }          = useAssets();
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [error, setError]   = useState(null);

  const [typeFilter, setTypeFilter] = useState('ALL');
  const [assetId,    setAssetId]    = useState('all');
  const [direction,  setDirection]  = useState('all');
  const [days,       setDays]       = useState(2);
  const [downloadRange, setDownloadRange] = useState('7');

  useEffect(() => {
    setLoading(true);
    (async () => {
      try {
        const token = await getToken();
        const params = new URLSearchParams({ limit: '200', days: String(days) });
        if (typeFilter !== 'ALL') params.set('type', typeFilter.toLowerCase());
        if (assetId !== 'all') params.set('assetId', assetId);
        const data = await api.get(`/alerts/history?${params}`, token);
        let rows = (Array.isArray(data) ? data : []).map((a, i) => ({ ...a, id: a.id ?? i }));
        if (direction !== 'all') rows = rows.filter(r => r.direction === direction);
        setAlerts(rows);
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [typeFilter, assetId, direction, days]);

  const handleExport = async () => {
    setExporting(true);
    try {
      const token = await getToken();
      const url   = downloadRange === 'all' ? '/alerts/export' : `/alerts/export?days=${downloadRange}`;
      const data  = await api.get(url, token);
      const rows  = (Array.isArray(data) ? data : []).map(r => ({
        'Time (NY)':        fmtNY(r.fired_at),
        'Asset':            r.symbol,
        'Alert Type':       r.alert_type?.toUpperCase(),
        'Direction':        capitalise(r.direction),
        'Timeframe':        r.timeframe,
        'Bias & Alignment': formatBiasAlignment(r),
      }));
      const ws = XLSX.utils.json_to_sheet(rows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Alerts');
      XLSX.writeFile(wb, `forex-alerts-${Date.now()}.xlsx`);
    } catch (e) {
      setError(e.message);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="shell-wide">
      <div className="page-title">Alert History</div>

      {error && <div className="banner banner-error">{error}</div>}

      <div className="download-bar">
        <select className="filter-select" value={downloadRange} onChange={e => setDownloadRange(e.target.value)}>
          <option value="7">Last week</option>
          <option value="30">Last month</option>
          <option value="all">All Alert History</option>
        </select>
        <button className="download-btn" onClick={handleExport} disabled={exporting}>
          {exporting ? <span className="spinner" /> : '⬇'} {exporting ? 'Exporting…' : 'Download'}
        </button>
      </div>

      <div className="filter-bar">
        <div className="filter-tabs">
          {TYPE_TABS.map(t => (
            <button key={t} className={`filter-tab ${typeFilter === t ? 'active' : ''}`}
              onClick={() => setTypeFilter(t)}>{t}</button>
          ))}
        </div>
        <select className="filter-select" value={assetId} onChange={e => setAssetId(e.target.value)}>
          <option value="all">All assets</option>
          {(assets ?? []).map(a => <option key={a.id} value={a.id}>{a.symbol}</option>)}
        </select>
        <select className="filter-select" value={direction} onChange={e => setDirection(e.target.value)}>
          <option value="all">All directions</option>
          <option value="bullish">Bullish</option>
          <option value="bearish">Bearish</option>
        </select>
        <select className="filter-select" value={days} onChange={e => setDays(Number(e.target.value))}>
          <option value={1}>Today</option>
          <option value={2}>Last 2 days</option>
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
        </select>
      </div>

      {loading && <div className="progress-bar-bg mb-md"><div className="progress-bar-fill ok" style={{ width: '100%' }} /></div>}

      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table className="alert-table">
            <thead>
              <tr>
                <th>Time Stamp</th>
                <th>Asset</th>
                <th>Alert Type</th>
                <th>Direction</th>
                <th>TF</th>
                <th>Bias &amp; Alignment</th>
              </tr>
            </thead>
            <tbody>
              {alerts.length === 0 && (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', padding: 32, color: 'var(--muted)' }}>
                    No alerts yet. Add assets and connect Telegram to get started.
                  </td>
                </tr>
              )}
              {alerts.map(r => {
                const aligned = r.direction === r.trend_bias;
                return (
                  <tr key={r.id}>
                    <td className="ts-cell">{fmtNY(r.fired_at)}</td>
                    <td className="asset-cell">{r.symbol}</td>
                    <td><span className={`badge badge-${r.alert_type}`}>{r.alert_type?.toUpperCase()}</span></td>
                    <td>
                      <span className={r.direction === 'bullish' ? 'dir-bull' : 'dir-bear'}>
                        {r.direction === 'bullish' ? '● Bullish' : '● Bearish'}
                      </span>
                    </td>
                    <td className="text-mono">{r.timeframe}</td>
                    <td className={`bias-align-cell ${r.trend_bias ? (aligned ? 'aligned' : 'not-aligned') : ''}`}>
                      {formatBiasAlignment(r)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

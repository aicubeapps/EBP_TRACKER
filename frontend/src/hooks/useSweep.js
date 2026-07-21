import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@clerk/clerk-react';

const SWEEP_WORKER = import.meta.env.VITE_SWEEP_WORKER_URL
  ?? 'https://sweep-detector.aicube-apps.workers.dev';

export function useSweepDashboard() {
  const { getToken, isSignedIn } = useAuth();
  const [sweepStatus, setSweepStatus] = useState({});
  const [loading, setLoading]         = useState(true);

  const fetchStatus = useCallback(async () => {
    if (!isSignedIn) return;
    try {
      const token = await getToken();
      const res   = await fetch(`${SWEEP_WORKER}/sweep/dashboard`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data  = await res.json();
      const map   = {};
      for (const item of (Array.isArray(data) ? data : [])) {
        map[item.symbol] = item.sweepStatus ?? {};
      }
      setSweepStatus(map);
    } catch (e) {
      console.warn('Sweep status fetch failed:', e.message);
    } finally {
      setLoading(false);
    }
  }, [isSignedIn]);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 60_000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  return { sweepStatus, loading, refetch: fetchStatus };
}

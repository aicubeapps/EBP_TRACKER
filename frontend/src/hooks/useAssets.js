import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@clerk/clerk-react';
import api from '../lib/api';

export function useAssets() {
  const { getToken, isSignedIn } = useAuth();
  const [assets, setAssets]     = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);

  const fetchAssets = useCallback(async () => {
    if (!isSignedIn) return;
    try {
      const token = await getToken();
      const data  = await api.get('/user/assets', token);
      setAssets(Array.isArray(data) ? data : []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [isSignedIn, getToken]);

  useEffect(() => {
    fetchAssets();
    const interval = setInterval(fetchAssets, 60_000);
    return () => clearInterval(interval);
  }, [fetchAssets]);

  const addAsset = async (symbol, displayName, assetType) => {
    const token = await getToken();
    await api.post('/user/assets', { symbol, displayName, assetType }, token);
    await fetchAssets();
  };

  const removeAsset = async (id) => {
    const token = await getToken();
    await api.delete(`/user/assets/${id}`, token);
    await fetchAssets();
  };

  return { assets, loading, error, addAsset, removeAsset, refetch: fetchAssets };
}

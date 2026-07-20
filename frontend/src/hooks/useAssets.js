import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { api } from '../lib/api.js';

export function useAssets() {
  const { getToken } = useAuth();
  const [assets, setAssets]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  const fetchAssets = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getToken();
      const data  = await api.get('/user/me/assets', token);
      setAssets(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [getToken]);

  useEffect(() => { fetchAssets(); }, [fetchAssets]);

  const addAsset = useCallback(async (payload) => {
    const token = await getToken();
    const result = await api.post('/user/me/assets', payload, token);
    await fetchAssets();
    return result;
  }, [getToken, fetchAssets]);

  const removeAsset = useCallback(async (id) => {
    const token = await getToken();
    await api.del(`/user/me/assets/${id}`, token);
    setAssets(prev => prev.filter(a => a.id !== id));
  }, [getToken]);

  const updateAsset = useCallback(async (id, patch) => {
    const token = await getToken();
    await api.patch(`/user/me/assets/${id}`, patch, token);
    setAssets(prev => prev.map(a => a.id === id ? { ...a, ...patch } : a));
  }, [getToken]);

  return { assets, loading, error, refetch: fetchAssets, addAsset, removeAsset, updateAsset };
}

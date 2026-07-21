import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@clerk/clerk-react';
import api from '../lib/api';

export function useAssets() {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const [assets, setAssets]           = useState([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);

  const fetchAssets = useCallback(async () => {
    if (!isLoaded) return;
    if (!isSignedIn) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const token = await getToken();
      const data  = await api.get('/user/assets', token);
      setAssets(Array.isArray(data) ? data : []);
      setLastUpdated(Date.now());
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [isLoaded, isSignedIn, getToken]);

  useEffect(() => {
    fetchAssets();
  }, [fetchAssets]);

  useEffect(() => {
    if (!isSignedIn) return;
    const interval = setInterval(fetchAssets, 60_000);
    return () => clearInterval(interval);
  }, [isSignedIn, fetchAssets]);

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

  return { assets, loading, error, addAsset, removeAsset, refetch: fetchAssets, lastUpdated };
}
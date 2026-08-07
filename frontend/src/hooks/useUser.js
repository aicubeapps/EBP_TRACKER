import { useState, useEffect } from 'react';
import { useAuth } from '@clerk/clerk-react';
import api from '../lib/api';

export function useUser() {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const [user, setUser]       = useState(null);
  const [loading, setLoading] = useState(true);

  const fetchUser = async () => {
    if (!isLoaded || !isSignedIn) {
      setLoading(false);
      return;
    }
    try {
      const token = await getToken();
      const data  = await api.get('/user/me', token);
      setUser(data);
    } catch {
      // swallowed — no error UI consumes this
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!isLoaded) return;
    fetchUser();
    // Refresh every 2 minutes to pick up plan changes
    const interval = setInterval(fetchUser, 120_000);
    return () => clearInterval(interval);
  }, [isLoaded, isSignedIn]);

  return { user, loading };
}
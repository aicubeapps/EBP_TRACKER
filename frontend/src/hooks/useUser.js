import { useState, useEffect } from 'react';
import { useAuth } from '@clerk/clerk-react';
import api from '../lib/api';

export function useUser() {
  const { getToken, isSignedIn } = useAuth();
  const [user, setUser]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  useEffect(() => {
    if (!isSignedIn) { setLoading(false); return; }
    (async () => {
      try {
        const token = await getToken();
        const data  = await api.get('/user/me', token);
        setUser(data);
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [isSignedIn]);

  return { user, loading, error };
}

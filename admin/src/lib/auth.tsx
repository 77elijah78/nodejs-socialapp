import { createContext, PropsWithChildren, useContext, useEffect, useMemo, useState } from 'react';
import { apiRequest, clearSessionTokens, getStoredAccessToken, login as loginRequest, logout as logoutRequest } from './api';
import type { AdminSession } from './types';

interface AuthContextValue {
  session: AdminSession | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  refreshSession: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: PropsWithChildren) {
  const [session, setSession] = useState<AdminSession | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshSession = async () => {
    if (!getStoredAccessToken()) {
      setSession(null);
      setLoading(false);
      return;
    }

    try {
      const response = await apiRequest<AdminSession>('/admin/auth/me');
      setSession(response.data);
    } catch {
      clearSessionTokens();
      setSession(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refreshSession();
  }, []);

  const value = useMemo<AuthContextValue>(() => ({
    session,
    loading,
    signIn: async (email: string, password: string) => {
      setLoading(true);
      try {
        await loginRequest(email, password);
        await refreshSession();
      } finally {
        setLoading(false);
      }
    },
    signOut: async () => {
      await logoutRequest();
      setSession(null);
    },
    refreshSession,
  }), [session, loading]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
}
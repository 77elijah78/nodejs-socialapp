import { toast } from 'sonner';
import type { ApiEnvelope } from './types';

const ACCESS_TOKEN_KEY = 'admin_access_token';
const REFRESH_TOKEN_KEY = 'admin_refresh_token';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api/v1';

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export function getStoredAccessToken() {
  return localStorage.getItem(ACCESS_TOKEN_KEY);
}

export function setSessionTokens(accessToken: string, refreshToken?: string) {
  localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
  if (refreshToken) {
    localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
  }
}

export function clearSessionTokens() {
  localStorage.removeItem(ACCESS_TOKEN_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
}

async function refreshAccessToken() {
  const refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY);
  if (!refreshToken) {
    clearSessionTokens();
    throw new Error('No refresh token available');
  }

  const response = await fetch(`${API_BASE}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });

  const payload = (await response.json()) as ApiEnvelope<{ accessToken: string }>;
  if (!response.ok || !payload.success) {
    clearSessionTokens();
    throw new Error(payload.message || 'Session refresh failed');
  }

  setSessionTokens(payload.data.accessToken);
  return payload.data.accessToken;
}

export async function apiRequest<T>(path: string, options: { method?: HttpMethod; body?: unknown; query?: Record<string, string | number | boolean | undefined> } = {}): Promise<ApiEnvelope<T>> {
  const method = options.method || 'GET';
  const queryString = options.query
    ? `?${new URLSearchParams(Object.entries(options.query).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]))}`
    : '';

  const doFetch = async (token?: string) => {
    const response = await fetch(`${API_BASE}${path}${queryString}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    const isJson = response.headers.get('content-type')?.includes('application/json');
    const payload = isJson ? ((await response.json()) as ApiEnvelope<T>) : ({ success: response.ok, data: (await response.text()) as T } as ApiEnvelope<T>);

    if (!response.ok || !payload.success) {
      const error = new Error(payload.message || 'Request failed');
      (error as Error & { status?: number }).status = response.status;
      throw error;
    }

    return payload;
  };

  const token = getStoredAccessToken() || undefined;
  try {
    return await doFetch(token);
  } catch (error) {
    const status = (error as Error & { status?: number }).status;
    if (status === 401 && token) {
      try {
        const refreshed = await refreshAccessToken();
        return await doFetch(refreshed);
      } catch (refreshError) {
        clearSessionTokens();
        throw refreshError;
      }
    }
    throw error;
  }
}

export async function login(email: string, password: string) {
  const payload = await apiRequest<{ accessToken: string; refreshToken: string }>('/auth/login', {
    method: 'POST',
    body: { email, password },
  });
  setSessionTokens(payload.data.accessToken, payload.data.refreshToken);
  toast.success('Signed in');
  return payload.data;
}

export async function logout() {
  const refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY);
  if (refreshToken) {
    try {
      await apiRequest('/auth/logout', { method: 'POST', body: { refreshToken } });
    } catch {
      // noop
    }
  }
  clearSessionTokens();
}

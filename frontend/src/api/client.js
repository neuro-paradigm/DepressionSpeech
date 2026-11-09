import axios from 'axios';

export const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000/api';
export const SERVER_BASE_URL = API_BASE_URL.replace(/\/api\/?$/, '');

export const AUTH_TOKEN_KEY = 'sdc-auth-token';
export const AUTH_USER_KEY = 'sdc-auth-user';

export const api = axios.create({
  baseURL: API_BASE_URL,
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem(AUTH_TOKEN_KEY);
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// A 401 on a non-auth endpoint means the stored token expired or was revoked.
// Clear the stale session and reload so the user lands on the login page
// instead of staring at endless "request failed" errors.
api.interceptors.response.use(
  (response) => response,
  (error) => {
    const url = String(error.config?.url || '');
    const isAuthCall = url.includes('/auth/');
    if (error.response?.status === 401 && !isAuthCall && localStorage.getItem(AUTH_TOKEN_KEY)) {
      localStorage.removeItem(AUTH_TOKEN_KEY);
      localStorage.removeItem(AUTH_USER_KEY);
      window.location.assign('/');
    }
    return Promise.reject(error);
  },
);

import { useCallback, useEffect, useRef, useState } from 'react';
import { LogIn, UserPlus } from 'lucide-react';
import { api, AUTH_TOKEN_KEY, AUTH_USER_KEY } from '../api/client';

const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;

export default function AuthPage({ onAuth }) {
  const googleButtonRef = useRef(null);
  const gsiInitializedRef = useRef(false);
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const storeAuth = useCallback(
    (payload) => {
      localStorage.setItem(AUTH_TOKEN_KEY, payload.token);
      localStorage.setItem(AUTH_USER_KEY, JSON.stringify(payload.user));
      onAuth(payload.user);
    },
    [onAuth],
  );

  function validate() {
    if (!form.email.trim()) return 'Please enter your email address.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) return 'Please enter a valid email address.';
    if (mode === 'signup' && !form.name.trim()) return 'Please enter your name.';
    if (form.password.length < 8) return 'Password must be at least 8 characters long.';
    return '';
  }

  async function submit(event) {
    event.preventDefault();
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const endpoint = mode === 'signup' ? '/auth/signup' : '/auth/login';
      const response = await api.post(endpoint, { ...form, role: 'admin' });
      storeAuth(response.data);
    } catch (requestError) {
      setError(requestError.response?.data?.message || 'Authentication failed.');
    } finally {
      setLoading(false);
    }
  }

  const handleGoogleCredential = useCallback(
    async (credentialResponse) => {
      setError('');
      try {
        const response = await api.post('/auth/google', {
          credential: credentialResponse.credential,
          role: 'admin',
        });
        storeAuth(response.data);
      } catch (requestError) {
        setError(requestError.response?.data?.message || 'Google sign-in failed.');
      }
    },
    [storeAuth],
  );

  useEffect(() => {
    if (!googleClientId) return undefined;

    function renderGoogleButton() {
      if (!googleButtonRef.current || !window.google?.accounts?.id) return;
      googleButtonRef.current.innerHTML = '';
      window.google.accounts.id.renderButton(googleButtonRef.current, {
        theme: 'outline',
        size: 'large',
        width: 280,
      });
    }

    function initializeGsi() {
      if (!window.google?.accounts?.id) return;
      window.google.accounts.id.initialize({
        client_id: googleClientId,
        callback: handleGoogleCredential,
      });
      gsiInitializedRef.current = true;
      renderGoogleButton();
    }

    if (gsiInitializedRef.current && window.google?.accounts?.id) {
      renderGoogleButton();
      return undefined;
    }

    const existingScript = document.querySelector(
      'script[src="https://accounts.google.com/gsi/client"]',
    );

    if (existingScript && window.google?.accounts?.id) {
      initializeGsi();
      return undefined;
    }

    if (!existingScript) {
      const script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.defer = true;
      script.onload = () => initializeGsi();
      document.head.appendChild(script);
    }
    // Keep the GSI script in the page for the lifetime of the app.
    return undefined;
  }, [handleGoogleCredential]);

  return (
    <main className="auth-page">
      <section className="auth-panel">
        <div className="brand auth-brand">
          <span>SA</span>
        </div>
        <p className="eyebrow">Secure Access</p>
        <h1>{mode === 'signup' ? 'Create doctor account' : 'Doctor login'}</h1>
        <p>Doctors can record patient speech sessions, save audio responses, and review reports from the dashboard.</p>

        <form onSubmit={submit} className="auth-form" noValidate>
          {mode === 'signup' && (
            <label className="field">
              <span>Name</span>
              <input
                autoComplete="name"
                value={form.name}
                onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
              />
            </label>
          )}
          <label className="field">
            <span>Email</span>
            <input
              type="email"
              autoComplete="email"
              value={form.email}
              onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))}
            />
          </label>
          <label className="field">
            <span>Password</span>
            <input
              type="password"
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              value={form.password}
              onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))}
            />
          </label>

          {error && <p className="error auth-error">{error}</p>}

          <button className="primary" type="submit" disabled={loading}>
            {mode === 'signup' ? <UserPlus size={18} /> : <LogIn size={18} />}
            {loading ? 'Please wait…' : mode === 'signup' ? 'Sign Up' : 'Login'}
          </button>
        </form>

        <div className="auth-divider">or</div>
        {googleClientId
          ? <div ref={googleButtonRef} className="google-button-slot" />
          : <p className="inline-status">Set VITE_GOOGLE_CLIENT_ID to enable Google sign-in.</p>}

        <button className="text-button" type="button" onClick={() => setMode(mode === 'signup' ? 'login' : 'signup')}>
          {mode === 'signup' ? 'Already have an account? Login' : 'Need an account? Sign up'}
        </button>
      </section>
    </main>
  );
}

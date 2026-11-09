import { Suspense, lazy, useState } from 'react';
import { NavLink, Route, Routes, Navigate } from 'react-router-dom';
import { Fingerprint, LogOut, Mic, ShieldCheck } from 'lucide-react';
import AuthPage from './pages/AuthPage';
import { AUTH_TOKEN_KEY, AUTH_USER_KEY } from './api/client';
import { isUnsavedWorkActive } from './utils/unsavedWork';
import './styles.css';

// Route-level code splitting: each page loads on demand so the initial
// bundle (and first paint) stays small.
const AdminDashboard = lazy(() => import('./pages/AdminDashboard'));
const UserDashboard = lazy(() => import('./pages/UserDashboard'));
const DoctorEnrollment = lazy(() => import('./pages/DoctorEnrollment'));
const ReportView = lazy(() => import('./pages/ReportView'));

function PageLoader() {
  return (
    <div className="route-loader" role="status">
      <span className="spinner" />
      <p>Loading…</p>
    </div>
  );
}

export default function App() {
  const [currentUser, setCurrentUser] = useState(() => {
    try {
      const stored = localStorage.getItem(AUTH_USER_KEY);
      return stored ? JSON.parse(stored) : null;
    } catch {
      return null;
    }
  });

  function logout() {
    if (isUnsavedWorkActive()
      && !window.confirm('A recording is in progress or has not been saved yet. Signing out will discard it. Sign out anyway?')) {
      return;
    }
    localStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(AUTH_USER_KEY);
    localStorage.removeItem('sdc-submission-id');
    setCurrentUser(null);
  }

  const initials = (currentUser?.name || '')
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase())
    .slice(0, 2)
    .join('') || 'DR';

  if (!currentUser) return <AuthPage onAuth={setCurrentUser} />;

  return (
    <div className="app-shell">
      <nav className="top-nav">
        <div className="brand">
          <span>SA</span>
          <strong>Speech Analysis</strong>
        </div>
        <div className="nav-links">
          <NavLink to="/admin"><ShieldCheck size={18} />Dashboard</NavLink>
          <NavLink to="/record"><Mic size={18} />Record Patient</NavLink>
          <NavLink to="/enroll"><Fingerprint size={18} />Doctor Voice</NavLink>
          <button className="secondary nav-user" type="button" onClick={logout} title="Sign out">
            <span className="nav-avatar">{initials}</span>
            {currentUser.name}
            <LogOut size={16} />
          </button>
        </div>
      </nav>

      <Suspense fallback={<PageLoader />}>
        <Routes>
          <Route path="/admin" element={<AdminDashboard />} />
          <Route path="/record" element={<UserDashboard currentUser={currentUser} />} />
          <Route path="/enroll" element={<DoctorEnrollment />} />
          <Route path="/report/:id" element={<ReportView />} />
          <Route path="*" element={<Navigate to="/admin" replace />} />
        </Routes>
      </Suspense>
    </div>
  );
}

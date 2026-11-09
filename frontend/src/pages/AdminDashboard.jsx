import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Eye, Fingerprint, FileText, Inbox, Mic, RefreshCw, Sparkles } from 'lucide-react';
import { api } from '../api/client';
import { prefetchReport } from '../api/reportCache';
import { CACHE_KEYS, cacheGet, cacheSet, cacheDelete, reportCacheKey } from '../utils/cache';
import { displayClassification } from '../utils/display';

const ACCESS_CODE = import.meta.env.VITE_DOCTOR_ACCESS_CODE || '123456';

export default function AdminDashboard() {
  const navigate = useNavigate();
  // Paint instantly from the last known list; a background request below
  // revalidates it. No more spinner when coming back from a report.
  const [submissions, setSubmissions] = useState(() => cacheGet(CACHE_KEYS.submissions) || []);
  const [loading, setLoading] = useState(() => !cacheGet(CACHE_KEYS.submissions));
  const [generatingId, setGeneratingId] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [doctorEnrolled, setDoctorEnrolled] = useState(null);

  // Modal states for action gating
  const [modalOpen, setModalOpen] = useState(false);
  const [modalCode, setModalCode] = useState('');
  const [modalError, setModalError] = useState('');
  const [onModalSuccess, setOnModalSuccess] = useState(null);

  function triggerActionWithCode(callback) {
    setOnModalSuccess(() => callback);
    setModalOpen(true);
    setModalCode('');
    setModalError('');
  }

  async function refreshSubmissions({ showSpinner = true } = {}) {
    if (showSpinner) setLoading(true);
    setError('');
    try {
      const response = await api.get('/admin/users');
      setSubmissions(response.data);
      cacheSet(CACHE_KEYS.submissions, response.data);
    } catch (requestError) {
      setError(requestError.response?.data?.message || 'Unable to load admin submissions.');
    } finally {
      setLoading(false);
    }
  }

  async function generateReport(submissionId) {
    setGeneratingId(submissionId);
    setError('');
    setSuccess('');
    try {
      await api.post('/generate-report', { submissionId });
      cacheDelete(reportCacheKey(submissionId));
      setSuccess(`Report generated for submission ${submissionId.slice(-6)}.`);
      await refreshSubmissions({ showSpinner: false });
    } catch (requestError) {
      const message = requestError.response?.data?.message || 'Unable to generate report.';
      setError(message);
      console.error('Generate report error:', requestError.response?.data || requestError.message);
    } finally {
      setGeneratingId('');
    }
  }

  useEffect(() => {
    let cancelled = false;
    async function initialLoad() {
      try {
        const response = await api.get('/admin/users');
        if (!cancelled) {
          setSubmissions(response.data);
          cacheSet(CACHE_KEYS.submissions, response.data);
        }
      } catch (requestError) {
        if (!cancelled) setError(requestError.response?.data?.message || 'Unable to load admin submissions.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    initialLoad();
    api.get('/doctor-enrollment-status')
      .then(({ data }) => { if (!cancelled) setDoctorEnrolled(data.enrolled); })
      .catch(() => { if (!cancelled) setDoctorEnrolled(false); });
    return () => {
      cancelled = true;
    };
  }, []);

  function responseSummary(responses) {
    if (!responses || typeof responses !== 'object') return 'No responses yet';
    if (responses.session) return 'Entire session saved';
    return ['q1', 'q2', 'q3', 'q4']
      .map((id, index) => `${responses[id] ? '✓' : '○'} Q${index + 1}`)
      .join('  ');
  }

  const totalSessions = submissions.length;
  const withResponses = submissions.filter((s) => Object.keys(s.responses || {}).length > 0).length;
  const withReports = submissions.filter((s) => s.report).length;

  return (
    <main className="page">
      <header className="page-header compact">
        <div>
          <p className="eyebrow">Admin Dashboard</p>
          <h1>Voice Submissions</h1>
          <p>Review saved patient audio, transcripts, per-question results, and structured speech analysis reports.</p>
        </div>
        <div className="header-actions">
          <button className="primary" type="button" onClick={() => navigate('/record')}>
            <Mic size={18} />
            Record Patient
          </button>
          <button className="secondary" type="button" onClick={() => refreshSubmissions()}>
            <RefreshCw size={18} />
            Refresh
          </button>
        </div>
      </header>

      <section className="stat-row">
        <div className="stat-card">
          <Inbox size={20} />
          <div><strong>{totalSessions}</strong><span>Total sessions</span></div>
        </div>
        <div className="stat-card">
          <Mic size={20} />
          <div><strong>{withResponses}</strong><span>With recordings</span></div>
        </div>
        <div className="stat-card">
          <FileText size={20} />
          <div><strong>{withReports}</strong><span>Reports generated</span></div>
        </div>
      </section>

      {doctorEnrolled !== null && (
        <div className={`status-banner ${doctorEnrolled ? 'good' : 'warn'} enrollment-banner`}>
          <Fingerprint size={20} />
          <span className="banner-text">
            {doctorEnrolled
              ? 'Doctor voice registered — consultations will be automatically labeled Doctor / Patient.'
              : 'Doctor voice not registered — recordings will use generic Speaker 1 / Speaker 2 labels.'}
          </span>
          <button className="secondary" type="button" onClick={() => navigate('/enroll')}>
            <Fingerprint size={14} />
            {doctorEnrolled ? 'Manage Registration' : 'Register Doctor Voice'}
          </button>
        </div>
      )}

      {error && <p className="error">{error}</p>}
      {success && <p className="success">{success}</p>}
      {loading ? (
        <p className="inline-status">Loading submissions…</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Patient</th>
                <th>Stored Responses</th>
                <th>Status</th>
                <th>Report</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {submissions.map((submission) => {
                const responses = submission.responses || {};
                const responseCount = Object.keys(responses).length;
                return (
                  <tr key={submission._id}>
                    <td>
                      <strong>{submission.user?.name || submission.userId}</strong>
                      <span>{submission.user?.contact || submission.sessionId}</span>
                    </td>
                    <td>{responseSummary(responses)}</td>
                    <td><span className={`status-chip chip-${submission.status}`}>{submission.status}</span></td>
                    <td>{submission.report ? displayClassification(submission.report.classification) : 'Not generated'}</td>
                    <td>
                      <div className="table-actions">
                        {submission.report && (
                          // A real link so Ctrl+click / middle-click / "open in
                          // new tab" work natively — the dashboard (and its
                          // cached list) stays untouched while the report is read.
                          <a
                            className="action-link"
                            href={`/report/${submission._id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            onMouseEnter={() => prefetchReport(submission._id)}
                            onFocus={() => prefetchReport(submission._id)}
                          >
                            <Eye size={16} />
                            View Report
                          </a>
                        )}
                        <button
                          type="button"
                          onClick={() => triggerActionWithCode(() => generateReport(submission._id))}
                          disabled={generatingId === submission._id || responseCount === 0}
                        >
                          <Sparkles size={16} />
                          {generatingId === submission._id ? 'Generating…' : submission.report ? 'Regenerate' : 'Generate'}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {submissions.length === 0 && (
            <div className="empty-state slim">
              <Inbox size={28} />
              <h2>No submissions yet</h2>
              <p>Saved voice recordings will appear here after a patient session is completed.</p>
            </div>
          )}
        </div>
      )}

      {modalOpen && (
        <div className="modal-overlay">
          <div className="modal-content">
            <h2>Enter Access Code</h2>
            <p>Please enter the doctor access code to execute this action.</p>
            {modalError && <p className="error modal-error">{modalError}</p>}
            <form onSubmit={(event) => {
              event.preventDefault();
              if (modalCode === ACCESS_CODE) {
                if (onModalSuccess) onModalSuccess();
                setModalOpen(false);
                setModalCode('');
                setModalError('');
              } else {
                setModalError('Incorrect code. Please try again.');
              }
            }}>
              <label className="field">
                <input
                  type="password"
                  value={modalCode}
                  onChange={(event) => setModalCode(event.target.value)}
                  placeholder="Enter code"
                  autoFocus
                />
              </label>
              <div className="action-row modal-actions-row">
                <button className="secondary" type="button" onClick={() => {
                  setModalOpen(false);
                  setModalCode('');
                  setModalError('');
                }}>
                  Cancel
                </button>
                <button className="primary" type="submit">
                  Confirm
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </main>
  );
}

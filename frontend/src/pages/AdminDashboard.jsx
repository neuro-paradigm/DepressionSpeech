import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Eye, Fingerprint, Mic, RefreshCw, Sparkles } from 'lucide-react';
import { api } from '../api/client';

function displayClassification(value) {
  if (!value) return 'Generated';
  if (value === 'CONTROL') return 'TYPICAL SPEECH PATTERN';
  if (value.includes('LIKE SPEECH PATTERN')) return 'ATYPICAL SPEECH PATTERN';
  return value;
}

export default function AdminDashboard() {
  const navigate = useNavigate();
  const [submissions, setSubmissions]         = useState([]);
  const [loading, setLoading]                 = useState(true);
  const [generatingId, setGeneratingId]       = useState('');
  const [error, setError]                     = useState('');
  const [success, setSuccess]                 = useState('');
  const [doctorEnrolled, setDoctorEnrolled]   = useState(null);

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

  async function loadSubmissions() {
    setLoading(true);
    setError('');
    try {
      const response = await api.get('/admin/users');
      setSubmissions(response.data);
    } catch (requestError) {
      setError(requestError.response?.data?.message || 'Unable to load admin submissions.');
    } finally {
      setLoading(false);
    }
  }

  async function fetchEnrollmentStatus() {
    try {
      const { data } = await api.get('/doctor-enrollment-status');
      setDoctorEnrolled(data.enrolled);
    } catch {
      setDoctorEnrolled(false);
    }
  }

  async function generateReport(submissionId) {
    setGeneratingId(submissionId);
    setError('');
    setSuccess('');
    try {
      await api.post('/generate-report', { submissionId });
      setSuccess(`Report generated for submission ${submissionId.slice(-6)}.`);
      await loadSubmissions();
    } catch (requestError) {
      const msg = requestError.response?.data?.message || 'Unable to generate report.';
      setError(msg);
      console.error('Generate report error:', requestError.response?.data || requestError.message);
    } finally {
      setGeneratingId('');
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadSubmissions();
    fetchEnrollmentStatus();
  }, []);

  function getReportSummary(report) {
    if (!report) return 'Not generated';
    return displayClassification(report.classification);
  }

  function responseStatus(responses, questionId, label) {
    return `${label} status: ${responses[questionId] ? 'saved' : 'pending'}`;
  }

  function responseSummary(responses) {
    if (responses.session) return 'Entire session status: saved';
    return ['q1', 'q2', 'q3', 'q4'].map((id, index) => responseStatus(responses, id, `Q${index + 1}`)).join(', ');
  }

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
          <button className="secondary" type="button" onClick={loadSubmissions}>
            <RefreshCw size={18} />
            Refresh
          </button>
        </div>
      </header>

      {/* Doctor enrollment status banner */}
      {doctorEnrolled !== null && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: '12px',
          padding: '12px 20px', borderRadius: '8px', margin: '0 0 8px 0',
          background: doctorEnrolled ? '#f0fdf4' : '#fefce8',
          border: `1px solid ${doctorEnrolled ? '#bbf7d0' : '#fde68a'}`,
          flexWrap: 'wrap',
        }}>
          <Fingerprint size={20} style={{ color: doctorEnrolled ? '#16a34a' : '#ca8a04', flexShrink: 0 }} />
          <span style={{ flex: 1, fontSize: '13px', color: doctorEnrolled ? '#166534' : '#854d0e' }}>
            {doctorEnrolled
              ? 'Doctor voice registered — consultations will be automatically labeled Doctor / Patient.'
              : 'Doctor voice not registered — recordings will use generic Speaker 1 / Speaker 2 labels.'}
          </span>
          <button
            className="secondary"
            type="button"
            onClick={() => navigate('/enroll')}
            style={{ fontSize: '13px', padding: '6px 14px', borderColor: doctorEnrolled ? '#bbf7d0' : '#fde68a' }}
          >
            <Fingerprint size={14} />
            {doctorEnrolled ? 'Manage Registration' : 'Register Doctor Voice'}
          </button>
        </div>
      )}



      {error && <p className="error">{error}</p>}
      {success && <p className="success">{success}</p>}
      {loading ? (
        <p className="inline-status">Loading submissions...</p>
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
                    <td>{submission.status}</td>
                    <td>{getReportSummary(submission.report)}</td>
                    <td>
                      <div className="table-actions">
                        {submission.report && (
                          <button
                            className="secondary"
                            type="button"
                            onClick={() => triggerActionWithCode(() => navigate(`/report/${submission._id}`))}
                          >
                            <Eye size={16} />
                            View Report
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => triggerActionWithCode(() => generateReport(submission._id))}
                          disabled={generatingId === submission._id || responseCount === 0}
                        >
                          <Sparkles size={16} />
                          {generatingId === submission._id ? 'Generating...' : submission.report ? 'Regenerate' : 'Generate'}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {submissions.length === 0 && <p className="inline-status">No voice responses have been saved yet.</p>}
        </div>
      )}

      {modalOpen && (
        <div className="modal-overlay">
          <div className="modal-content">
            <h2>Enter Access Code</h2>
            <p>Please enter the doctor access code to execute this action.</p>
            {modalError && <p className="error" style={{ marginTop: 0, marginBottom: '16px' }}>{modalError}</p>}
            <form onSubmit={(e) => {
              e.preventDefault();
              if (modalCode === '123456') {
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
                  onChange={(e) => setModalCode(e.target.value)}
                  placeholder="Enter code"
                  autoFocus
                />
              </label>
              <div className="action-row" style={{ marginTop: '16px' }}>
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

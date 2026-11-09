import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, CircleStop, Mic, RotateCcw, ShieldCheck, Trash2 } from 'lucide-react';
import { api } from '../api/client';
import { convertRecordingToWav } from '../utils/wav';
import { formatClock } from '../utils/display';
import { setUnsavedWorkActive } from '../utils/unsavedWork';
import useObjectUrl from '../hooks/useObjectUrl';
import useUnsavedGuard from '../hooks/useUnsavedGuard';

const MIN_SECONDS = 30;
const MAX_GUIDANCE_SECONDS = 60;

export default function DoctorEnrollment() {
  const mediaRecorderRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);
  const timerRef = useRef(null);
  const startedAtRef = useRef(null);

  const [enrolled, setEnrolled] = useState(null); // null = loading
  const [isRecording, setIsRecording] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [audioBlob, setAudioBlob] = useState(null);
  const [durationSec, setDurationSec] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState('');

  const audioPreviewUrl = useObjectUrl(audioBlob);

  const hasUnsavedWork = Boolean(isRecording || audioBlob);

  useUnsavedGuard({
    active: hasUnsavedWork,
    message: 'A voice recording is in progress or has not been enrolled yet. Leaving now will discard it. Leave anyway?',
  });

  useEffect(() => {
    setUnsavedWorkActive(hasUnsavedWork);
    return () => setUnsavedWorkActive(false);
  }, [hasUnsavedWork]);

  // Fetch current enrollment status on mount.
  useEffect(() => {
    let cancelled = false;
    async function fetchStatus() {
      try {
        const { data } = await api.get('/doctor-enrollment-status');
        if (!cancelled) setEnrolled(data.enrolled);
      } catch {
        if (!cancelled) setEnrolled(false);
      }
    }
    fetchStatus();
    return () => {
      cancelled = true;
    };
  }, []);

  // Live elapsed-time ticker.
  useEffect(() => {
    if (isRecording) {
      timerRef.current = setInterval(() => {
        setElapsed(startedAtRef.current ? Math.floor((Date.now() - startedAtRef.current) / 1000) : 0);
      }, 500);
    } else {
      clearInterval(timerRef.current);
    }
    return () => clearInterval(timerRef.current);
  }, [isRecording]);

  // Stop the microphone when leaving the page mid-recording.
  useEffect(() => () => {
    clearInterval(timerRef.current);
    try { mediaRecorderRef.current?.state !== 'inactive' && mediaRecorderRef.current?.stop(); } catch { /* already stopped */ }
    streamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  async function startRecording() {
    setError('');
    setStatus('');
    setAudioBlob(null);
    setStopped(false);
    setElapsed(0);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        if (streamRef.current === stream) streamRef.current = null;
        const raw = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        setDurationSec(startedAtRef.current ? Math.round((Date.now() - startedAtRef.current) / 1000) : 0);
        try {
          setStatus('Converting to WAV…');
          const wav = await convertRecordingToWav(raw);
          setAudioBlob(wav);
          setStatus('Ready to enroll.');
        } catch (conversionError) {
          setError(conversionError.message || 'WAV conversion failed. Please re-record.');
          setStatus('');
        }
      };
      recorder.start();
      startedAtRef.current = Date.now();
      setIsRecording(true);
    } catch (recordError) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setError(recordError.message || 'Microphone access denied.');
    }
  }

  function stopRecording() {
    mediaRecorderRef.current?.stop();
    setIsRecording(false);
    setStopped(true);
  }

  function rerecord() {
    setAudioBlob(null);
    setStopped(false);
    setElapsed(0);
    setDurationSec(0);
    setError('');
    setStatus('');
  }

  async function submitEnrollment() {
    if (!audioBlob) {
      setError('Record the doctor voice before enrolling.');
      return;
    }
    setLoading('enroll');
    setError('');
    setStatus('');
    try {
      const form = new FormData();
      form.append('audio', audioBlob, 'doctor_reference.wav');
      const { data } = await api.post('/enroll-doctor-voice', form);
      setEnrolled(true);
      setAudioBlob(null);
      setStopped(false);
      setDurationSec(0);
      setElapsed(0);
      setStatus(`Enrolled! ${data.durationSec}s recorded using ${data.embeddingMethod} embeddings. Voice fingerprint saved — future recordings will auto-identify the doctor.`);
    } catch (requestError) {
      setError(requestError.response?.data?.message || 'Enrollment failed. Please try again.');
    } finally {
      setLoading('');
    }
  }

  async function handleClear() {
    if (!window.confirm('Clear the doctor voice registration? The doctor will need to re-enroll before automatic identification works again.')) return;
    setLoading('clear');
    setError('');
    setStatus('');
    try {
      await api.delete('/doctor-enrollment');
      setEnrolled(false);
      setStatus('Doctor enrollment cleared.');
    } catch (requestError) {
      setError(requestError.response?.data?.message || 'Failed to clear enrollment.');
    } finally {
      setLoading('');
    }
  }

  if (enrolled === null) {
    return (
      <main className="page">
        <p className="inline-status">Checking enrollment status…</p>
      </main>
    );
  }

  const secondsTooShort = isRecording && elapsed < MIN_SECONDS;

  return (
    <main className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Doctor Setup</p>
          <h1>Doctor Voice Registration</h1>
          <p>
            Record {MIN_SECONDS}–{MAX_GUIDANCE_SECONDS} seconds of the doctor speaking naturally. The voice fingerprint is saved
            locally and used to automatically identify the doctor in future consultation recordings.
            This is a one-time setup.
          </p>
        </div>
      </header>

      <section className="form-panel enrollment-status-panel">
        <div className={`status-banner ${enrolled ? 'good' : 'warn'}`}>
          {enrolled
            ? <CheckCircle2 size={22} />
            : <ShieldCheck size={22} />}
          <div>
            <strong>{enrolled ? 'Doctor Voice Registered' : 'No Voice Registered'}</strong>
            <span>
              {enrolled
                ? 'Automatic doctor identification is active for all future recordings.'
                : 'Record and enroll the doctor\'s voice to enable automatic identification.'}
            </span>
          </div>
        </div>

        {enrolled && (
          <button className="secondary danger" type="button" onClick={handleClear} disabled={loading !== ''}>
            <Trash2 size={16} />
            {loading === 'clear' ? 'Clearing…' : 'Clear Registration'}
          </button>
        )}
      </section>

      <section className="form-panel recorder-panel">
        <div className="panel-heading">
          <h2>{enrolled ? 'Re-Register Doctor Voice' : 'Register Doctor Voice'}</h2>
          <p>
            Ask the doctor to speak naturally for <strong>{MIN_SECONDS}–{MAX_GUIDANCE_SECONDS} seconds</strong>. Reading a
            passage, describing a patient case, or conversing normally all work well.
          </p>
        </div>

        {(isRecording || durationSec > 0) && (
          <div className={`timer-chip ${isRecording ? 'recording' : 'done'}${secondsTooShort ? ' attention' : ''}`}>
            {isRecording && <span className="recording-dot active" />}
            <span className="timer-value">{formatClock(isRecording ? elapsed : durationSec)}</span>
            <span className="timer-note">
              {isRecording
                ? (secondsTooShort ? `${MIN_SECONDS - elapsed}s until minimum` : 'Recording…')
                : 'Recorded'}
            </span>
          </div>
        )}

        <div className="recorder-controls">
          {!isRecording ? (
            <button
              className={stopped ? 'secondary disabled-look' : 'primary'}
              type="button"
              onClick={startRecording}
              disabled={stopped || loading !== ''}
            >
              <Mic size={18} />
              {stopped ? 'Re-record to Start' : 'Start Recording'}
            </button>
          ) : (
            <button type="button" onClick={stopRecording}>
              <CircleStop size={18} />
              Stop Recording
            </button>
          )}

          {stopped && (
            <button className="secondary" type="button" onClick={rerecord}>
              <RotateCcw size={18} />
              Re-record
            </button>
          )}

          {!isRecording && !stopped && (
            <span className="recording-dot" />
          )}
        </div>

        {!stopped && !isRecording && !audioBlob && (
          <div className="tips-card">
            <p className="tips-title">Tips for best results:</p>
            <ul>
              <li>Record in a quiet room with minimal background noise</li>
              <li>Speak naturally — avoid whispering or shouting</li>
              <li>Aim for <strong>{MIN_SECONDS}–{MAX_GUIDANCE_SECONDS} seconds</strong> of continuous speech</li>
              <li>Using the same microphone as clinical recordings gives best accuracy</li>
            </ul>
          </div>
        )}

        {audioPreviewUrl && (
          <div className="audio-preview">
            <span>Recording ready ({durationSec}s). Review below, then enroll.</span>
            <audio controls src={audioPreviewUrl} />
          </div>
        )}
      </section>

      {status && <p className="success">{status}</p>}
      {error && <p className="error">{error}</p>}

      <div className="action-row">
        <button type="button" onClick={submitEnrollment} disabled={!audioBlob || loading !== ''}>
          <ShieldCheck size={18} />
          {loading === 'enroll' ? 'Enrolling… (this may take a minute)' : 'Enroll Doctor Voice'}
        </button>
      </div>

      <section className="form-panel info-panel">
        <h3>How Automatic Identification Works</h3>
        <ol>
          <li>A voice fingerprint (embedding) is extracted from this enrollment recording using <strong>SpeechBrain ECAPA-TDNN</strong>.</li>
          <li>When a clinical session is recorded, both speakers are separated via diarization.</li>
          <li>Each speaker's embedding is compared to the doctor's reference using <strong>cosine similarity</strong>.</li>
          <li>The closest match is labeled <strong>Doctor</strong>; the other is labeled <strong>Patient</strong>.</li>
          <li>If confidence is below the threshold, generic <em>Speaker 1 / Speaker 2</em> labels are used instead.</li>
          <li>The ZIP archive will contain <code>doctor.wav</code>, <code>patient.wav</code> and their transcripts.</li>
        </ol>
      </section>
    </main>
  );
}

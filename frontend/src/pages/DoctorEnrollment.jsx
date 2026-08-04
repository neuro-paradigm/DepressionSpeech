import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, CircleStop, Mic, RotateCcw, ShieldCheck, Trash2 } from 'lucide-react';
import { api } from '../api/client';

function writeString(view, offset, text) {
  for (let i = 0; i < text.length; i += 1) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

function audioBufferToWav(audioBuffer) {
  const channelCount = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const sampleCount = audioBuffer.length;
  const bytesPerSample = 2;
  const blockAlign = channelCount * bytesPerSample;
  const dataSize = sampleCount * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);
  let offset = 44;
  const channels = Array.from({ length: channelCount }, (_, i) => audioBuffer.getChannelData(i));
  for (let s = 0; s < sampleCount; s += 1) {
    for (let c = 0; c < channelCount; c += 1) {
      const sample = Math.max(-1, Math.min(1, channels[c][s]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += bytesPerSample;
    }
  }
  return buffer;
}

async function convertToWav(blob) {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) throw new Error('Browser cannot convert to WAV.');
  const ctx = new AudioContext();
  try {
    const arrayBuf = await blob.arrayBuffer();
    const decoded  = await ctx.decodeAudioData(arrayBuf.slice(0));
    return new Blob([audioBufferToWav(decoded)], { type: 'audio/wav' });
  } finally {
    await ctx.close?.();
  }
}

export default function DoctorEnrollment() {
  const mediaRecorderRef   = useRef(null);
  const chunksRef          = useRef([]);
  const timerRef           = useRef(null);
  const startedAtRef       = useRef(null);

  const [enrolled, setEnrolled]       = useState(null);   // null = loading
  const [isRecording, setIsRecording] = useState(false);
  const [stopped, setStopped]         = useState(false);
  const [audioBlob, setAudioBlob]     = useState(null);
  const [durationSec, setDurationSec] = useState(0);
  const [elapsed, setElapsed]         = useState(0);
  const [status, setStatus]           = useState('');
  const [error, setError]             = useState('');
  const [loading, setLoading]         = useState('');

  // ── Fetch current enrollment status on mount ──────────────────────────────
  useEffect(() => {
    async function fetchStatus() {
      try {
        const { data } = await api.get('/doctor-enrollment-status');
        setEnrolled(data.enrolled);
      } catch {
        setEnrolled(false);
      }
    }
    fetchStatus();
  }, []);

  // ── Live elapsed-time ticker ──────────────────────────────────────────────
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

  // ── Recording helpers ─────────────────────────────────────────────────────
  async function startRecording() {
    setError('');
    setStatus('');
    setAudioBlob(null);
    setStopped(false);
    setElapsed(0);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunksRef.current = [];
      const recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const raw = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        setDurationSec(startedAtRef.current ? Math.round((Date.now() - startedAtRef.current) / 1000) : 0);
        try {
          setStatus('Converting to WAV…');
          const wav = await convertToWav(raw);
          setAudioBlob(wav);
          setStatus('Ready to enroll.');
        } catch (err) {
          setError(err.message || 'WAV conversion failed. Please re-record.');
          setStatus('');
        }
      };
      recorder.start();
      startedAtRef.current = Date.now();
      mediaRecorderRef.current = recorder;
      setIsRecording(true);
    } catch (err) {
      setError(err.message || 'Microphone access denied.');
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

  // ── Enroll ────────────────────────────────────────────────────────────────
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
      setStatus(
        `✓ Enrolled! ${data.durationSec}s recorded using ${data.embeddingMethod} embeddings. ` +
        `Voice fingerprint saved — future recordings will auto-identify the doctor.`
      );
    } catch (err) {
      setError(err.response?.data?.message || 'Enrollment failed. Please try again.');
    } finally {
      setLoading('');
    }
  }

  // ── Clear enrollment ──────────────────────────────────────────────────────
  async function handleClear() {
    if (!window.confirm('Clear the doctor voice registration? The doctor will need to re-enroll before automatic identification works again.')) return;
    setLoading('clear');
    setError('');
    setStatus('');
    try {
      await api.delete('/doctor-enrollment');
      setEnrolled(false);
      setStatus('Doctor enrollment cleared.');
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to clear enrollment.');
    } finally {
      setLoading('');
    }
  }

  // ── Format elapsed time ───────────────────────────────────────────────────
  function formatTime(sec) {
    const m = Math.floor(sec / 60).toString().padStart(2, '0');
    const s = (sec % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }

  if (enrolled === null) {
    return (
      <main className="page">
        <p className="inline-status">Checking enrollment status…</p>
      </main>
    );
  }

  return (
    <main className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Doctor Setup</p>
          <h1>Doctor Voice Registration</h1>
          <p>
            Record 30–60 seconds of the doctor speaking naturally. The voice fingerprint is saved
            locally and used to automatically identify the doctor in future consultation recordings.
            This is a one-time setup.
          </p>
        </div>
      </header>

      {/* ── Enrollment status badge ── */}
      <section className="form-panel" style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: '10px',
          padding: '12px 20px',
          borderRadius: '8px',
          background: enrolled ? '#f0fdf4' : '#fefce8',
          border: `1px solid ${enrolled ? '#bbf7d0' : '#fde68a'}`,
          flex: 1,
        }}>
          {enrolled
            ? <CheckCircle2 size={22} style={{ color: '#16a34a', flexShrink: 0 }} />
            : <ShieldCheck   size={22} style={{ color: '#ca8a04', flexShrink: 0 }} />}
          <div>
            <strong style={{ color: enrolled ? '#166534' : '#854d0e', display: 'block', fontSize: '15px' }}>
              {enrolled ? 'Doctor Voice Registered' : 'No Voice Registered'}
            </strong>
            <span style={{ color: enrolled ? '#15803d' : '#92400e', fontSize: '13px' }}>
              {enrolled
                ? 'Automatic doctor identification is active for all future recordings.'
                : 'Record and enroll the doctor\'s voice to enable automatic identification.'}
            </span>
          </div>
        </div>

        {enrolled && (
          <button
            className="secondary"
            type="button"
            onClick={handleClear}
            disabled={loading !== ''}
            style={{ color: '#b91c1c', borderColor: '#fecaca', flexShrink: 0 }}
          >
            <Trash2 size={16} />
            {loading === 'clear' ? 'Clearing…' : 'Clear Registration'}
          </button>
        )}
      </section>

      {/* ── Recording section ── */}
      <section className="form-panel recorder-panel">
        <div className="panel-heading">
          <h2>{enrolled ? 'Re-Register Doctor Voice' : 'Register Doctor Voice'}</h2>
          <p>
            Ask the doctor to speak naturally for <strong>30–60 seconds</strong>. Reading a
            passage, describing a patient case, or conversing normally all work well.
          </p>
        </div>

        {/* Timer display */}
        {(isRecording || durationSec > 0) && (
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: '10px',
            padding: '10px 18px', borderRadius: '8px',
            background: isRecording ? '#fef2f2' : '#f0fdf4',
            border: `1px solid ${isRecording ? '#fecaca' : '#bbf7d0'}`,
            marginBottom: '16px', alignSelf: 'flex-start',
          }}>
            {isRecording && <span className="recording-dot active" />}
            <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600, fontSize: '18px',
              color: isRecording ? '#dc2626' : '#166534' }}>
              {formatTime(isRecording ? elapsed : durationSec)}
            </span>
            <span style={{ fontSize: '13px', color: '#6b7280' }}>
              {isRecording
                ? elapsed < 30 ? `${30 - elapsed}s until minimum` : 'Recording…'
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
              id="enroll-start-btn"
            >
              <Mic size={18} />
              {stopped ? 'Re-record to Start' : 'Start Recording'}
            </button>
          ) : (
            <button type="button" onClick={stopRecording} id="enroll-stop-btn">
              <CircleStop size={18} />
              Stop Recording
            </button>
          )}

          {stopped && (
            <button className="secondary" type="button" onClick={rerecord} id="enroll-rerecord-btn">
              <RotateCcw size={18} />
              Re-record
            </button>
          )}

          {!isRecording && !stopped && (
            <span className="recording-dot" />
          )}
        </div>

        {/* Guidance checklist */}
        {!stopped && !isRecording && !audioBlob && (
          <div style={{ marginTop: '20px', padding: '16px', background: '#f8fafc', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
            <p style={{ margin: '0 0 10px 0', fontWeight: 600, fontSize: '14px', color: '#374151' }}>
              Tips for best results:
            </p>
            <ul style={{ margin: 0, paddingLeft: '18px', color: '#6b7280', fontSize: '13px', lineHeight: '1.8' }}>
              <li>Record in a quiet room with minimal background noise</li>
              <li>Speak naturally — avoid whispering or shouting</li>
              <li>Aim for <strong>30–60 seconds</strong> of continuous speech</li>
              <li>Using the same microphone as clinical recordings gives best accuracy</li>
            </ul>
          </div>
        )}

        {audioBlob && (
          <div style={{ marginTop: '12px' }}>
            <p className="inline-status" style={{ marginBottom: '8px' }}>
              Recording ready ({durationSec}s). Review below, then click <strong>Enroll Doctor Voice</strong>.
            </p>
            <audio controls src={URL.createObjectURL(audioBlob)} style={{ width: '100%', borderRadius: '6px' }} />
          </div>
        )}
      </section>

      {status && <p className="success">{status}</p>}
      {error  && <p className="error">{error}</p>}

      <div className="action-row">
        <button
          type="button"
          onClick={submitEnrollment}
          disabled={!audioBlob || loading !== ''}
          id="enroll-submit-btn"
        >
          <ShieldCheck size={18} />
          {loading === 'enroll' ? 'Enrolling… (this may take a minute)' : 'Enroll Doctor Voice'}
        </button>
      </div>

      {/* ── How it works ── */}
      <section className="form-panel" style={{ marginTop: '24px', background: '#f8fafc', border: '1px solid #e2e8f0' }}>
        <h3 style={{ margin: '0 0 12px 0', fontSize: '15px', color: '#374151' }}>How Automatic Identification Works</h3>
        <ol style={{ margin: 0, paddingLeft: '20px', color: '#6b7280', fontSize: '13px', lineHeight: '2' }}>
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

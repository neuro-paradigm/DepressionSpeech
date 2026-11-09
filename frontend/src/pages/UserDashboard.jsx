import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  BookOpenText,
  CheckCircle2,
  CircleStop,
  ClipboardList,
  Mic,
  MessagesSquare,
  RotateCcw,
  Save,
  UserPlus,
} from 'lucide-react';
import { api } from '../api/client';
import { voiceQuestions } from '../data/voiceQuestions';
import { convertRecordingToWav } from '../utils/wav';
import { formatClock } from '../utils/display';
import { setUnsavedWorkActive } from '../utils/unsavedWork';
import { KaraokeReader } from '../components/ReadingHighlighter';
import useObjectUrl from '../hooks/useObjectUrl';
import useUnsavedGuard from '../hooks/useUnsavedGuard';

const EMOTION_TONES = {
  Calm: 'calm',
  Anger: 'anger',
  Fear: 'fear',
  Happiness: 'happiness',
};

function makeSessionId(doctorId) {
  return `session-${doctorId ?? 'anon'}-${Date.now()}`;
}

function createSpeechRecognizer({ onText, onResult, onError, onEnd }) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return null;
  const recognizer = new SpeechRecognition();
  let committedTranscript = '';
  recognizer.continuous = true;
  recognizer.interimResults = true;
  recognizer.maxAlternatives = 1;
  recognizer.lang = 'en-US';
  recognizer.onresult = (event) => {
    let interimTranscript = '';
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      const text = result[0]?.transcript?.trim() || '';
      if (!text) continue;
      if (result.isFinal) committedTranscript = `${committedTranscript} ${text}`.trim();
      else interimTranscript = `${interimTranscript} ${text}`.trim();
    }
    // One recognizer feeds two consumers: the saved transcript and the
    // voice-driven read-along highlighter.
    onResult?.({ final: committedTranscript, interim: interimTranscript });
    onText(`${committedTranscript} ${interimTranscript}`.trim());
  };
  recognizer.onerror = (event) => onError?.(event.error);
  recognizer.onend = () => onEnd?.(recognizer);
  return recognizer;
}

export default function UserDashboard({ currentUser }) {
  const navigate = useNavigate();
  const [sessionId, setSessionId] = useState(() => makeSessionId(currentUser?.id));
  const mediaRecorderRef = useRef(null);
  const streamRef = useRef(null);
  const speechRecognizerRef = useRef(null);
  const keepRecognitionAliveRef = useRef(false);
  const recognitionRestartTimerRef = useRef(null);
  const chunksRef = useRef([]);
  const recordingStartedAtRef = useRef(null);
  // Guards against the async recorder.onstop landing after the user has
  // already switched question / started a new patient (mis-filed audio).
  const captureTokenRef = useRef(0);

  const [durationMs, setDurationMs] = useState(0);
  const [stepIndex, setStepIndex] = useState(0);
  const [patient, setPatient] = useState({ name: '', contact: '' });
  const [isRecording, setIsRecording] = useState(false);
  const [audioBlob, setAudioBlob] = useState(null);
  const [recordingStopped, setRecordingStopped] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [savedResponses, setSavedResponses] = useState({});
  const [loadingAction, setLoadingAction] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [showCompletionModal, setShowCompletionModal] = useState(false);
  const [recordingMode, setRecordingMode] = useState('');
  const [elapsedSec, setElapsedSec] = useState(0);
  const [readingEpoch, setReadingEpoch] = useState(0);
  // Live recognizer output, consumed by the read-along highlighter.
  const [spoken, setSpoken] = useState({ final: '', interim: '' });

  const speechSupported = useMemo(
    () => Boolean(window.SpeechRecognition || window.webkitSpeechRecognition),
    [],
  );

  const currentQuestion = voiceQuestions[stepIndex];
  const hasAllResponses = Object.keys(savedResponses).length === voiceQuestions.length;
  const currentQuestionSaved = savedResponses[currentQuestion?.id];
  const audioPreviewUrl = useObjectUrl(audioBlob);

  // Anything recorded but not yet saved to the server counts as unsaved work:
  // an active recording, a converted take waiting to be saved, or a live
  // transcript that only exists in this browser.
  const hasUnsavedWork = Boolean(isRecording || audioBlob || transcript.trim());

  // Warn before closing/refreshing the tab and before any in-app navigation.
  useUnsavedGuard({
    active: hasUnsavedWork,
    message: 'A recording is in progress or has not been saved yet. Leaving now will discard it. Leave anyway?',
  });

  // Let the app shell (sign-out button) know about unsaved work too.
  useEffect(() => {
    setUnsavedWorkActive(hasUnsavedWork);
    return () => setUnsavedWorkActive(false);
  }, [hasUnsavedWork]);

  function confirmDiscard() {
    return !hasUnsavedWork
      || window.confirm('Discard the current unsaved recording?');
  }

  // Live elapsed-time ticker while recording.
  useEffect(() => {
    if (!isRecording) return undefined;
    const timer = setInterval(() => {
      setElapsedSec(recordingStartedAtRef.current ? Math.floor((Date.now() - recordingStartedAtRef.current) / 1000) : 0);
    }, 500);
    return () => clearInterval(timer);
  }, [isRecording]);

  // Stop microphone + recognition when leaving the page entirely.
  useEffect(() => () => {
    captureTokenRef.current += 1;
    keepRecognitionAliveRef.current = false;
    clearTimeout(recognitionRestartTimerRef.current);
    try { speechRecognizerRef.current?.stop(); } catch { /* already stopped */ }
    try { mediaRecorderRef.current?.state !== 'inactive' && mediaRecorderRef.current?.stop(); } catch { /* already stopped */ }
    streamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  function stopSpeechRecognition() {
    keepRecognitionAliveRef.current = false;
    clearTimeout(recognitionRestartTimerRef.current);
    recognitionRestartTimerRef.current = null;
    try { speechRecognizerRef.current?.stop(); } catch { /* already stopped */ }
  }

  function restartSpeechRecognition(recognizer) {
    if (!keepRecognitionAliveRef.current) return;
    clearTimeout(recognitionRestartTimerRef.current);
    recognitionRestartTimerRef.current = setTimeout(() => {
      if (!keepRecognitionAliveRef.current) return;
      try {
        recognizer.start();
      } catch (startError) {
        if (startError.name === 'InvalidStateError') return;
        recognitionRestartTimerRef.current = setTimeout(() => restartSpeechRecognition(recognizer), 300);
      }
    }, 150);
  }

  function resetRecordingState() {
    captureTokenRef.current += 1;
    if (isRecording) {
      mediaRecorderRef.current?.stop();
      stopSpeechRecognition();
      setIsRecording(false);
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;

    setAudioBlob(null);
    setRecordingStopped(false);
    setTranscript('');
    setDurationMs(0);
    setElapsedSec(0);
    setSpoken({ final: '', interim: '' });
    setError('');
    setStatus('');
  }

  function selectStep(index) {
    if (index === stepIndex) return;
    if (!confirmDiscard()) return;
    resetRecordingState();
    setStepIndex(index);
  }

  function returnToModeChoice() {
    if (!confirmDiscard()) return;
    resetRecordingState();
    setRecordingMode('');
  }

  async function startRecording() {
    if (!patient.name.trim()) {
      setError(recordingMode === 'session' ? 'Enter the patient ID before recording.' : 'Enter the patient name before recording.');
      return;
    }

    captureTokenRef.current += 1;
    setError('');
    setStatus('');
    setAudioBlob(null);
    setRecordingStopped(false);
    setTranscript('');
    setDurationMs(0);
    setReadingEpoch((epoch) => epoch + 1);
    setSpoken({ final: '', interim: '' });

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
        // The token captured at record-start must still be current, otherwise
        // this stop belongs to an abandoned question/patient — discard it.
        const token = captureTokenRef.current;
        const recordedBlob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        const elapsed = recordingStartedAtRef.current ? Date.now() - recordingStartedAtRef.current : 0;
        stream.getTracks().forEach((track) => track.stop());
        if (streamRef.current === stream) streamRef.current = null;
        if (token !== captureTokenRef.current) return;

        setDurationMs(elapsed);
        try {
          setStatus('Preparing WAV audio…');
          const wavBlob = await convertRecordingToWav(recordedBlob);
          if (token !== captureTokenRef.current) return;
          setAudioBlob(wavBlob);
          setStatus('Recording converted to WAV. Ready to save.');
        } catch (conversionError) {
          if (token !== captureTokenRef.current) return;
          setAudioBlob(null);
          setError(conversionError.message || 'Unable to convert this recording to WAV. Please re-record.');
          setStatus('');
        }
      };
      recorder.start();
      recordingStartedAtRef.current = Date.now();

      const recognizer = createSpeechRecognizer({
        onText: setTranscript,
        onResult: setSpoken,
        onError: (recognitionError) => {
          if (recognitionError === 'no-speech' || recognitionError === 'aborted') return;
          if (recognitionError === 'not-allowed' || recognitionError === 'service-not-allowed') {
            keepRecognitionAliveRef.current = false;
            setError('Speech recognition permission was denied. Audio recording will continue.');
          }
        },
        onEnd: restartSpeechRecognition,
      });
      speechRecognizerRef.current = recognizer;
      if (recognizer) {
        keepRecognitionAliveRef.current = true;
        recognizer.start();
      } else {
        setStatus('Audio is recording, but live transcription is unavailable in this browser.');
      }
      setIsRecording(true);
    } catch (recordingError) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setError(recordingError.message || 'Microphone permission was denied.');
    }
  }

  function stopRecording() {
    mediaRecorderRef.current?.stop();
    stopSpeechRecognition();
    setIsRecording(false);
    setRecordingStopped(true);
  }

  function rerecord() {
    setAudioBlob(null);
    setTranscript('');
    setDurationMs(0);
    setElapsedSec(0);
    setRecordingStopped(false);
    setSpoken({ final: '', interim: '' });
    setError('');
    setStatus('');
  }

  function startNewPatient() {
    if (!confirmDiscard()) return;
    resetRecordingState();
    setSessionId(makeSessionId(currentUser?.id));
    setPatient({ name: '', contact: '' });
    setStepIndex(0);
    setSavedResponses({});
    setShowCompletionModal(false);
  }

  async function saveAndNext() {
    if (!audioBlob) {
      setError('Record an answer before saving this question.');
      return;
    }

    setLoadingAction('save');
    setError('');
    setStatus('');

    try {
      const payload = new FormData();
      payload.append('sessionId', sessionId);
      payload.append('userName', patient.name);
      payload.append('userContact', patient.contact);
      payload.append('questionId', currentQuestion.id);
      payload.append('question', currentQuestion.text);
      payload.append('rawTranscript', transcript);
      payload.append('durationMs', String(durationMs));
      payload.append('audio', audioBlob, `${currentQuestion.id}.wav`);

      const response = await api.post('/upload-voice-response', payload);

      const newSavedResponses = { ...savedResponses, [currentQuestion.id]: response.data.response };
      setSavedResponses(newSavedResponses);
      const driveError = response.data.progressiveZipError || response.data.submission?.progressiveZipUploadError;
      if (driveError) {
        setStatus('Saved locally, but Drive upload failed. You can click Save again to retry.');
        setError(`Google Drive upload failed: ${driveError}`);
      } else {
        setStatus('Saved successfully');
        setAudioBlob(null);
        setTranscript('');
        setRecordingStopped(false);
        setDurationMs(0);

        if (Object.keys(newSavedResponses).length === voiceQuestions.length) {
          setShowCompletionModal(true);
        } else {
          const nextIndex = Math.min(stepIndex + 1, voiceQuestions.length - 1);
          if (nextIndex !== stepIndex) setStepIndex(nextIndex);
        }
      }
    } catch (requestError) {
      console.error('Save response error:', requestError);
      setError(requestError.response?.data?.message || 'Failed to save');
    } finally {
      setLoadingAction('');
    }
  }

  async function saveEntireSession() {
    if (!audioBlob) {
      setError('Record the session before saving.');
      return;
    }

    setLoadingAction('save-session');
    setError('');
    setStatus('');

    try {
      const payload = new FormData();
      payload.append('sessionId', sessionId);
      payload.append('userName', patient.name);
      payload.append('userContact', patient.contact);
      payload.append('questionId', 'session');
      payload.append('question', 'Entire clinical session');
      payload.append('rawTranscript', transcript);
      payload.append('durationMs', String(durationMs));
      payload.append('audio', audioBlob, 'session.wav');

      const response = await api.post('/upload-voice-response', payload);
      setSavedResponses({ session: response.data.response });
      const driveError = response.data.progressiveZipError || response.data.submission?.progressiveZipUploadError;
      if (driveError) {
        setStatus('Session saved locally, but Drive upload failed. You can click Save again to retry.');
        setError(`Google Drive upload failed: ${driveError}`);
      } else {
        setStatus('Entire session saved successfully. Audio and transcript were added to the Drive ZIP.');
        setAudioBlob(null);
        setRecordingStopped(false);
        setDurationMs(0);
        setShowCompletionModal(true);
      }
    } catch (requestError) {
      console.error('Save session error:', requestError);
      setError(requestError.response?.data?.message || 'Failed to save session');
    } finally {
      setLoadingAction('');
    }
  }

  function renderRecorderControls(saveLabel, loadingKey, onSave) {
    return (
      <>
        <section className="form-panel recorder-panel">
          <div className="panel-heading">
            <h2>
              {recordingMode === 'session'
                ? 'Session Recorder'
                : currentQuestion.isEmotionReading ? 'Emotion Reading' : `Question ${stepIndex + 1}`}
            </h2>
            <p>
              {recordingMode === 'session'
                ? 'Record the entire clinical session in one continuous audio file.'
                : 'Read the prompt aloud at a natural pace. The reading guide highlights each word as you go.'}
            </p>
          </div>

          {recordingMode !== 'session' && !currentQuestion.isEmotionReading && (
            <div className="prompt-card">
              <BookOpenText size={20} className="prompt-card-icon" />
              <div className="prompt-card-body">
                <KaraokeReader
                  key={`prompt-${currentQuestion.id}-${readingEpoch}`}
                  lines={[{ id: currentQuestion.id, text: currentQuestion.text }]}
                  playing={isRecording}
                  speech={spoken}
                  voiceSupported={speechSupported}
                  compact
                />
              </div>
            </div>
          )}

          {recordingMode !== 'session' && currentQuestion.isEmotionReading && (
            <div className="prompt-card">
              <div className="prompt-card-body">
                <p className="prompt-card-title">Read the following sentences with their emotion:</p>
                <KaraokeReader
                  key={`emotion-${currentQuestion.id}-${readingEpoch}`}
                  lines={currentQuestion.emotions.map((group) => ({
                    id: group.emotion,
                    label: group.emotion,
                    tone: EMOTION_TONES[group.emotion] || 'calm',
                    text: group.sentence,
                  }))}
                  playing={isRecording}
                  speech={spoken}
                  voiceSupported={speechSupported}
                />
              </div>
            </div>
          )}

          {(isRecording || recordingStopped) && (
            <div className={`timer-chip ${isRecording ? 'recording' : 'done'}`}>
              {isRecording && <span className="recording-dot active" />}
              <span className="timer-value">{formatClock(isRecording ? elapsedSec : Math.round(durationMs / 1000))}</span>
              <span className="timer-note">
                {isRecording
                  ? (recordingMode !== 'session' && elapsedSec < 60 ? `${60 - elapsedSec}s until 1 minute` : 'Recording…')
                  : 'Recorded'}
              </span>
            </div>
          )}

          <div className="recorder-controls">
            {!isRecording ? (
              <button className={recordingStopped ? 'secondary disabled-look' : 'primary'} type="button" onClick={startRecording} disabled={recordingStopped}>
                <Mic size={18} />
                {recordingStopped ? 'Re-record to Start' : recordingMode === 'qa' && currentQuestionSaved ? 'Record Again' : 'Start Recording'}
              </button>
            ) : (
              <button type="button" onClick={stopRecording}>
                <CircleStop size={18} />
                Stop Recording
              </button>
            )}
            {recordingStopped && (
              <button className="secondary" type="button" onClick={rerecord}>
                <RotateCcw size={18} />
                Re-record
              </button>
            )}
            <span className={isRecording ? 'recording-dot active' : 'recording-dot'} />
          </div>

          {recordingMode === 'qa' && currentQuestionSaved && !audioBlob && !isRecording && !recordingStopped && (
            <div className="saved-response-info">
              <p className="success">This question has been saved.</p>
              {currentQuestionSaved.transcripts?.raw && (
                <div className="transcript-panel">
                  <span>Saved transcript</span>
                  <p>{currentQuestionSaved.transcripts.raw}</p>
                </div>
              )}
              <p className="inline-status">You can record again to replace this response.</p>
            </div>
          )}

          {audioPreviewUrl && (
            <div className="audio-preview">
              <span>Review your recording</span>
              <audio controls src={audioPreviewUrl} />
            </div>
          )}

          <div className="transcript-panel live-transcript-block">
            <span>Live transcript</span>
            <p>{transcript || 'Transcript will appear here when browser speech recognition is available.'}</p>
          </div>

          {audioBlob && <p className="inline-status">Recording is ready to save.</p>}
        </section>

        {status && <p className="success">{status}</p>}
        {error && <p className="error">{error}</p>}

        <div className="action-row">
          <button className="secondary" type="button" onClick={returnToModeChoice}>
            Back
          </button>
          <button type="button" onClick={onSave} disabled={loadingAction !== '' || !audioBlob}>
            <Save size={18} />
            {loadingAction === loadingKey ? 'Saving…' : saveLabel}
          </button>
        </div>
      </>
    );
  }

  if (!recordingMode) {
    return (
      <main className="page">
        <header className="page-header">
          <div>
            <p className="eyebrow">Patient Recording</p>
            <h1>Choose Recording Type</h1>
            <p>Select whether to capture one continuous session or use the guided question-and-answer prompts.</p>
          </div>
        </header>

        <section className="mode-grid">
          <button className="mode-option" type="button" onClick={() => setRecordingMode('session')}>
            <ClipboardList size={28} />
            <strong>Record Entire Session</strong>
            <span>Capture one continuous patient session with a live transcript and speaker diarization.</span>
          </button>
          <button className="mode-option" type="button" onClick={() => setRecordingMode('qa')}>
            <MessagesSquare size={28} />
            <strong>Question and Answer</strong>
            <span>Use the guided four-question workflow with a word-by-word reading guide.</span>
          </button>
        </section>
      </main>
    );
  }

  if (recordingMode === 'session') {
    return (
      <main className="page">
        <header className="page-header">
          <div>
            <p className="eyebrow">Patient Recording</p>
            <h1>Record Entire Session</h1>
            <p>Capture the full appointment audio and live transcript in one saved record.</p>
          </div>
          <div className="header-actions">
            <button className="secondary" type="button" onClick={startNewPatient}>
              <UserPlus size={18} />
              New Session
            </button>
          </div>
        </header>

        <section className="form-panel profile-panel">
          <label className="field">
            <span>Patient ID</span>
            <input value={patient.name} onChange={(event) => setPatient((current) => ({ ...current, name: event.target.value }))} />
          </label>
          <label className="field">
            <span>Contact</span>
            <input value={patient.contact} onChange={(event) => setPatient((current) => ({ ...current, contact: event.target.value }))} />
          </label>
        </section>

        {renderRecorderControls('Save Session', 'save-session', saveEntireSession)}

        {showCompletionModal && (
          <CompletionModal
            title="Recording Complete!"
            body="The session recording has been successfully saved."
            onClose={() => setShowCompletionModal(false)}
            onAnother={() => {
              setShowCompletionModal(false);
              startNewPatient();
            }}
            navigate={navigate}
          />
        )}
      </main>
    );
  }

  return (
    <main className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Patient Recording</p>
          <h1>Speech Analysis</h1>
          <p>Record patient voice prompts. Reports are generated later from the doctor dashboard.</p>
        </div>
        <div className="header-actions">
          <button className="secondary" type="button" onClick={startNewPatient}>
            <UserPlus size={18} />
            New Patient
          </button>
        </div>
      </header>

      <section className="form-panel profile-panel">
        <label className="field">
          <span>Patient name</span>
          <input value={patient.name} onChange={(event) => setPatient((current) => ({ ...current, name: event.target.value }))} />
        </label>
        <label className="field">
          <span>Contact or patient ID</span>
          <input value={patient.contact} onChange={(event) => setPatient((current) => ({ ...current, contact: event.target.value }))} />
        </label>
      </section>

      <div className="stepper">
        {voiceQuestions.map((question, index) => (
          <button
            key={question.id}
            className={index === stepIndex ? 'active' : ''}
            type="button"
            onClick={() => selectStep(index)}
          >
            <strong>{index + 1}</strong>
            <span>{savedResponses[question.id] ? 'Saved' : 'Pending'}</span>
          </button>
        ))}
      </div>

      {renderRecorderControls('Save and Next', 'save', saveAndNext)}

      {hasAllResponses && (
        <div className="form-panel completion-panel">
          <div className="completion-heading">
            <CheckCircle2 size={24} />
            <h3>All Recordings Saved</h3>
          </div>
          <p>Please hand this device back to the doctor.</p>
          <div className="completion-actions">
            <button className="primary" type="button" onClick={() => navigate('/admin')}>
              Go to Dashboard
            </button>
            <button className="secondary" type="button" onClick={startNewPatient}>
              Record Another Patient
            </button>
          </div>
        </div>
      )}

      {showCompletionModal && (
        <CompletionModal
          title="Recordings Complete!"
          body={`All ${voiceQuestions.length} recordings have been successfully saved.`}
          onClose={() => setShowCompletionModal(false)}
          onAnother={() => {
            setShowCompletionModal(false);
            startNewPatient();
          }}
          navigate={navigate}
        />
      )}
    </main>
  );
}

function CompletionModal({ title, body, onClose, onAnother, navigate }) {
  return (
    <div className="modal-overlay">
      <div className="modal-content text-center">
        <div className="modal-badge">
          <CheckCircle2 size={40} />
        </div>
        <h2>{title}</h2>
        <p>
          Thank you. {body}<br />
          <strong>Please hand this device back to the doctor.</strong>
        </p>
        <div className="modal-actions">
          <button className="primary" type="button" onClick={() => navigate('/admin')}>
            Go to Dashboard
          </button>
          <button className="secondary" type="button" onClick={onAnother}>
            Record Another Patient
          </button>
          <button className="text-button" type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

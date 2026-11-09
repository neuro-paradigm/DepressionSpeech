const { downloadFileFromDrive } = require('./googleDriveService');
const { extractZipEntries } = require('./zipService');

const QUESTION_ORDER = ['q1', 'q2', 'q3', 'q4', 'session'];
const serviceUrl = () => (process.env.FUSION_SERVICE_URL || 'http://127.0.0.1:8001').replace(/\/$/, '');

function responseEntries(submission) {
  const responses = Object.fromEntries(submission.responses || []);
  return QUESTION_ORDER
    .filter((questionId) => responses[questionId])
    .map((questionId) => ({ questionId, response: responses[questionId] }));
}

function buildPromptResponses(submission) {
  return responseEntries(submission).map(({ questionId, response }) => ({
    question_id: questionId,
    prompt: response.question || '',
    response: response.transcripts?.normalized || response.transcripts?.raw || '',
  }));
}

async function getAudioPayloads(submission) {
  if (!submission.progressiveZipGoogleDriveFileId) {
    throw new Error('No ZIP file found on Google Drive. Audio upload must succeed before running inference.');
  }
  const zip = await downloadFileFromDrive(submission.progressiveZipGoogleDriveFileId);
  const entries = new Map(extractZipEntries(zip).map((entry) => [entry.name, entry.content]));
  const result = [];
  for (const { questionId } of responseEntries(submission)) {
    const audio = entries.get(`audios/${questionId}.wav`) || entries.get(`${questionId}.wav`);
    if (!audio) continue;
    result.push({ filename: `${questionId}.wav`, data_base64: Buffer.from(audio).toString('base64') });
  }
  if (result.length === 0) {
    throw new Error('ZIP file downloaded, but no audio tracks were found inside it.');
  }
  return result;
}

async function predictFusion(submission) {
  const promptResponses = buildPromptResponses(submission);
  if (!promptResponses.some((item) => item.response.trim())) {
    throw new Error('No transcript is available for fusion inference.');
  }
  const audioFiles = await getAudioPayloads(submission);
  const response = await fetch(`${serviceUrl()}/predict`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt_responses: promptResponses, audio_files: audioFiles }),
    signal: AbortSignal.timeout(Number(process.env.FUSION_SERVICE_TIMEOUT_MS || 120000)),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.detail || `Fusion service returned HTTP ${response.status}.`);
  return body;
}

async function getFusionHealth() {
  try {
    const response = await fetch(`${serviceUrl()}/health`, { signal: AbortSignal.timeout(2500) });
    if (!response.ok) return { available: false, reason: `HTTP ${response.status}` };
    return { available: true, ...(await response.json()) };
  } catch (error) {
    return { available: false, reason: error.message };
  }
}

module.exports = { getFusionHealth, predictFusion };

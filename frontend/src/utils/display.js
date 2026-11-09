export function displayClassification(value) {
  if (!value) return 'Not available';
  if (value === 'CONTROL') return 'TYPICAL SPEECH PATTERN';
  if (value.includes('LIKE SPEECH PATTERN')) return 'ATYPICAL SPEECH PATTERN';
  return value;
}

export function classificationTone(value) {
  const display = displayClassification(value);
  if (display.startsWith('ATYPICAL')) return 'atypical';
  if (display.startsWith('TYPICAL')) return 'typical';
  return 'uncertain';
}

export function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
  const seconds = (totalSeconds % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}

export function formatClock(totalSeconds) {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safe / 60).toString().padStart(2, '0');
  const seconds = (safe % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}

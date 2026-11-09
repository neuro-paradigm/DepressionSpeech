// Module-level flag so the app shell (e.g. the sign-out button, which lives
// outside the recording page) can know that unsaved work exists.
let active = false;

export function setUnsavedWorkActive(value) {
  active = Boolean(value);
}

export function isUnsavedWorkActive() {
  return active;
}

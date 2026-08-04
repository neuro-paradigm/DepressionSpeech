'use strict';

/**
 * enrollmentService.js
 *
 * Node.js wrapper around the Python `enroll.py` script.
 * Spawns the script as a child process, writes the WAV buffer to a
 * persistent directory on disk, and returns the embedding path so it
 * can be re-used across all future diarization runs.
 *
 * The doctor embedding is stored at:
 *   <project-root>/backend/doctor_profile/doctor_embedding.npy
 *   <project-root>/backend/doctor_profile/doctor_reference.wav
 *
 * These files survive server restarts so enrollment is truly one-time.
 */

const { execFile } = require('child_process');
const fs   = require('fs');
const path = require('path');

// ── Paths ─────────────────────────────────────────────────────────────────────

/**
 * Absolute path to the enroll.py script.
 * __dirname is  backend/src/services  → go up two levels then into scripts/
 */
const ENROLL_SCRIPT = path.resolve(__dirname, '..', 'scripts', 'enroll.py');

/**
 * Persistent directory where the doctor profile is stored.
 * Lives at:  backend/doctor_profile/
 * This directory is NOT inside /tmp so it persists across restarts.
 */
const DOCTOR_PROFILE_DIR = path.resolve(__dirname, '..', '..', 'doctor_profile');

/** Absolute path to the saved embedding file. */
const EMBEDDING_PATH = path.join(DOCTOR_PROFILE_DIR, 'doctor_embedding.npy');

/** Absolute path to the saved reference WAV. */
const REFERENCE_WAV_PATH = path.join(DOCTOR_PROFILE_DIR, 'doctor_reference.wav');

/** Maximum wall-clock time (ms) allowed for the enrollment script. */
const TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes

// ── Helpers ───────────────────────────────────────────────────────────────────

function pythonExecutable() {
  return process.platform === 'win32' ? 'python' : 'python3';
}

function spawnEnroll(audioPath, outDir) {
  return new Promise((resolve, reject) => {
    const args = [
      ENROLL_SCRIPT,
      '--audio',  audioPath,
      '--outdir', outDir,
    ];

    execFile(
      pythonExecutable(),
      args,
      { timeout: TIMEOUT_MS, maxBuffer: 5 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (stderr) {
          console.log('[enroll] stderr:', stderr.slice(0, 500));
        }

        if (error) {
          try {
            const partial = JSON.parse(stdout || '{}');
            if (partial && !partial.success) {
              return reject(new Error(partial.error || error.message));
            }
          } catch (_) { /* ignore */ }
          return reject(error);
        }

        try {
          const result = JSON.parse(stdout || '{}');
          if (!result.success) {
            return reject(new Error(result.error || 'Enrollment script returned success=false'));
          }
          resolve(result);
        } catch (parseError) {
          reject(new Error(`Failed to parse enroll.py output: ${parseError.message}`));
        }
      }
    );
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run the doctor voice enrollment pipeline.
 *
 * Writes the WAV buffer to the persistent doctor_profile directory,
 * runs enroll.py, and returns metadata about the saved embedding.
 *
 * @param {Buffer} wavBuffer  - Raw WAV audio data (doctor's voice, 30–60 s).
 * @returns {Promise<{
 *   durationSec: number,
 *   embeddingShape: number[],
 *   embeddingMethod: string,
 *   referenceWav: string,
 *   embeddingPath: string,
 * }>}
 */
async function enrollDoctorVoice(wavBuffer) {
  // Ensure the persistent output directory exists
  fs.mkdirSync(DOCTOR_PROFILE_DIR, { recursive: true });

  // Write the incoming WAV to a temporary input file inside the profile dir
  const inputWavPath = path.join(DOCTOR_PROFILE_DIR, 'enroll_input.wav');
  fs.writeFileSync(inputWavPath, wavBuffer);

  console.log(
    `[enroll] Starting enrollment (${Math.round(wavBuffer.length / 1024)} KB) …`
  );

  try {
    const result = await spawnEnroll(inputWavPath, DOCTOR_PROFILE_DIR);
    console.log(
      `[enroll] Done — ${result.durationSec}s audio, ` +
      `method: ${result.embeddingMethod}, shape: ${result.embeddingShape}`
    );
    return result;
  } finally {
    // Clean up the temporary input copy (the reference WAV is kept by enroll.py)
    try { fs.unlinkSync(inputWavPath); } catch (_) { /* ignore */ }
  }
}

/**
 * Check whether a doctor embedding already exists on disk.
 *
 * @returns {{ enrolled: boolean, embeddingPath: string|null, referenceWav: string|null }}
 */
function getDoctorEnrollmentStatus() {
  const enrolled = fs.existsSync(EMBEDDING_PATH);
  return {
    enrolled,
    embeddingPath:    enrolled ? EMBEDDING_PATH     : null,
    referenceWavPath: fs.existsSync(REFERENCE_WAV_PATH) ? REFERENCE_WAV_PATH : null,
  };
}

/**
 * Delete the doctor profile (embedding + reference WAV) so the doctor
 * can re-enroll.
 */
function clearDoctorEnrollment() {
  try { fs.unlinkSync(EMBEDDING_PATH);     } catch (_) { /* ignore */ }
  try { fs.unlinkSync(REFERENCE_WAV_PATH); } catch (_) { /* ignore */ }
  console.log('[enroll] Doctor enrollment cleared.');
}

module.exports = {
  enrollDoctorVoice,
  getDoctorEnrollmentStatus,
  clearDoctorEnrollment,
  EMBEDDING_PATH,
  REFERENCE_WAV_PATH,
  DOCTOR_PROFILE_DIR,
};

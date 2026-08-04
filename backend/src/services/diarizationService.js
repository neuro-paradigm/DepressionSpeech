'use strict';

/**
 * diarizationService.js
 *
 * Node.js wrapper around the Python `diarize.py` script.
 * Spawns the script as a child process, collects the 6 output files,
 * and returns them as Buffers for inclusion in the ZIP.
 *
 * If diarization fails for any reason the function returns null so the
 * caller can continue building the ZIP without crashing.
 */

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Absolute path to the Python diarization script.
 * __dirname is  backend/src/services  → go up two levels then into scripts/.
 */
const DIARIZE_SCRIPT = path.resolve(__dirname, '..', 'scripts', 'diarize.py');

/**
 * Maximum wall-clock time (ms) allowed for the Python process.
 * Whisper tiny + diarization on a typical 3-minute clip takes ~30–60 s on CPU.
 */
const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Resolve the Python executable.
 * Prefer `python` (the user's system default) but fall back to `python3`.
 */
function pythonExecutable() {
  return process.platform === 'win32' ? 'python' : 'python3';
}

/**
 * Run diarize.py synchronously in a child process.
 *
 * @param {string} audioPath - Absolute path to the input WAV file.
 * @param {string} outDir    - Directory where output files will be written.
 * @param {object} [opts]
 * @param {string} [opts.whisperModel='tiny'] - Whisper model size.
 * @returns {Promise<object>} Parsed JSON result from the Python script.
 */
function spawnDiarize(audioPath, outDir, opts = {}) {
  const whisperModel = opts.whisperModel || 'tiny';

  return new Promise((resolve, reject) => {
    const args = [
      DIARIZE_SCRIPT,
      '--audio', audioPath,
      '--outdir', outDir,
      '--whisper-model', whisperModel,
    ];

    const python = execFile(
      pythonExecutable(),
      args,
      { timeout: TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (stderr) {
          // Python warnings / progress bars come through stderr — log but don't fail
          console.log('[diarize] stderr:', stderr.slice(0, 500));
        }

        if (error) {
          // Try to parse partial JSON from stdout even on non-zero exit
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
            return reject(new Error(result.error || 'Diarization script returned success=false'));
          }
          resolve(result);
        } catch (parseError) {
          reject(new Error(`Failed to parse diarize.py output: ${parseError.message}`));
        }
      }
    );

    // No stdin needed
    if (python.stdin) python.stdin.destroy();
  });
}

/**
 * Read a file into a Buffer, returning null if the file is missing.
 * @param {string} filePath
 * @returns {Buffer|null}
 */
function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath);
  } catch {
    return null;
  }
}

/**
 * Recursively remove a directory (best-effort, never throws).
 * @param {string} dirPath
 */
function removeDirSafe(dirPath) {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch {
    // Intentionally swallowed — cleanup failure must not crash the pipeline
  }
}

/**
 * Main entry point.
 *
 * Runs the full diarization pipeline on a WAV buffer and returns the
 * six per-speaker output files as Buffers, or null if anything fails.
 *
 * @param {Buffer}  wavBuffer  - Raw WAV audio data.
 * @param {string}  label      - Short label used to name the temp directory
 *                               (e.g. 'q1', 'session').
 * @param {object}  [opts]
 * @param {string}  [opts.whisperModel='tiny'] - Whisper model to use.
 *
 * @returns {Promise<{
 *   speaker1: { wav: Buffer, txt: Buffer, spectrogram: Buffer },
 *   speaker2: { wav: Buffer, txt: Buffer, spectrogram: Buffer },
 *   meta: object,
 * } | null>}
 */
async function runDiarization(wavBuffer, label = 'audio', opts = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `diarize-${label}-`));
  const inputWav = path.join(tempDir, 'input.wav');

  try {
    // Write the WAV buffer to a temp file so Python can read it
    fs.writeFileSync(inputWav, wavBuffer);

    console.log(`[diarize] Starting diarization for "${label}" (${Math.round(wavBuffer.length / 1024)} KB)`);

    const result = await spawnDiarize(inputWav, tempDir, opts);

    console.log(
      `[diarize] Done — ${result.totalDuration}s audio, ${result.segmentCount} segments. ` +
      `Speaker 1: ${result.speaker1?.durationSec}s, Speaker 2: ${result.speaker2?.durationSec}s`
    );

    // Read back the 6 output files
    const spk1Wav = readFileSafe(result.speaker1?.wav);
    const spk1Txt = readFileSafe(result.speaker1?.txt);
    const spk1Png = readFileSafe(result.speaker1?.spectrogram);
    const spk2Wav = readFileSafe(result.speaker2?.wav);
    const spk2Txt = readFileSafe(result.speaker2?.txt);
    const spk2Png = readFileSafe(result.speaker2?.spectrogram);

    if (!spk1Wav || !spk2Wav) {
      throw new Error('Diarization completed but speaker WAV files are missing');
    }

    return {
      speaker1: {
        wav: spk1Wav,
        txt: spk1Txt || Buffer.from('(No transcript available.)', 'utf8'),
        spectrogram: spk1Png,
      },
      speaker2: {
        wav: spk2Wav,
        txt: spk2Txt || Buffer.from('(No transcript available.)', 'utf8'),
        spectrogram: spk2Png,
      },
      meta: {
        totalDuration: result.totalDuration,
        segmentCount: result.segmentCount,
        speaker1Segments: result.speaker1?.segments,
        speaker2Segments: result.speaker2?.segments,
        speaker1Duration: result.speaker1?.durationSec,
        speaker2Duration: result.speaker2?.durationSec,
      },
    };
  } catch (error) {
    console.warn(`[diarize] Diarization failed for "${label}":`, error.message);
    return null;
  } finally {
    removeDirSafe(tempDir);
  }
}

module.exports = { runDiarization };

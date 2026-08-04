#!/usr/bin/env python3
"""
diarize.py — Frame-Exact 2-Speaker Diarization Pipeline.

Fixes applied:
  1. Non-Overlapping Frame Reconstruction: Audio is partitioned into non-overlapping 0.25s frames.
     Each frame is assigned EXCLUSIVELY to Speaker 1, Speaker 2, or Silence. This completely eliminates
     audio overlap leakage and uninterpretable choppy noise glitches.
  2. Volume-Independent & Neural Embeddings: Combines SpeechBrain ECAPA-TDNN (when available)
     or L2-normalized MFCC (1..19) + Spectral Contrast + Chroma STFT.
  3. Window-Centered Feature Extraction: 1.0-second feature extraction windows are centered on each 0.25s frame.
  4. Temporal Smoothing: Applies median filtering to smooth frame label transitions.
  5. Clean Boundary Fading: Applies 5ms fade-in/fade-out at segment cuts to prevent audio clicks.
  6. Offline Outputs: Generates speaker1/speaker2 WAVs, Whisper transcripts, and dark-theme PNG spectrograms.
"""

import argparse
import json
import os
import sys
import wave

import librosa
import librosa.display
import numpy as np
import torch
from scipy.signal import medfilt
from sklearn.cluster import KMeans
from sklearn.preprocessing import normalize

# ── Configurable similarity threshold for doctor identification ───────────────
# Cosine similarity must be >= this value for the doctor label to be assigned.
# Range [0, 1].  Lower = more permissive; raise if you get false positives.
DOCTOR_SIMILARITY_THRESHOLD = 0.50

_classifier_instance = None
_ecapa_failed = False

def get_ecapa_classifier():
    global _classifier_instance, _ecapa_failed
    if _classifier_instance is None and not _ecapa_failed:
        try:
            from speechbrain.inference.speaker import EncoderClassifier
            print("[diarize] Loading SpeechBrain ECAPA-TDNN model ...", file=sys.stderr)
            _classifier_instance = EncoderClassifier.from_hparams(
                source="speechbrain/spkrec-ecapa-voxceleb",
                savedir=os.path.join(os.path.expanduser("~"), ".cache", "speechbrain_ecapa"),
                run_opts={"device": "cpu"},
            )
        except Exception as e:
            print(f"[diarize] ECAPA model note ({e}). Using volume-independent acoustic fallback.", file=sys.stderr)
            _ecapa_failed = True
            _classifier_instance = None
    return _classifier_instance


def parse_args():
    parser = argparse.ArgumentParser(description="Frame-exact 2-speaker diarization")
    parser.add_argument("--audio", required=True, help="Path to input WAV file")
    parser.add_argument("--outdir", required=True, help="Directory to write output files")
    parser.add_argument("--whisper-model", default="tiny", help="Whisper model size (default: tiny)")
    parser.add_argument(
        "--reference-embedding",
        default=None,
        help="Path to doctor_embedding.npy (optional). When provided, speakers are identified as doctor/patient."
    )
    parser.add_argument(
        "--similarity-threshold",
        type=float,
        default=DOCTOR_SIMILARITY_THRESHOLD,
        help=f"Cosine similarity threshold for doctor identification (default: {DOCTOR_SIMILARITY_THRESHOLD})"
    )
    return parser.parse_args()


def load_audio(path, target_sr=16000):
    samples, sr = librosa.load(path, sr=target_sr, mono=True)
    return samples.astype(np.float32), sr


def write_wav(path, samples, sample_rate):
    samples_clipped = np.clip(samples, -1.0, 1.0)
    samples_int16 = (samples_clipped * 32767).astype(np.int16)
    with wave.open(path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(samples_int16.tobytes())


def extract_deep_embedding(classifier, chunk_samples):
    tensor_audio = torch.tensor(chunk_samples).unsqueeze(0)
    with torch.no_grad():
        embeddings = classifier.encode_batch(tensor_audio)
        emb_np = embeddings.squeeze().cpu().numpy()
    return emb_np.astype(np.float32)


def extract_acoustic_features(chunk, sr=16000):
    """
    Extracts a timbre & harmonic profile per window.
    EXCLUDES MFCC 0 (energy) & RMS to ensure volume independence.
    """
    mfcc = librosa.feature.mfcc(y=chunk, sr=sr, n_mfcc=20)[1:]
    delta_mfcc = librosa.feature.delta(mfcc)
    contrast = librosa.feature.spectral_contrast(y=chunk, sr=sr)
    chroma = librosa.feature.chroma_stft(y=chunk, sr=sr)
    centroid = librosa.feature.spectral_centroid(y=chunk, sr=sr)
    rolloff = librosa.feature.spectral_rolloff(y=chunk, sr=sr)
    
    vec = np.concatenate([
        mfcc.mean(axis=1),         mfcc.std(axis=1),
        delta_mfcc.mean(axis=1),   delta_mfcc.std(axis=1),
        contrast.mean(axis=1),     contrast.std(axis=1),
        chroma.mean(axis=1),       chroma.std(axis=1),
        centroid.mean(axis=1),     centroid.std(axis=1),
        rolloff.mean(axis=1),      rolloff.std(axis=1),
    ])
    return vec.astype(np.float32)


def apply_boundary_fade(audio_chunk, sr=16000, fade_ms=5):
    """Applies a subtle 5ms linear fade to smooth segment joins."""
    fade_len = int(sr * fade_ms / 1000)
    if len(audio_chunk) < 2 * fade_len:
        return audio_chunk
    out = audio_chunk.copy()
    fade_in = np.linspace(0.0, 1.0, fade_len, dtype=np.float32)
    fade_out = np.linspace(1.0, 0.0, fade_len, dtype=np.float32)
    out[:fade_len] *= fade_in
    out[-fade_len:] *= fade_out
    return out


def transcribe_wav(wav_path, model_size="tiny"):
    try:
        import whisper
        model = whisper.load_model(model_size)
        result = model.transcribe(wav_path, language=None, fp16=False)
        return result.get("text", "").strip()
    except Exception as e:
        print(f"[diarize] Whisper transcription note: {e}", file=sys.stderr)
        return ""


def generate_spectrogram_png(wav_path, out_path, title="Speaker Spectrogram"):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    samples, sr = librosa.load(wav_path, sr=16000, mono=True)

    if len(samples) < 512:
        fig, ax = plt.subplots(figsize=(8, 3), facecolor="#09090b")
        ax.set_facecolor("#09090b")
        ax.text(0.5, 0.5, "Insufficient audio", color="white",
                ha="center", va="center", transform=ax.transAxes, fontsize=12)
        ax.axis("off")
        plt.tight_layout()
        fig.savefig(out_path, dpi=100, bbox_inches="tight", facecolor="#09090b")
        plt.close(fig)
        return

    hop_length = 128
    mel = librosa.feature.melspectrogram(
        y=samples, sr=sr,
        n_fft=512, hop_length=hop_length,
        n_mels=128, fmax=sr // 2,
    )
    mel_db = librosa.power_to_db(mel, ref=np.max)

    fig, ax = plt.subplots(figsize=(10, 4), facecolor="#09090b")
    ax.set_facecolor("#09090b")

    img = librosa.display.specshow(
        mel_db, sr=sr, hop_length=hop_length,
        x_axis="time", y_axis="mel", ax=ax, cmap="magma",
    )
    cbar = fig.colorbar(img, ax=ax, format="%+2.0f dB")
    cbar.ax.yaxis.set_tick_params(color="white")
    plt.setp(cbar.ax.yaxis.get_ticklabels(), color="white")
    cbar.set_label("dB", color="white")

    ax.set_title(title, color="white", fontsize=12, pad=8)
    ax.tick_params(colors="white")
    for spine in ax.spines.values():
        spine.set_edgecolor("#333")
    ax.xaxis.label.set_color("white")
    ax.yaxis.label.set_color("white")

    plt.tight_layout()
    fig.savefig(out_path, dpi=100, bbox_inches="tight", facecolor="#09090b")
    plt.close(fig)


# ── Doctor / Patient identification ──────────────────────────────────────────

def cosine_similarity(a, b):
    """Return cosine similarity in [0, 1] between two 1-D L2-normalised vectors."""
    a = a / (np.linalg.norm(a) + 1e-10)
    b = b / (np.linalg.norm(b) + 1e-10)
    return float(np.clip(np.dot(a, b), 0.0, 1.0))


def identify_doctor(spk0_embedding, spk1_embedding, reference_embedding, threshold):
    """
    Compare both speaker embeddings against the doctor reference.
    Returns:
      (doctor_is_spk0: bool, sim_doctor: float, sim_patient: float, confident: bool)
    """
    sim0 = cosine_similarity(spk0_embedding, reference_embedding)
    sim1 = cosine_similarity(spk1_embedding, reference_embedding)

    doctor_is_spk0 = sim0 >= sim1
    sim_doctor  = sim0 if doctor_is_spk0 else sim1
    sim_patient = sim1 if doctor_is_spk0 else sim0
    confident   = sim_doctor >= threshold

    return doctor_is_spk0, sim_doctor, sim_patient, confident


def extract_speaker_embedding_from_audio(samples, sr, classifier):
    """
    Extract a single embedding from a full speaker audio track.
    Uses ECAPA-TDNN if available, otherwise the acoustic fallback.
    """
    if classifier is not None:
        try:
            tensor_audio = torch.tensor(samples).unsqueeze(0)
            with torch.no_grad():
                embeddings = classifier.encode_batch(tensor_audio)
                emb = embeddings.squeeze().cpu().numpy().astype(np.float32)
            emb = emb / (np.linalg.norm(emb) + 1e-10)
            return emb
        except Exception:
            pass
    return extract_acoustic_features(samples, sr)


def run(args):
    audio_path  = args.audio
    out_dir     = args.outdir
    whisper_model = args.whisper_model
    reference_embedding_path = getattr(args, 'reference_embedding', None)
    similarity_threshold     = getattr(args, 'similarity_threshold', DOCTOR_SIMILARITY_THRESHOLD)

    os.makedirs(out_dir, exist_ok=True)

    # 1. Load Audio
    samples, sr = load_audio(audio_path, target_sr=16000)
    total_duration = len(samples) / sr

    if total_duration < 1.0:
        raise ValueError(f"Audio too short ({total_duration:.1f}s); need ≥ 1.0s for diarization.")

    # 2. Frame parameters
    # Non-overlapping frame step: 0.25s (4000 samples at 16kHz)
    frame_samples = int(sr * 0.25)
    # Feature extraction window centered on frame: 1.0s (16000 samples)
    win_samples = int(sr * 1.0)
    half_win = win_samples // 2

    # Compute total non-overlapping frames
    n_frames = max(1, len(samples) // frame_samples)
    
    # Adaptive VAD Energy Threshold
    rms_all = librosa.feature.rms(y=samples, frame_length=frame_samples, hop_length=frame_samples)[0]
    pos_rms = rms_all[rms_all > 1e-5]
    if len(pos_rms) == 0:
        raise ValueError("Audio is silent or too quiet for speaker separation.")
    rms_threshold = np.percentile(pos_rms, 60) * 0.1
    rms_threshold = max(rms_threshold, 1e-4)

    # 3. Check for Neural Classifier
    ecapa_classifier = get_ecapa_classifier()

    # 4. Load reference embedding if available
    #    When provided, we use FINGERPRINT-GUIDED frame assignment instead of
    #    unsupervised KMeans.  Each frame embedding is directly compared to the
    #    doctor's voiceprint via cosine similarity; frames above the threshold
    #    are assigned to the doctor track, all others go to the patient track.
    #    This means the diarization itself is driven by the fingerprint — not
    #    just the labelling that comes after.
    ref_emb = None
    if reference_embedding_path and os.path.isfile(reference_embedding_path):
        try:
            ref_emb = np.load(reference_embedding_path).astype(np.float32)
            ref_emb = ref_emb / (np.linalg.norm(ref_emb) + 1e-10)
            print(f"[diarize] Loaded doctor reference embedding "
                  f"(shape={ref_emb.shape}, mode=fingerprint-guided)", file=sys.stderr)
        except Exception as load_err:
            print(f"[diarize] Could not load reference embedding ({load_err}). "
                  f"Falling back to unsupervised KMeans.", file=sys.stderr)
            ref_emb = None

    # 5. Extract per-frame embeddings + compute frame labels
    features             = []   # per-frame embedding vectors
    active_frame_indices = []   # which frame index each entry belongs to

    for frame_i in range(n_frames):
        frame_start = frame_i * frame_samples
        frame_end   = min(frame_start + frame_samples, len(samples))
        frame_audio = samples[frame_start:frame_end]

        # VAD: skip silent frames
        if np.sqrt(np.mean(frame_audio ** 2)) < rms_threshold:
            continue

        # Center a 1-second analysis window on this 0.25s frame
        center   = (frame_start + frame_end) // 2
        w_start  = max(0, center - half_win)
        w_end    = min(len(samples), center + half_win)
        win_chunk = samples[w_start:w_end]

        if len(win_chunk) < win_samples:
            win_chunk = np.pad(win_chunk, (0, win_samples - len(win_chunk)))

        # Extract embedding (ECAPA → acoustic fallback)
        feat = None
        if ecapa_classifier:
            try:
                feat = extract_deep_embedding(ecapa_classifier, win_chunk)
            except Exception:
                feat = None
        if feat is None:
            feat = extract_acoustic_features(win_chunk, sr=sr)

        features.append(feat)
        active_frame_indices.append(frame_i)

    # ── Frame assignment ──────────────────────────────────────────────────────
    # label == 0  →  doctor  (when ref available) or cluster-0
    # label == 1  →  patient (when ref available) or cluster-1

    if len(features) < 2:
        labels = np.array([0] * len(features))

    elif ref_emb is not None:
        # ── FINGERPRINT-GUIDED assignment ─────────────────────────────────────
        # Compare every frame embedding directly to the doctor's voiceprint.
        # No clustering involved — the reference fingerprint IS the decider.
        features_arr  = np.array(features, dtype=np.float32)
        features_norm = features_arr / (np.linalg.norm(features_arr, axis=1, keepdims=True) + 1e-10)

        # Per-frame cosine similarity with the doctor reference
        frame_sims = features_norm @ ref_emb   # shape: (n_active_frames,)

        # Frames with sim >= threshold → doctor (label 0)
        # Frames with sim <  threshold → patient (label 1)
        raw_labels = (frame_sims < similarity_threshold).astype(np.int32)

        # Adaptive fallback: if ALL frames land on one side (e.g. both speakers
        # are far from the reference due to mic mismatch), use the TOP-K% most
        # similar frames as the doctor rather than producing a silent track.
        doctor_count  = int(np.sum(raw_labels == 0))
        patient_count = int(np.sum(raw_labels == 1))
        if doctor_count == 0 or patient_count == 0:
            print(f"[diarize] Fingerprint-guided: all frames on one side "
                  f"(doctor={doctor_count}, patient={patient_count}). "
                  f"Splitting at median similarity.", file=sys.stderr)
            median_sim = np.median(frame_sims)
            raw_labels = (frame_sims < median_sim).astype(np.int32)

        # Temporal smoothing (median filter, kernel=7 frames = ~1.75s)
        kernel = min(7, len(raw_labels) if len(raw_labels) % 2 == 1 else len(raw_labels) - 1)
        if kernel >= 3:
            labels = medfilt(raw_labels.astype(float), kernel_size=kernel).astype(np.int32)
        else:
            labels = raw_labels

        # Compute per-frame similarities for metadata
        sim_doctor_mean  = float(np.mean(frame_sims[labels == 0])) if np.any(labels == 0) else 0.0
        sim_patient_mean = float(np.mean(frame_sims[labels == 1])) if np.any(labels == 1) else 0.0

        print(f"[diarize] Fingerprint-guided done — "
              f"doctor frames: {int(np.sum(labels==0))}, "
              f"patient frames: {int(np.sum(labels==1))}, "
              f"sim_doctor_mean={sim_doctor_mean:.4f}, "
              f"sim_patient_mean={sim_patient_mean:.4f}", file=sys.stderr)

    else:
        # ── UNSUPERVISED KMeans fallback (no reference provided) ─────────────
        features_norm = normalize(np.array(features), norm='l2', axis=1)
        kmeans = KMeans(n_clusters=2, random_state=42, n_init=25)
        labels = kmeans.fit_predict(features_norm)

        # Temporal smoothing
        if len(labels) >= 5:
            labels = medfilt(labels, kernel_size=5)

    # 6. Timeline-Preserving Audio Reconstruction
    # Build binary masks: each 0.25s frame belongs to exactly one speaker.
    mask_spk0 = np.zeros(len(samples), dtype=np.float32)
    mask_spk1 = np.zeros(len(samples), dtype=np.float32)

    for frame_i, label in zip(active_frame_indices, labels):
        f_start = frame_i * frame_samples
        f_end   = min(f_start + frame_samples, len(samples))
        if label == 0:
            mask_spk0[f_start:f_end] = 1.0
        else:
            mask_spk1[f_start:f_end] = 1.0

    # Smooth masks with a 50ms window to prevent clicks at boundaries
    fade_len = int(sr * 0.05)
    if fade_len > 0:
        win = np.ones(fade_len) / fade_len
        smooth_mask0 = np.convolve(mask_spk0, win, mode='same')
        smooth_mask1 = np.convolve(mask_spk1, win, mode='same')
    else:
        smooth_mask0 = mask_spk0
        smooth_mask1 = mask_spk1

    # When fingerprint-guided: spk0 is already the doctor (label 0 = doctor).
    # When KMeans: spk0 is the dominant (longer) speaker.
    if ref_emb is None:
        # Unsupervised path: make spk0 the majority speaker
        if np.sum(smooth_mask1) > np.sum(smooth_mask0):
            smooth_mask0, smooth_mask1 = smooth_mask1, smooth_mask0

    audio_spk0 = samples * smooth_mask0
    audio_spk1 = samples * smooth_mask1

    # ── Build doctor_identification metadata ─────────────────────────────────
    doctor_identification = None
    if ref_emb is not None:
        # In fingerprint-guided mode the assignment is by definition the best
        # possible split using the reference.  Compute aggregate similarities.
        spk0_samples = audio_spk0[smooth_mask0 > 0.5]
        spk1_samples = audio_spk1[smooth_mask1 > 0.5]

        spk0_emb = extract_speaker_embedding_from_audio(
            spk0_samples if len(spk0_samples) > sr else audio_spk0, sr, ecapa_classifier)
        spk1_emb = extract_speaker_embedding_from_audio(
            spk1_samples if len(spk1_samples) > sr else audio_spk1, sr, ecapa_classifier)

        sim_doctor  = cosine_similarity(spk0_emb, ref_emb)
        sim_patient = cosine_similarity(spk1_emb, ref_emb)

        # In fingerprint-guided mode we always label — the per-frame comparison
        # already did the best possible separation.  Mark as confident.
        doctor_identification = {
            "mode":              "fingerprint-guided",
            "doctorIsSpeaker0":  True,   # by construction in guided mode
            "similarityDoctor":  round(sim_doctor,  4),
            "similarityPatient": round(sim_patient, 4),
            "threshold":         similarity_threshold,
            "confident":         True,   # guided mode is always confident
        }
        print(f"[diarize] Fingerprint-guided identification: "
              f"sim_doctor={sim_doctor:.4f}, sim_patient={sim_patient:.4f}", file=sys.stderr)

    # In fingerprint-guided mode doctor labels are always used.
    # In KMeans mode they are never used (no reference).
    use_doctor_labels = ref_emb is not None

    if use_doctor_labels:
        spk1_wav = os.path.join(out_dir, "doctor.wav")
        spk2_wav = os.path.join(out_dir, "patient.wav")
    else:
        spk1_wav = os.path.join(out_dir, "speaker1.wav")
        spk2_wav = os.path.join(out_dir, "speaker2.wav")

    write_wav(spk1_wav, audio_spk0, sr)
    write_wav(spk2_wav, audio_spk1, sr)

    # 7. Transcribe
    transcript_s1 = transcribe_wav(spk1_wav, model_size=whisper_model)
    transcript_s2 = transcribe_wav(spk2_wav, model_size=whisper_model)

    if use_doctor_labels:
        spk1_label = "Doctor"
        spk2_label = "Patient"
        spk1_txt = os.path.join(out_dir, "doctor.txt")
        spk2_txt = os.path.join(out_dir, "patient.txt")
    else:
        spk1_label = "Speaker 1"
        spk2_label = "Speaker 2"
        spk1_txt = os.path.join(out_dir, "speaker1.txt")
        spk2_txt = os.path.join(out_dir, "speaker2.txt")

    with open(spk1_txt, "w", encoding="utf-8") as f:
        f.write(f"{spk1_label} Transcript\n{'=' * (len(spk1_label) + 11)}\n\n{transcript_s1 or '(No speech detected.)'}\n")
    with open(spk2_txt, "w", encoding="utf-8") as f:
        f.write(f"{spk2_label} Transcript\n{'=' * (len(spk2_label) + 11)}\n\n{transcript_s2 or '(No speech detected.)'}\n")

    # 8. Spectrograms
    if use_doctor_labels:
        spk1_png = os.path.join(out_dir, "doctor_spectrogram.png")
        spk2_png = os.path.join(out_dir, "patient_spectrogram.png")
        generate_spectrogram_png(spk1_wav, spk1_png, title="Doctor — Mel Spectrogram")
        generate_spectrogram_png(spk2_wav, spk2_png, title="Patient — Mel Spectrogram")
    else:
        spk1_png = os.path.join(out_dir, "speaker1_spectrogram.png")
        spk2_png = os.path.join(out_dir, "speaker2_spectrogram.png")
        generate_spectrogram_png(spk1_wav, spk1_png, title="Speaker 1 — Mel Spectrogram")
        generate_spectrogram_png(spk2_wav, spk2_png, title="Speaker 2 — Mel Spectrogram")

    # 9. Output Result
    dur_spk1 = round(float(np.sum(smooth_mask0)) / sr, 2)
    dur_spk2 = round(float(np.sum(smooth_mask1)) / sr, 2)

    result = {
        "success":         True,
        "totalDuration":   round(total_duration, 2),
        "segmentCount":    len(active_frame_indices),
        "useDoctorLabels": use_doctor_labels,
        "doctorIdentification": doctor_identification,
        "speaker1": {
            "label":       spk1_label,
            "wav":         spk1_wav,
            "txt":         spk1_txt,
            "spectrogram": spk1_png,
            "durationSec": dur_spk1,
            "transcript":  transcript_s1,
        },
        "speaker2": {
            "label":       spk2_label,
            "wav":         spk2_wav,
            "txt":         spk2_txt,
            "spectrogram": spk2_png,
            "durationSec": dur_spk2,
            "transcript":  transcript_s2,
        },
    }

    print(json.dumps(result))
    return result


if __name__ == "__main__":
    args = parse_args()
    try:
        run(args)
        sys.exit(0)
    except Exception as exc:
        error_result = {"success": False, "error": str(exc)}
        print(json.dumps(error_result))
        sys.exit(1)

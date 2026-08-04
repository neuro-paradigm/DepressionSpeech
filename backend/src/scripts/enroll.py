#!/usr/bin/env python3
"""
enroll.py — Doctor Voice Enrollment Script.

Takes a WAV file of the doctor's voice (30–60 s recommended) and saves:
  - doctor_reference.wav   : the cleaned 16 kHz mono copy used for enrollment
  - doctor_embedding.npy   : L2-normalised speaker embedding (numpy array)

Model priority:
  1. SpeechBrain ECAPA-TDNN   (512-dim neural embedding)
  2. Acoustic fallback        (MFCC + spectral contrast, volume-independent)

Usage:
  python enroll.py --audio /path/to/doctor.wav --outdir /path/to/output
"""

import argparse
import json
import os
import sys
import wave

import librosa
import numpy as np
import torch
from sklearn.preprocessing import normalize


# ── Module-level singleton so the heavy model is loaded only once ─────────────
_classifier_instance = None
_ecapa_failed = False


def get_ecapa_classifier():
    global _classifier_instance, _ecapa_failed
    if _classifier_instance is None and not _ecapa_failed:
        try:
            from speechbrain.inference.speaker import EncoderClassifier
            print("[enroll] Loading SpeechBrain ECAPA-TDNN …", file=sys.stderr)
            _classifier_instance = EncoderClassifier.from_hparams(
                source="speechbrain/spkrec-ecapa-voxceleb",
                savedir=os.path.join(os.path.expanduser("~"), ".cache", "speechbrain_ecapa"),
                run_opts={"device": "cpu"},
            )
            print("[enroll] ECAPA-TDNN loaded successfully.", file=sys.stderr)
        except Exception as exc:
            print(f"[enroll] ECAPA unavailable ({exc}). Using acoustic fallback.", file=sys.stderr)
            _ecapa_failed = True
    return _classifier_instance


# ── Audio helpers ─────────────────────────────────────────────────────────────

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


# ── Embedding extractors ──────────────────────────────────────────────────────

def extract_ecapa_embedding(classifier, samples):
    """Return a 512-dim L2-normalised embedding via ECAPA-TDNN."""
    tensor_audio = torch.tensor(samples).unsqueeze(0)
    with torch.no_grad():
        embeddings = classifier.encode_batch(tensor_audio)
        emb = embeddings.squeeze().cpu().numpy().astype(np.float32)
    emb = emb / (np.linalg.norm(emb) + 1e-10)
    return emb


def extract_acoustic_embedding(samples, sr=16000):
    """
    Volume-independent acoustic embedding.
    Excludes MFCC-0 (energy) and RMS so the fingerprint is timbre-only.
    """
    mfcc        = librosa.feature.mfcc(y=samples, sr=sr, n_mfcc=20)[1:]  # skip coeff-0
    delta_mfcc  = librosa.feature.delta(mfcc)
    contrast    = librosa.feature.spectral_contrast(y=samples, sr=sr)
    chroma      = librosa.feature.chroma_stft(y=samples, sr=sr)
    centroid    = librosa.feature.spectral_centroid(y=samples, sr=sr)
    rolloff     = librosa.feature.spectral_rolloff(y=samples, sr=sr)

    vec = np.concatenate([
        mfcc.mean(axis=1),        mfcc.std(axis=1),
        delta_mfcc.mean(axis=1),  delta_mfcc.std(axis=1),
        contrast.mean(axis=1),    contrast.std(axis=1),
        chroma.mean(axis=1),      chroma.std(axis=1),
        centroid.mean(axis=1),    centroid.std(axis=1),
        rolloff.mean(axis=1),     rolloff.std(axis=1),
    ]).astype(np.float32)

    vec = vec / (np.linalg.norm(vec) + 1e-10)
    return vec


# ── Main ──────────────────────────────────────────────────────────────────────

def parse_args():
    parser = argparse.ArgumentParser(description="Doctor voice enrollment")
    parser.add_argument("--audio",  required=True, help="Path to doctor WAV file")
    parser.add_argument("--outdir", required=True, help="Directory for output files")
    return parser.parse_args()


def run(args):
    audio_path = args.audio
    out_dir    = args.outdir
    os.makedirs(out_dir, exist_ok=True)

    # 1. Load & validate
    samples, sr = load_audio(audio_path, target_sr=16000)
    duration = len(samples) / sr

    if duration < 5.0:
        raise ValueError(f"Recording too short ({duration:.1f}s). Please record at least 5 seconds of speech.")

    print(f"[enroll] Loaded {duration:.1f}s of audio at {sr} Hz.", file=sys.stderr)

    # 2. Save cleaned WAV reference
    ref_wav_path = os.path.join(out_dir, "doctor_reference.wav")
    write_wav(ref_wav_path, samples, sr)

    # 3. Extract embedding
    classifier = get_ecapa_classifier()
    embedding_method = "ecapa-tdnn"

    if classifier is not None:
        try:
            embedding = extract_ecapa_embedding(classifier, samples)
        except Exception as exc:
            print(f"[enroll] ECAPA forward pass failed ({exc}), falling back.", file=sys.stderr)
            embedding = extract_acoustic_embedding(samples, sr)
            embedding_method = "acoustic-fallback"
    else:
        embedding = extract_acoustic_embedding(samples, sr)
        embedding_method = "acoustic-fallback"

    print(f"[enroll] Embedding method: {embedding_method}, shape: {embedding.shape}", file=sys.stderr)

    # 4. Save embedding
    emb_path = os.path.join(out_dir, "doctor_embedding.npy")
    np.save(emb_path, embedding)

    # 5. Output result JSON
    result = {
        "success": True,
        "durationSec":       round(duration, 2),
        "embeddingShape":    list(embedding.shape),
        "embeddingMethod":   embedding_method,
        "referenceWav":      ref_wav_path,
        "embeddingPath":     emb_path,
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

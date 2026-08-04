#!/usr/bin/env python3
"""
diarize.py — Volume-Independent & Neural 2-Speaker Diarization Pipeline.

Key Features:
  1. Deep Neural Speaker Embeddings: Attempts SpeechBrain ECAPA-TDNN (spkrec-ecapa-voxceleb)
     to extract 192-dimensional vocal biometrics for same-gender speaker separation (e.g. 2 girls).
  2. Safe Acoustic Feature Fallback: If neural embeddings are unavailable, uses volume-independent
     spectral contrast, chroma, and MFCC 1..19 features.
  3. L2 Unit Normalization: Rescales feature vectors to unit length so clustering compares pure
     vocal timbre/pitch direction rather than volume/gain.
  4. Spectral & KMeans Clustering: Clusters 1.0s sliding windows into 2 speakers.
  5. Temporal Smoothing: Applies median filtering to smooth frame predictions.
  6. Offline Outputs: Generates speaker1/speaker2 WAVs, Whisper transcripts, and PNG spectrograms.
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
from sklearn.cluster import KMeans, SpectralClustering
from sklearn.preprocessing import normalize

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
    parser = argparse.ArgumentParser(description="Volume-Independent 2-speaker diarization")
    parser.add_argument("--audio", required=True, help="Path to input WAV file")
    parser.add_argument("--outdir", required=True, help="Directory to write output files")
    parser.add_argument("--whisper-model", default="tiny", help="Whisper model size (default: tiny)")
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


def run(args):
    audio_path = args.audio
    out_dir = args.outdir
    whisper_model = args.whisper_model

    os.makedirs(out_dir, exist_ok=True)

    # 1. Load Audio
    samples, sr = load_audio(audio_path, target_sr=16000)
    total_duration = len(samples) / sr

    if total_duration < 1.5:
        raise ValueError(f"Audio too short ({total_duration:.1f}s); need ≥ 1.5s for diarization.")

    # 2. Window parameters (1.0s window, 0.25s hop)
    win_samples = int(sr * 1.0)
    hop_samples = int(sr * 0.25)
    
    # Compute RMS energy for adaptive VAD threshold
    frame_rms = librosa.feature.rms(y=samples, frame_length=win_samples, hop_length=hop_samples)[0]
    positive_rms = frame_rms[frame_rms > 1e-5]
    
    if len(positive_rms) == 0:
        raise ValueError("Audio is silent or too quiet for speaker separation.")
        
    rms_threshold = np.percentile(positive_rms, 70) * 0.1
    rms_threshold = max(rms_threshold, 1e-4)

    # 3. Check for Neural Classifier
    ecapa_classifier = get_ecapa_classifier()

    # 4. Extract Window Features
    features = []
    window_map = []

    n_hops = (len(samples) - win_samples) // hop_samples + 1
    for i in range(n_hops):
        start = i * hop_samples
        end = start + win_samples
        chunk = samples[start:end]
        
        if np.sqrt(np.mean(chunk**2)) < rms_threshold:
            continue
            
        feat = None
        if ecapa_classifier:
            try:
                feat = extract_deep_embedding(ecapa_classifier, chunk)
            except Exception:
                feat = None

        if feat is None:
            feat = extract_acoustic_features(chunk, sr=sr)

        features.append(feat)
        window_map.append((start, end))

    if len(features) < 2:
        labels = np.array([0] * len(features))
    else:
        # 5. L2 Normalization (unit length vectors for cosine similarity)
        features_norm = normalize(np.array(features), norm='l2', axis=1)

        # 6. KMeans / Spectral Clustering
        try:
            kmeans = KMeans(n_clusters=2, random_state=42, n_init=25)
            labels = kmeans.fit_predict(features_norm)
        except Exception:
            labels = np.array([0] * len(features))

        # 7. Temporal Smoothing (Median Filter)
        if len(labels) >= 5:
            labels = medfilt(labels, kernel_size=5)

    # 8. Map window labels back to audio samples
    speaker0_mask = np.zeros(len(samples), dtype=bool)
    speaker1_mask = np.zeros(len(samples), dtype=bool)

    for (start, end), label in zip(window_map, labels):
        if label == 0:
            speaker0_mask[start:end] = True
        else:
            speaker1_mask[start:end] = True

    audio_spk0 = samples[speaker0_mask]
    audio_spk1 = samples[speaker1_mask]

    # Ensure Speaker 1 is dominant (more speech duration)
    if len(audio_spk1) > len(audio_spk0):
        audio_spk0, audio_spk1 = audio_spk1, audio_spk0

    spk1_wav = os.path.join(out_dir, "speaker1.wav")
    spk2_wav = os.path.join(out_dir, "speaker2.wav")

    write_wav(spk1_wav, audio_spk0 if len(audio_spk0) > 0 else np.zeros(16000, dtype=np.float32), sr)
    write_wav(spk2_wav, audio_spk1 if len(audio_spk1) > 0 else np.zeros(16000, dtype=np.float32), sr)

    # 9. Transcribe
    transcript_s1 = transcribe_wav(spk1_wav, model_size=whisper_model)
    transcript_s2 = transcribe_wav(spk2_wav, model_size=whisper_model)

    spk1_txt = os.path.join(out_dir, "speaker1.txt")
    spk2_txt = os.path.join(out_dir, "speaker2.txt")

    with open(spk1_txt, "w", encoding="utf-8") as f:
        f.write(f"Speaker 1 Transcript\n====================\n\n{transcript_s1 or '(No speech detected.)'}\n")
    with open(spk2_txt, "w", encoding="utf-8") as f:
        f.write(f"Speaker 2 Transcript\n====================\n\n{transcript_s2 or '(No speech detected.)'}\n")

    # 10. Spectrograms
    spk1_png = os.path.join(out_dir, "speaker1_spectrogram.png")
    spk2_png = os.path.join(out_dir, "speaker2_spectrogram.png")
    generate_spectrogram_png(spk1_wav, spk1_png, title="Speaker 1 — Mel Spectrogram")
    generate_spectrogram_png(spk2_wav, spk2_png, title="Speaker 2 — Mel Spectrogram")

    # 11. Output Result
    dur_spk1 = round(len(audio_spk0) / sr, 2)
    dur_spk2 = round(len(audio_spk1) / sr, 2)

    result = {
        "success": True,
        "totalDuration": round(total_duration, 2),
        "segmentCount": len(window_map),
        "speaker1": {
            "wav": spk1_wav,
            "txt": spk1_txt,
            "spectrogram": spk1_png,
            "durationSec": dur_spk1,
            "transcript": transcript_s1,
        },
        "speaker2": {
            "wav": spk2_wav,
            "txt": spk2_txt,
            "spectrogram": spk2_png,
            "durationSec": dur_spk2,
            "transcript": transcript_s2,
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

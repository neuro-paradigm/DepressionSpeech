# Integrate Fusion Depression Models into AudioDataCollection Website

## Background

The website currently collects audio + live transcripts, extracts 16 text-based biomarkers in JavaScript ([mlService.js](file:///c:/Users/soumi/Downloads/Neuro/Repos/AudioDataCollection/backend/src/services/mlService.js)), and classifies speech using a hand-tuned logistic formula (no real ML model). We need to replace/augment this with your **3 trained models**:

| Model | File | What it does |
|-------|------|-------------|
| **SchNet** (audio CNN) | `fold_1_schnet.pth` (24 MB) | Mel-spectrogram → depression logit (audio modality) |
| **Linguistic v11** (text pipeline) | `depression_model_v11.pkl` (70 KB) | 107 rich features + Bio_ClinicalBERT embedding → SVD → LogReg → calibrated prob |
| **FusionMLP** | `fusion_model_v1.pkl` (7 KB) | `[schnet_prob, ling_prob, |diff|, product]` → 2-head MLP → PHQ-8 binary + severity |

## Decisions Confirmed

> [!IMPORTANT]
> **The model pipeline requires Python with PyTorch, torchaudio, transformers (Bio_ClinicalBERT), scikit-learn, and vaderSentiment.** The Node.js backend cannot run these directly. The plan adds a **Python inference microservice** (FastAPI) that the Express backend calls via HTTP.
>
> Confirmed deployment choices: run Bio_ClinicalBERT **locally**, use the available **CUDA GPU** when PyTorch detects it, use the fusion bundle's **Youden threshold** as the default decision threshold, and **augment** rather than replace the current report.

> [!WARNING]
> **Data format gap — the Linguistic v11 model was trained on DAIC-WOZ interview transcripts** with a `participant`/`interviewer` turn structure (speaker-labeled dialogue with timestamps). Your website collects monologue responses to 3-4 prompts without an interviewer. This means:
> - Timing features (latency, speaking rate) will be degraded (set to defaults)
> - Elaboration ratios (patient response length vs. interviewer question length) need synthetic interviewer turns built from the website's prompt text
> - The 107-feature vector will still be computed, but ~20 interview-interaction features will be approximated
>
> This is an inherent mismatch; the model will still produce predictions, but accuracy may differ from the validation set.

## Original Questions (Resolved) and Remaining Prerequisite

> [!IMPORTANT]
> 1. **Bio_ClinicalBERT download**: The linguistic model requires `emilyalsentzer/Bio_ClinicalBERT` (~440 MB). On first run, it auto-downloads from HuggingFace. Is that acceptable, or do you have the model cached locally / want to bundle it?
>
> 2. **GPU availability**: SchNet + BERT inference is significantly faster on GPU. Will the deployment machine have a CUDA GPU, or should we plan for CPU-only inference (slower but functional)?
>
> 3. **Which threshold to use**: The fusion bundle ships two thresholds — Youden (0.485, balanced) and Clinical (0.464, higher sensitivity). Which do you prefer as the default for the website?
>
> 4. **Report integration**: Should the new DL-based fusion results **replace** the existing JS-based biomarker report entirely, or **augment** it (show both the current lightweight text biomarkers + the new deep-learning fusion prediction)?

> **Resolved:** use a local Bio_ClinicalBERT snapshot, CUDA when available, the bundle's Youden threshold, and augmentation of the existing report.
>
> **Remaining prerequisite:** Bio_ClinicalBERT itself is not in this repository. Obtain the complete Hugging Face snapshot for `emilyalsentzer/Bio_ClinicalBERT` and place it at `backend/inference/models/bioclinical_bert/` (including tokenizer and model files). The service must load it with `local_files_only=True`, so production inference never downloads it or depends on internet access. Install a CUDA-compatible PyTorch/torchaudio build matched to the deployed NVIDIA driver; log the selected device at service startup and fall back to CPU only when CUDA is unavailable.

## Proposed Changes

### Python Inference Microservice (New)

#### [NEW] [inference_server.py](file:///c:/Users/soumi/Downloads/Neuro/Repos/AudioDataCollection/backend/inference/inference_server.py)
A FastAPI server that loads all 3 models at startup and exposes a single `/predict` endpoint.

**Startup loads:**
- SchNet architecture + `fold_1_schnet.pth` weights
- FusionMLP architecture + weights from `fusion_model_v1.pkl`  
- Linguistic v11 pipeline from `depression_model_v11.pkl` (LogReg, SVD, scalers, feature mask, Platt calibrator)
- Bio_ClinicalBERT tokenizer + encoder from `models/bioclinical_bert/` with `local_files_only=True`
- VADER sentiment analyzer
- Isotonic severity regressor

**`POST /predict` endpoint accepts:**
```json
{
  "audio_path": "/absolute/path/to/recording.wav",
  "transcript": "combined patient text from all prompts",
  "prompts": [
    {"prompt": "Tell us about your typical day...", "response": "I wake up around 7..."},
    {"prompt": "Describe a challenge...", "response": "Last year I had..."}
  ]
}
```

**Returns:**
```json
{
  "schnet_prob": 0.423,
  "ling_prob": 0.387,
  "fusion_prob": 0.401,
  "pred_binary": 0,
  "phq8_est": 4.2,
  "threshold_used": 0.485,
  "classification": "NON-DEPRESSED",
  "biomarkers_107": { ... }
}
```

**Key implementation details:**
- Replicates `extract_ling_features()` exactly (107-dim vector) from the notebook. For every saved prompt-response pair, construct ordered turns as `{speaker: "interviewer", text: prompt}` then `{speaker: "participant", text: normalized response}`; `patient_text` is the space-joined participant turns only. No prompt text may enter `patient_text` or the BERT text input.
- Set unavailable interview-only values deterministically: timestamps/latency and timing-derived interaction values use the notebook's neutral/default path; question/answer and turn-based text features are computed from the synthetic turns. Return `data_format_limitations` alongside the prediction so the UI can disclose this mismatch.
- Replicates `embed_full_text()` (chunked ClinicalBERT embedding with sliding window)
- Replicates `load_audio_segments()` + `get_schnet_logit()` for multi-segment audio inference. Merge the response WAVs into a temporary PCM WAV in question order before audio inference; never concatenate encoded WAV bytes directly.
- Replicates the fusion meta-feature construction exactly: convert the mean SchNet logit to a sigmoid probability, then build `[schnet_prob, ling_prob, abs(schnet_prob - ling_prob), schnet_prob * ling_prob]` before the FusionMLP forward pass.
- Use `thresh_youden` embedded in `fusion_model_v1.pkl` rather than hard-coding `0.485`; include the active threshold type and model/device versions in the response.

#### [NEW] [requirements.txt](file:///c:/Users/soumi/Downloads/Neuro/Repos/AudioDataCollection/backend/inference/requirements.txt)
```
fastapi
uvicorn
torch # CUDA wheel appropriate for the deployment machine
torchaudio # matching torch version
transformers
scikit-learn
pandas
numpy
vaderSentiment
```

---

### Node.js Backend Changes

#### [MODIFY] [submissionController.js](file:///c:/Users/soumi/Downloads/Neuro/Repos/AudioDataCollection/backend/src/controllers/submissionController.js)
- In `generateReport()`: after building the existing JS-based report, call the Python inference service with the combined audio WAV (extracted from the progressive Drive ZIP) + combined transcript text
- Merge the fusion model's results into the report object (fusion probability, PHQ-8 estimate, classification, per-modality scores)

#### [NEW] [fusionService.js](file:///c:/Users/soumi/Downloads/Neuro/Repos/AudioDataCollection/backend/src/services/fusionService.js)
- HTTP client that calls the Python inference microservice
- Handles: extracting audio from the Drive ZIP to a temp file, building the combined transcript, calling `/predict`, cleaning up temp files
- Graceful fallback: if the Python service is down, the report still generates using the existing JS biomarkers (just without fusion results)

#### [MODIFY] [Submission.js](file:///c:/Users/soumi/Downloads/Neuro/Repos/AudioDataCollection/backend/src/models/Submission.js)
- Extend `reportSchema` with new fusion-model fields:
  - `fusionPrediction` (Mixed): `{ schnet_prob, ling_prob, fusion_prob, pred_binary, phq8_est, threshold_used, classification }`
  - `fusionAvailable` (Boolean)
  - `fusionUnavailableReason` (String) and `fusionDataFormatLimitations` ([String])

#### [MODIFY] [server.js](file:///c:/Users/soumi/Downloads/Neuro/Repos/AudioDataCollection/backend/src/server.js)
- Add fusion inference service health to `/health` endpoint

---

### Model Files (Move)

#### [MOVE] Model files to `backend/inference/models/`
- `fold_1_schnet.pth` → `backend/inference/models/fold_1_schnet.pth`
- `depression_model_v11.pkl` → `backend/inference/models/depression_model_v11.pkl`
- `fusion_model_v1.pkl` → `backend/inference/models/fusion_model_v1.pkl`

---

### Frontend Changes

#### [MODIFY] [ReportCard.jsx](file:///c:/Users/soumi/Downloads/Neuro/Repos/AudioDataCollection/frontend/src/components/ReportCard.jsx)
- Add a new "Deep Learning Fusion Analysis" section showing:
  - PHQ-8 severity estimate with color-coded gauge
  - Per-modality probabilities (audio SchNet, text Linguistic)
  - Fusion probability + binary classification badge
  - Prominent research-only / data-format limitation note, including that this is not a clinical diagnosis or a replacement for professional assessment

## Verification Plan

### Automated Tests
- Service startup test with the local BERT snapshot present: verifies all models load, CUDA is selected when available, and no network download is attempted.
- Unit test that verifies synthetic turn construction keeps prompt and participant text separate, produces a 107-value rich-feature vector, and preserves question order.
- `python -c "from inference_server import app; print('FastAPI app loads successfully')"` — verifies all models load without crash
- `curl http://localhost:8001/health` — verifies inference service is running
- End-to-end: submit a test WAV + transcript via the Node.js API and verify the report includes fusion results

### Manual Verification
- Record a 30-second audio clip through the website UI
- Generate a report and verify the ReportCard shows both the existing biomarkers and the new fusion prediction
- Verify the Python service handles missing audio gracefully (falls back to text-only)
- Verify the UI exposes a clear unavailable state when the local BERT files or inference service are missing, while the existing report remains available.

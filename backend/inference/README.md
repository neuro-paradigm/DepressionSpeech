# Local fusion inference service

Run this service on the same machine as the Node backend. It uses `models/clinical_bert_local/` by default.

1. Create a Python environment with a CUDA-compatible PyTorch and torchaudio build for the machine's NVIDIA driver.
2. Install the remaining dependencies with `pip install -r requirements.txt`.
3. Copy or move the three supplied model files to `models/` (the service temporarily supports their current repository-root locations):
   - `fold_1_schnet.pth`
   - `depression_model_v11.pkl`
   - `fusion_model_v1.pkl`
4. Confirm `models/clinical_bert_local/` contains `model.safetensors`, `config.json`, `tokenizer.json`, and `vocab.txt`. To use a different local snapshot, set `BERT_MODEL_DIR` to its absolute path.
5. Start the service with `uvicorn inference_server:app --host 127.0.0.1 --port 8001` from this directory.

The backend reads `FUSION_SERVICE_URL` and `FUSION_SERVICE_TIMEOUT_MS` from its environment. It calls the service only while generating a report; failure is recorded in the report and does not prevent the existing report from being generated.

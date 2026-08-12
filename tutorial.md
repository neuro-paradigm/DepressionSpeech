# Running AudioDataCollection locally (Windows + CUDA)

This guide starts all four local pieces: MongoDB, the Python fusion-inference service, the Node backend, and the React frontend. Open a separate PowerShell window for each service and keep it open while using the website.

## 1. Prerequisites

Install these first:

- Node.js 20 or newer.
- Python 3.10 through 3.14 (Python 3.12 is a good default).
- MongoDB Community Server, with `mongod` available in PowerShell.
- NVIDIA driver and a CUDA-capable GPU.

Confirm the commands work:

```powershell
node --version
py -3.12 --version
nvidia-smi
mongod --version
```

If `py` is not recognized, install Python from python.org and enable **Add Python to PATH** during installation.

## 2. Prepare the model files

From the repository root (`AudioDataCollection`), copy the three trained model files to the inference model directory:

```powershell
New-Item -ItemType Directory -Force -Path .\backend\inference\models
Copy-Item .\fold_1_schnet.pth .\backend\inference\models\
Copy-Item .\depression_model_v11.pkl .\backend\inference\models\
Copy-Item .\fusion_model_v1.pkl .\backend\inference\models\
```

The local BioClinicalBERT snapshot is already expected at `backend\inference\models\clinical_bert_local\`. Confirm its files are present:

```powershell
Get-ChildItem .\backend\inference\models\clinical_bert_local
```

You must see `model.safetensors`, `config.json`, `tokenizer.json`, and `vocab.txt`. The service uses this folder locally and does not download BERT at startup.

## 3. Create the Python inference environment

Run these commands from the repository root:

```powershell
Set-Location .\backend\inference
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
```

If PowerShell blocks activation, run this for the current window only, then activate again:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

Install the CUDA-enabled PyTorch build first. The following is the current CUDA 12.8 wheel command; use CUDA 12.6 or CUDA 11.8 from the [official PyTorch selector](https://pytorch.org/get-started/locally/) if that better matches your NVIDIA driver.

```powershell
python -m pip install --upgrade pip
python -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu128
python -m pip install -r requirements.txt
```

Check CUDA before starting the service:

```powershell
python -c "import torch; print('CUDA available:', torch.cuda.is_available()); print('GPU:', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU fallback')"
```

Start the inference service:

```powershell
python -m uvicorn inference_server:app --host 127.0.0.1 --port 8001
```

In another PowerShell window, verify it:

```powershell
Invoke-RestMethod http://127.0.0.1:8001/health
```

Expected result includes `"status": "ok"` and `"device": "cuda"`.

## 4. Start MongoDB

In a new PowerShell window, from the repository root:

```powershell
New-Item -ItemType Directory -Force -Path .\data\mongodb
mongod --dbpath .\data\mongodb
```

Leave this window open. If MongoDB is installed as a Windows service, start that service instead and skip this step.

## 5. Configure and start the backend

In a new PowerShell window:

```powershell
Set-Location C:\Users\soumi\Downloads\Neuro\Repos\AudioDataCollection\backend
Copy-Item .env.example .env
npm.cmd ci
npm.cmd run dev
```

Edit `backend\.env` before using Google Drive features. At minimum, keep these local values:

```dotenv
PORT=5000
MONGO_URI=mongodb://127.0.0.1:27017/speech_analysis
FRONTEND_URL=http://localhost:5173
FUSION_SERVICE_URL=http://127.0.0.1:8001
FUSION_SERVICE_TIMEOUT_MS=120000
```

Check the backend and its connection to the inference service:

```powershell
Invoke-RestMethod http://127.0.0.1:5000/health
```

The response should include `fusion.available: true`.

## 6. Start the frontend

In a final PowerShell window:

```powershell
Set-Location C:\Users\soumi\Downloads\Neuro\Repos\AudioDataCollection\frontend
npm.cmd ci
npm.cmd run dev
```

Open the URL Vite prints, normally `http://localhost:5173`.

## 7. Use and verify fusion inference

1. Record and save the required WAV responses in the website.
2. Generate the report.
3. The report should keep the existing biomarker sections and add **Deep Learning Fusion Analysis** with audio, linguistic, fusion, and PHQ-8 estimates.
4. If the Python service is unavailable, the existing report still saves; the fusion panel shows the reason instead.

## Troubleshooting

- **`CUDA available: False`**: install the wheel matching your NVIDIA driver from the official PyTorch selector, then restart the inference service.
- **`Fusion analysis unavailable`**: ensure the Python service is running on port 8001 and `Invoke-RestMethod http://127.0.0.1:8001/health` succeeds.
- **BERT load error**: ensure `backend\inference\models\clinical_bert_local\model.safetensors` is present and has a normal model-file size (hundreds of MB), not an LFS pointer.
- **`vite` not recognized**: run `npm.cmd ci` inside `frontend` first.
- **MongoDB connection error**: start `mongod` or update `MONGO_URI` in `backend\.env`.

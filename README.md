# 🧠 Speech Analysis Platform

A full-stack clinical research application for collecting, archiving, and analyzing patient speech recordings. The platform captures high-fidelity audio through structured verbal prompts, extracts 16 linguistic and syntactic biomarkers, and produces ML-assisted classification reports to support speech pattern analysis research.

> **⚠️ Research Prototype** — This software is for investigational use only. It is **not** validated for clinical diagnosis or treatment decisions. All classifications and biomarker flags must be interpreted by a licensed professional alongside standard clinical diagnostics.

---

## ✨ Features

- **Structured Audio Collection** — Three-prompt verbal stepper (Introduction, Memory Recall, Executive Planning) with real-time live transcription via the Web Speech API.
- **In-Browser WAV Conversion** — Raw browser audio is converted to 16-bit PCM WAV (mono) on the client before upload.
- **ML Biomarker Extraction** — Server-side NLP pipeline extracts 16 acoustic/syntactic biomarkers including Type-Token Ratio, Disfluency Ratio, Syntactic Depth, Semantic Coherence, and more.
- **Classification Reports** — Automatic classification as *Typical*, *Atypical*, or *Uncertain* based on a probability threshold with configurable uncertainty margin.
- **Doctor Voice Enrollment** — Speaker diarization pipeline with doctor voice enrollment for separating doctor/patient audio segments.
- **Google Drive Archiving** — Audio recordings and transcripts are packaged into ZIP archives and uploaded to Google Drive for long-term storage.
- **Authentication** — Local email/password registration and Google OAuth 2.0 single sign-on.
- **Admin Dashboard** — Centralized view of all patient submissions with per-row report generation, viewing, and data export controls.
- **PDF Workflow Guide** — Auto-generated doctor's operational guide as a formatted PDF (via ReportLab).

---

## 🏗️ Architecture

```
┌──────────────────────────────────┐
│          Frontend (React)        │
│  Vite · React Router · Tailwind │
│  Lucide Icons · Axios           │
│  Web Speech API (live transcri- │
│  ption) · MediaRecorder (audio) │
└────────────┬─────────────────────┘
             │  REST API
             ▼
┌──────────────────────────────────┐
│        Backend (Express.js)      │
│  Multer (file uploads)           │
│  JWT Auth · Google OAuth 2.0     │
│  NLP / ML Biomarker Engine       │
│  Spectrogram Generation          │
│  Speaker Diarization (Python)    │
│  Google Drive Service            │
│  ZIP Archival Service            │
└────────────┬─────────────────────┘
             │
             ▼
┌──────────────────────────────────┐
│         MongoDB (Mongoose)       │
│  Users · Submissions · Reports   │
└──────────────────────────────────┘
```

---

## 🛠️ Tech Stack

| Layer       | Technology                                                                 |
|-------------|---------------------------------------------------------------------------|
| **Frontend** | React 19, Vite 8, React Router 7, Tailwind CSS 4, Lucide React, Axios   |
| **Backend**  | Node.js, Express 5, Mongoose 9, Multer 2, JWT, Google APIs              |
| **Database** | MongoDB                                                                  |
| **ML/NLP**   | Custom biomarker extraction engine (JavaScript), Python scripts for diarization |
| **Storage**  | Google Drive API (archival), local filesystem (uploads)                   |
| **Tooling**  | ReportLab (PDF generation), ESLint                                       |

---

## 🚀 Getting Started

### Prerequisites

- **Node.js** ≥ 18
- **MongoDB** — running locally or a cloud instance (e.g. MongoDB Atlas)
- **Python 3** — required only for diarization and PDF guide generation
- **Google Cloud** credentials (optional) — for Drive archival and OAuth

### 1. Clone the Repository

```bash
git clone https://github.com/Sai-Shivani-7/AudioDataCollection.git
cd AudioDataCollection
```

### 2. Backend Setup

```bash
cd backend
npm install
cp .env.example .env
# Edit .env with your configuration (see Environment Variables below)
```

### 3. Frontend Setup

```bash
cd frontend
npm install
cp .env.example .env
# Edit .env with your configuration (see Environment Variables below)
```

### 4. Start Development Servers

**Backend** (from the `backend/` directory):
```bash
npm run dev
# Starts on http://localhost:5000
```

**Frontend** (from the `frontend/` directory):
```bash
npm run dev
# Starts on http://localhost:5173
```

### 5. Generate Doctor Workflow Guide (Optional)

```bash
pip install reportlab
python generate_guide.py
# Outputs: Doctor_Speech_Analysis_Workflow_Guide.pdf
```

---

## ⚙️ Environment Variables

### Backend (`backend/.env`)

| Variable                             | Description                                       | Default / Example                                        |
|--------------------------------------|---------------------------------------------------|----------------------------------------------------------|
| `PORT`                               | Server listening port                             | `5000`                                                   |
| `MONGO_URI`                          | MongoDB connection string                         | `mongodb://127.0.0.1:27017/speech_analysis`              |
| `FRONTEND_URL`                       | Allowed CORS origin                               | `http://localhost:5173`                                   |
| `JWT_SECRET`                         | Secret key for signing JWT tokens                 | *(generate a long random string)*                        |
| `GOOGLE_CLIENT_ID`                   | Google OAuth client ID                            | `*.apps.googleusercontent.com`                           |
| `GOOGLE_DRIVE_FOLDER_ID`            | Target Google Drive folder for uploads            | *(your folder ID)*                                       |
| `GOOGLE_DRIVE_ACCESS_TOKEN`          | Google Drive API access token                     |                                                          |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL`       | Service account email for Drive API               |                                                          |
| `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` | Service account private key                       |                                                          |
| `GOOGLE_OAUTH_CLIENT_ID`            | OAuth client ID for Drive authorization flow      |                                                          |
| `GOOGLE_OAUTH_CLIENT_SECRET`        | OAuth client secret                               |                                                          |
| `GOOGLE_OAUTH_REDIRECT_URI`         | OAuth 2.0 callback URL                            | `http://localhost:5000/api/google-drive/oauth2callback`  |

### Frontend (`frontend/.env`)

| Variable                | Description                              | Default / Example                           |
|-------------------------|------------------------------------------|---------------------------------------------|
| `VITE_API_URL`          | Backend API base URL                     | `http://localhost:5000/api`                 |
| `VITE_GOOGLE_CLIENT_ID` | Google OAuth client ID (for SSO button) | `*.apps.googleusercontent.com`              |
| `VITE_DOCTOR_ACCESS_CODE` | Access code required before viewing/generating reports | `123456`                     |

> Note: the frontend access code is a convenience gate only (frontend code is public by nature). All privileged API routes remain protected by JWT auth on the backend.

---

## 📁 Project Structure

```
AudioDataCollection/
├── backend/
│   ├── .env.example            # Environment variable template
│   ├── package.json
│   └── src/
│       ├── server.js           # Express app entry point
│       ├── config/
│       │   └── db.js           # MongoDB connection setup
│       ├── controllers/
│       │   ├── authController.js       # Login, signup, Google OAuth
│       │   └── submissionController.js # CRUD + report generation
│       ├── middleware/
│       │   ├── auth.js         # JWT verification middleware
│       │   └── upload.js       # Multer file upload config
│       ├── models/
│       │   ├── Submission.js   # Patient submission schema
│       │   └── User.js         # User/doctor account schema
│       ├── routes/
│       │   ├── authRoutes.js
│       │   └── submissionRoutes.js
│       ├── scripts/
│       │   ├── diarize.py      # Speaker diarization pipeline
│       │   └── enroll.py       # Doctor voice enrollment
│       ├── services/
│       │   ├── diarizationService.js   # Node ↔ Python bridge for diarization
│       │   ├── enrollmentService.js    # Voice profile management
│       │   ├── googleDriveService.js   # Drive upload & OAuth flow
│       │   ├── mlService.js            # NLP biomarker extraction engine
│       │   ├── spectrogramService.js   # Spectrogram image generation
│       │   └── zipService.js           # ZIP archive creation
│       └── utils/
│           └── auth.js         # JWT & password hashing helpers
│
├── frontend/
│   ├── .env.example            # Environment variable template
│   ├── index.html              # Vite HTML entry
│   ├── vite.config.js
│   ├── package.json
│   └── src/
│       ├── App.jsx             # Root component with routing
│       ├── main.jsx            # React DOM entry point
│       ├── index.css           # Global styles
│       ├── styles.css          # Application theme & component styles
│       ├── api/                # Axios API client wrappers
│       ├── assets/             # Static assets
│       ├── components/
│       │   └── ReportCard.jsx  # Biomarker report visualization
│       ├── data/               # Static data / constants
│       └── pages/
│           ├── AdminDashboard.jsx    # Submission management dashboard
│           ├── AuthPage.jsx          # Login / signup view
│           ├── DoctorEnrollment.jsx  # Voice enrollment interface
│           ├── ReportView.jsx        # Report detail page
│           └── UserDashboard.jsx     # Patient recording interface
│
├── generate_guide.py           # PDF workflow guide generator (ReportLab)
├── update_report_figure.py     # Report figure update utility
└── .gitignore
```

---

## 🔌 API Endpoints

### Authentication

| Method | Endpoint               | Description                      |
|--------|------------------------|----------------------------------|
| POST   | `/api/auth/signup`     | Register a new doctor account    |
| POST   | `/api/auth/login`      | Authenticate with email/password |
| POST   | `/api/auth/google`     | Authenticate via Google OAuth    |

### Submissions

| Method | Endpoint                              | Description                                      |
|--------|---------------------------------------|--------------------------------------------------|
| POST   | `/api/submissions`                    | Create a new patient submission                  |
| GET    | `/api/submissions`                    | List all submissions                             |
| GET    | `/api/submissions/:id`                | Get a single submission by ID                    |
| PUT    | `/api/submissions/:id/response`       | Upload an audio response for a specific question |
| POST   | `/api/submissions/:id/generate-report`| Generate ML classification report                |

### Health Check

| Method | Endpoint   | Description                                    |
|--------|------------|------------------------------------------------|
| GET    | `/health`  | Service status & Google Drive config validation |

---

## 🧪 Clinical Workflow

The platform follows a five-phase clinical workflow:

1. **Authentication** — Doctor signs up or logs in via email/password or Google SSO.
2. **Patient Registration** — Enter patient name and contact/ID; system generates a unique session.
3. **Audio Recording** — Three structured speech prompts with real-time transcription, re-record capability, and automatic WAV conversion + Google Drive archival.
4. **Report Generation** — Trigger ML analysis to extract 16 biomarkers and classify speech patterns (requires doctor access code).
5. **Clinical Review** — View the report card with classification result, biomarker table with flagged values, linguistic/syntactic findings, and clinical interpretation.

### Biomarkers Extracted

| Category              | Metrics                                                                 |
|-----------------------|-------------------------------------------------------------------------|
| Lexical Diversity     | Type-Token Ratio, Word Entropy, Bigram Diversity                        |
| Speech Flow           | Repetition Rate, Disfluency Ratio                                       |
| Syntactic Structure   | Mean Sentence Length, Syntactic Depth, Sentence Fragmentation, Clause Ratio |
| Semantic Coherence    | Semantic Coherence, Length Drift, Sentence Length Std. Dev.              |
| Content Analysis      | Negative Word Ratio, First-Person Ratio, Pronoun Ratio, Verb Ratio     |

---

## 📄 License

ISC

---

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/your-feature`)
3. Commit your changes (`git commit -m 'Add your feature'`)
4. Push to the branch (`git push origin feature/your-feature`)
5. Open a Pull Request

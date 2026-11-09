const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const express = require('express');
const cors = require('cors');
const connectDatabase = require('./config/db');
const submissionRoutes = require('./routes/submissionRoutes');
const authRoutes = require('./routes/authRoutes');
const { getFusionHealth } = require('./services/fusionService');

const app = express();
const port = process.env.PORT || 5000;

app.use(
  cors({
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  })
);
app.use(express.json({ limit: '10mb' }));
app.use('/api/auth', authRoutes);
app.use('/api', submissionRoutes);

app.get('/health', async (req, res) => {
  res.json({
    status: 'ok',
    service: 'Speech Analysis API',
    googleConfigured: Boolean(
      process.env.GOOGLE_DRIVE_ACCESS_TOKEN ||
      process.env.GOOGLE_DRIVE_REFRESH_TOKEN ||
      (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY)
    ),
    googleOAuthConfigured: Boolean(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET),
    googleOAuthAuthorized: Boolean(process.env.GOOGLE_DRIVE_REFRESH_TOKEN),
    fusion: await getFusionHealth(),
  });
});

app.use((error, req, res, next) => {
  console.error(error);

  // Multer upload errors carry a code but no HTTP status — map them so the
  // client sees 413/400 instead of a generic 500.
  if (error?.name === 'MulterError') {
    const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return res.status(status).json({ message: error.message || 'File upload failed.' });
  }

  if (error?.name === 'CastError') {
    return res.status(400).json({ message: 'Malformed identifier in request.' });
  }

  if (error?.type === 'entity.too.large') {
    return res.status(413).json({ message: 'Request body is too large.' });
  }

  res.status(error.status || 500).json({ message: error.message || 'Server error.' });
});

connectDatabase().then(() => {
  app.listen(port, () => {
    console.log(`Backend running on http://localhost:${port}`);
  });
});

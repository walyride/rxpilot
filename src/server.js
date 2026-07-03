// RxPilot - AI Prescription Autopilot Agent
// Server with prescription analysis endpoint (Phase 2)

require('dotenv').config();
const express = require('express');
const { readPrescription } = require('./vision');

const app = express();
app.use(express.json({ limit: '15mb' }));

const PORT = process.env.PORT || 3000;

// Health check - confirms the server is alive
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'RxPilot',
    version: '0.2.0',
    time: new Date().toISOString()
  });
});

// Phase 2: analyze a prescription image
// Body: { "imageBase64": "...", "mimeType": "image/jpeg" }
app.post('/api/prescriptions/analyze', async (req, res) => {
  try {
    const { imageBase64, mimeType } = req.body;

    if (!imageBase64) {
      return res.status(400).json({ error: 'imageBase64 is required' });
    }

    const result = await readPrescription(imageBase64, mimeType || 'image/jpeg');

    res.json({
      status: 'extracted',
      data: result.extraction,
      tokensUsed: result.tokensUsed
    });
  } catch (err) {
    console.error('Analyze error:', err.message);
    res.status(500).json({ error: 'analysis_failed', details: err.message });
  }
});

app.listen(PORT, () => {
  console.log('==========================================');
  console.log('  RxPilot server is running');
  console.log('  http://localhost:' + PORT + '/health');
  console.log('==========================================');
});
// RxPilot - Phase 2 test: read a prescription image with Qwen-VL
// Usage: node test/test-vision.js path/to/prescription.jpg

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { readPrescription } = require('../src/vision');

async function main() {
  const imagePath = process.argv[2];

  if (!imagePath) {
    console.error('Usage: node test/test-vision.js <path-to-image>');
    console.error('Example: node test/test-vision.js samples/rx1.jpg');
    process.exit(1);
  }

  if (!fs.existsSync(imagePath)) {
    console.error('File not found: ' + imagePath);
    process.exit(1);
  }

  const ext = path.extname(imagePath).toLowerCase();
  const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';
  const imageBase64 = fs.readFileSync(imagePath).toString('base64');

  console.log('Sending prescription image to Qwen-VL...');
  console.log('File: ' + imagePath + ' (' + Math.round(imageBase64.length / 1024) + ' KB base64)');
  console.log('');

  const start = Date.now();

  try {
    const result = await readPrescription(imageBase64, mimeType);
    const seconds = ((Date.now() - start) / 1000).toFixed(1);

    console.log('SUCCESS in ' + seconds + 's! Extracted prescription:');
    console.log('==========================================');
    console.log(JSON.stringify(result.extraction, null, 2));
    console.log('==========================================');
    console.log('Tokens used: ' + result.tokensUsed);

    // Quick human-in-the-loop preview
    const meds = result.extraction.medications || [];
    const lowConfidence = meds.filter(m => (m.confidence || 0) < 0.8);
    console.log('');
    console.log('Medications found: ' + meds.length);
    if (lowConfidence.length > 0) {
      console.log('NEEDS PHARMACIST REVIEW (confidence < 0.8): ' +
        lowConfidence.map(m => m.drug_name).join(', '));
    } else if (meds.length > 0) {
      console.log('All readings above confidence threshold.');
    }
  } catch (err) {
    console.error('FAILED: ' + err.message);
    console.error('');
    console.error('Common fixes:');
    console.error('- If model not found, change QWEN_VISION_MODEL in .env (e.g. qwen-vl-max or qwen3-vl-plus)');
    console.error('- Make sure the image is a clear photo under ~10 MB');
  }
}

main();
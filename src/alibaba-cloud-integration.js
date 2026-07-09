// ============================================================
// RxPilot — Alibaba Cloud Integration
// ============================================================
// PROOF OF ALIBABA CLOUD DEPLOYMENT / INTEGRATION
//
// RxPilot's backend runs its entire AI layer on Alibaba Cloud.
// Every prescription processed by the system makes live inference
// calls to Alibaba Cloud Model Studio (DashScope) — Alibaba Cloud's
// managed large-model platform that serves the Qwen model family.
//
// This file documents exactly how the backend integrates with
// Alibaba Cloud services and APIs. The same client defined here is
// used across the whole pipeline (see vision.js, normalize.js,
// pipeline.js, counseling.js).
// ============================================================

require('dotenv').config();
const OpenAI = require('openai');

// ------------------------------------------------------------
// 1) ALIBABA CLOUD MODEL STUDIO (DashScope) — the AI backend
// ------------------------------------------------------------
// Model Studio exposes an OpenAI-compatible endpoint. RxPilot
// connects to the international (Singapore) region endpoint using
// an API key issued from the Alibaba Cloud Model Studio console.
//
//   Console:  https://modelstudio.console.alibabacloud.com
//   Region:   ap-southeast-1 (Singapore)
//   Endpoint: https://dashscope-intl.aliyuncs.com/compatible-mode/v1
//
// The API key is provided via the QWEN_API_KEY environment variable
// and is never committed to source control.

const ALIBABA_MODEL_STUDIO_ENDPOINT =
  process.env.QWEN_BASE_URL ||
  'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';

const alibabaCloudModelStudio = new OpenAI({
  apiKey: process.env.QWEN_API_KEY,        // issued by Alibaba Cloud Model Studio
  baseURL: ALIBABA_MODEL_STUDIO_ENDPOINT   // Alibaba Cloud DashScope endpoint
});

// ------------------------------------------------------------
// 2) ALIBABA CLOUD QWEN MODELS used by RxPilot
// ------------------------------------------------------------
// These models are served by Alibaba Cloud Model Studio and are
// called on every prescription the system processes.
const ALIBABA_CLOUD_MODELS = {
  // Vision model — reads handwritten prescriptions (images -> structured JSON)
  vision: process.env.QWEN_VISION_MODEL || 'qwen-vl-plus',
  // Text model — clinical reasoning, brand-name fallback, bilingual counseling
  text: process.env.QWEN_TEXT_MODEL || 'qwen-plus'
};

// ------------------------------------------------------------
// 3) HEALTH CHECK — proves the backend can reach Alibaba Cloud
// ------------------------------------------------------------
// A lightweight call that confirms live connectivity to Alibaba
// Cloud Model Studio. Used to demonstrate that the deployed backend
// is genuinely integrated with Alibaba Cloud services.
async function verifyAlibabaCloudConnection() {
  const response = await alibabaCloudModelStudio.chat.completions.create({
    model: ALIBABA_CLOUD_MODELS.text,
    messages: [
      { role: 'system', content: 'You are RxPilot, running on Alibaba Cloud Model Studio.' },
      { role: 'user', content: 'Confirm the backend is connected to Alibaba Cloud.' }
    ]
  });

  return {
    provider: 'Alibaba Cloud Model Studio (DashScope)',
    endpoint: ALIBABA_MODEL_STUDIO_ENDPOINT,
    region: 'ap-southeast-1 (Singapore)',
    modelsInUse: ALIBABA_CLOUD_MODELS,
    reply: response.choices[0].message.content,
    tokensUsed: response.usage ? response.usage.total_tokens : null,
    status: 'connected'
  };
}

// ------------------------------------------------------------
// Where Alibaba Cloud is used across the RxPilot pipeline:
//   • vision.js      -> qwen-vl-plus   (read handwritten prescriptions)
//   • normalize.js   -> qwen-plus      (resolve local/regional brand names)
//   • pipeline.js    -> qwen-plus      (AI clinical review of the medications)
//   • counseling.js  -> qwen-plus      (bilingual patient counseling sheets)
// Every one of these features is an Alibaba Cloud Model Studio API call.
// ------------------------------------------------------------

module.exports = {
  alibabaCloudModelStudio,
  ALIBABA_CLOUD_MODELS,
  ALIBABA_MODEL_STUDIO_ENDPOINT,
  verifyAlibabaCloudConnection
};

// Run directly (node src/alibaba-cloud-integration.js) to print a
// live proof-of-connection to Alibaba Cloud Model Studio.
if (require.main === module) {
  verifyAlibabaCloudConnection()
    .then(r => {
      console.log('==================================================');
      console.log('  RxPilot — Alibaba Cloud connection verified');
      console.log('==================================================');
      console.log(JSON.stringify(r, null, 2));
    })
    .catch(e => {
      console.error('Alibaba Cloud connection failed:', e.message);
      process.exit(1);
    });
}
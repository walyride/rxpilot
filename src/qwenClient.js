// RxPilot - Shared Qwen Cloud client
// One place to configure the connection for all modules

require('dotenv').config();
const OpenAI = require('openai');

const client = new OpenAI({
  apiKey: process.env.QWEN_API_KEY,
  baseURL: process.env.QWEN_BASE_URL || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'
});

const TEXT_MODEL = process.env.QWEN_TEXT_MODEL || 'qwen-plus';
const VISION_MODEL = process.env.QWEN_VISION_MODEL || 'qwen-vl-plus';

module.exports = { client, TEXT_MODEL, VISION_MODEL };
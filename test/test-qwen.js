// RxPilot - Phase 1 test: verify Qwen API key and connection
// Run with: npm run test:qwen

require('dotenv').config();
const OpenAI = require('openai');

const client = new OpenAI({
  apiKey: process.env.QWEN_API_KEY,
  baseURL: process.env.QWEN_BASE_URL || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'
});

async function main() {
  console.log('Testing connection to Qwen Cloud...');
  console.log('Model: ' + (process.env.QWEN_TEXT_MODEL || 'qwen-plus'));
  console.log('');

  if (!process.env.QWEN_API_KEY || process.env.QWEN_API_KEY === 'your_api_key_here') {
    console.error('ERROR: QWEN_API_KEY is missing.');
    console.error('Copy .env.example to .env and paste your real API key.');
    process.exit(1);
  }

  try {
    const response = await client.chat.completions.create({
      model: process.env.QWEN_TEXT_MODEL || 'qwen-plus',
      messages: [
        {
          role: 'system',
          content: 'You are RxPilot, an AI pharmacy assistant. Reply in one short sentence.'
        },
        {
          role: 'user',
          content: 'Say hello and confirm you are ready to help with prescriptions.'
        }
      ]
    });

    console.log('SUCCESS! Qwen replied:');
    console.log('------------------------------------------');
    console.log(response.choices[0].message.content);
    console.log('------------------------------------------');
    console.log('Tokens used: ' + response.usage.total_tokens);
    console.log('');
    console.log('Your API key works. RxPilot foundation is ready.');
  } catch (err) {
    console.error('FAILED to reach Qwen:');
    console.error(err.status ? 'HTTP ' + err.status + ': ' + err.message : err.message);
    console.error('');
    console.error('Common fixes:');
    console.error('- Check the API key in .env (no spaces, no quotes)');
    console.error('- If model not found, try changing QWEN_TEXT_MODEL in .env');
  }
}

main();
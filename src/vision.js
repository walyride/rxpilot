// RxPilot - Vision module (Phase 2)
// Reads a prescription image with Qwen-VL and returns structured JSON
// with a confidence score per field (critical for the human-in-the-loop gate)

const { client, VISION_MODEL } = require('./qwenClient');

const EXTRACTION_PROMPT = `You are the vision engine of RxPilot, an AI pharmacy autopilot agent.
You will receive a photo of a medical prescription. It may be handwritten (Arabic or English), messy, or partially unclear.

Extract the prescription into STRICT JSON with this exact schema:

{
  "patient": {
    "name": string or null,
    "age": string or null,
    "other_info": string or null
  },
  "prescriber": {
    "name": string or null,
    "clinic": string or null
  },
  "date": string or null,
  "medications": [
    {
      "raw_text": string,            // exactly what is written on the paper
      "drug_name": string,            // your best reading of the drug name
      "strength": string or null,     // e.g. "500 mg"
      "dose": string or null,         // e.g. "1 tablet"
      "frequency": string or null,    // e.g. "twice daily"
      "duration": string or null,     // e.g. "7 days"
      "route": string or null,        // e.g. "oral"
      "confidence": number            // 0.0 to 1.0 - how sure you are of drug_name reading
    }
  ],
  "overall_legibility": number,       // 0.0 to 1.0
  "warnings": [string]                // anything suspicious: unclear words, unusual doses, missing info
}

CRITICAL RULES:
- Respond with ONLY the JSON object. No markdown, no backticks, no explanations.
- Never invent a drug name you cannot read. If unsure, give your best guess and LOWER the confidence.
- Confidence below 0.8 means a pharmacist must verify that item.
- If the image is not a prescription, return: {"error": "not_a_prescription"}`;

/**
 * Analyze a prescription image.
 * @param {string} imageBase64 - base64 image data (no data: prefix needed)
 * @param {string} mimeType - e.g. "image/jpeg"
 * @returns {Promise<object>} structured prescription data
 */
async function readPrescription(imageBase64, mimeType = 'image/jpeg') {
  const dataUrl = 'data:' + mimeType + ';base64,' + imageBase64;

  const response = await client.chat.completions.create({
    model: VISION_MODEL,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: dataUrl } },
          { type: 'text', text: EXTRACTION_PROMPT }
        ]
      }
    ]
  });

  const rawText = response.choices[0].message.content;

  // Strip markdown fences if the model added them despite instructions
  const cleaned = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error('Vision model returned non-JSON output: ' + rawText.slice(0, 300));
  }

  return {
    extraction: parsed,
    tokensUsed: response.usage ? response.usage.total_tokens : null
  };
}

module.exports = { readPrescription };
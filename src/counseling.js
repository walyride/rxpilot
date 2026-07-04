// RxPilot - Dispensing Outputs (v2: bilingual counseling)
// ============================================================
// After the pharmacist APPROVES a case, this module generates:
//   1. A dispensing label per medication (deterministic, printable)
//   2. A patient counseling sheet in the language the pharmacist
//      selects for THIS patient: Modern Standard Arabic or English.
//      Simple language any patient can understand: how to take
//      the medication, with/without food, key side effects, and
//      red flags that require contacting the pharmacist.
//
// Safety design: the generator receives the FULL safety context
// (interactions found, pharmacist note) so the counseling sheet
// reflects the actual clinical decisions - e.g. if diclofenac was
// replaced with paracetamol, the sheet covers paracetamol.
// ============================================================

const { client, TEXT_MODEL } = require('./qwenClient');

// Language-specific writing instructions.
// Both share the SAME fixed structure so the UI renders them identically.
const LANGUAGE_SPECS = {
  ar: {
    name: 'MODERN STANDARD ARABIC (العربية الفصحى)',
    rules: 'Write in Modern Standard Arabic only - no dialect, no English sentences (drug names may stay in Latin letters).',
    headings: {
      how: '## إرشادات تناول الأدوية',
      warnings: '## تنبيهات مهمة',
      redflags: '## متى تتصل بالصيدلي أو الطبيب فورًا'
    }
  },
  en: {
    name: 'ENGLISH',
    rules: 'Write in clear, simple English only.',
    headings: {
      how: '## How to take your medications',
      warnings: '## Important warnings',
      redflags: '## When to contact your pharmacist or doctor immediately'
    }
  }
};

/**
 * Generate dispensing outputs for an approved case.
 * @param {object} input
 * @param {object[]} input.medications - final medications to dispense:
 *        [{ drug_name, generic, strength, dose, frequency, duration, route }]
 * @param {object} [input.patient] - { name, age }
 * @param {object[]} [input.interactions] - interactions that were found (for counseling context)
 * @param {string} [input.pharmacistNote] - e.g. "diclofenac replaced with paracetamol"
 * @param {string} [input.language] - counseling sheet language: 'ar' (default) or 'en'
 * @returns {Promise<object>} { labels: [...], counselingSheet: string, counselingLanguage: 'ar'|'en' }
 */
async function generateDispensingOutputs(input) {
  const meds = input.medications || [];
  if (meds.length === 0) {
    return { labels: [], counselingSheet: '', counselingLanguage: input.language || 'ar' };
  }

  const language = LANGUAGE_SPECS[input.language] ? input.language : 'ar';
  const spec = LANGUAGE_SPECS[language];

  // ---------- 1. Dispensing labels (deterministic - no AI needed) ----------
  const labels = meds.map(m => ({
    drug: m.drug_name + (m.strength ? ' ' + m.strength : ''),
    generic: m.generic || null,
    directions: [m.dose, m.frequency, m.duration]
      .filter(Boolean).join(' - ') || 'As directed by the prescriber',
    route: m.route || 'oral',
    patient: (input.patient && input.patient.name) || null,
    dispensedAt: new Date().toISOString().slice(0, 10)
  }));

  // ---------- 2. Patient counseling sheet (Qwen, selected language) ----------
  const context = {
    patient_age: (input.patient && input.patient.age) || null,
    medications: meds.map(m => ({
      name: m.drug_name,
      generic: m.generic,
      strength: m.strength,
      dose: m.dose,
      frequency: m.frequency,
      duration: m.duration
    })),
    interactions_found: (input.interactions || []).map(i => ({
      drugs: i.drug1 + ' + ' + i.drug2,
      action_taken: i.action
    })),
    pharmacist_note: input.pharmacistNote || null
  };

  const response = await client.chat.completions.create({
    model: TEXT_MODEL,
    messages: [
      {
        role: 'system',
        content:
          'You are the patient-counseling writer of RxPilot, working under a licensed pharmacist. ' +
          'Write a patient counseling sheet in ' + spec.name + '. ' +
          spec.rules + ' ' +
          'Audience: an ordinary patient with no medical background. Use short, clear sentences. ' +
          'Structure the sheet EXACTLY as follows, using these exact headings:\n' +
          spec.headings.how + '\n' +
          'For each medication: one short block - how to take it (with/without food, time of day), and for how long.\n' +
          spec.headings.warnings + '\n' +
          'Key precautions specific to THESE medications (e.g. avoid other painkillers with anticoagulants if relevant). If the input mentions interactions or a pharmacist note, reflect it here in patient-friendly words.\n' +
          spec.headings.redflags + '\n' +
          'A short list of red-flag symptoms specific to these medications.\n' +
          'RULES: Do NOT invent doses or change any dose. Do NOT add medications. Do NOT mention AI. ' +
          'Keep the whole sheet under 350 words. Respond with the sheet only - no preamble.'
      },
      { role: 'user', content: JSON.stringify(context) }
    ]
  });

  const counselingSheet = response.choices[0].message.content.trim();

  return {
    labels: labels,
    counselingSheet: counselingSheet,
    counselingLanguage: language,
    tokensUsed: response.usage ? response.usage.total_tokens : null
  };
}

module.exports = { generateDispensingOutputs };
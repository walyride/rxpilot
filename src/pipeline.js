// RxPilot - Autopilot Pipeline (Phase 3, File 3)
// ============================================================
// The brain that connects everything:
//
//   image -> [1] vision (Qwen-VL reads the prescription)
//         -> [2] normalization (brand -> generic via RxNorm/Qwen)
//         -> [3] safety engine:
//                a. curated interaction table (deterministic)
//                b. allergy check vs patient profile
//                c. AI clinical review (doses, duplications, red flags)
//         -> [4] decision gate (human-in-the-loop):
//                BLOCKED       contraindicated -> pharmacist must act
//                NEEDS_REVIEW  major risk / low confidence -> pharmacist verifies
//                CLEARED       no flags -> one-click pharmacist approval
//
// Every step is recorded in an audit trail (who/what/when/why),
// because in pharmacy, traceability is a legal requirement.
// ============================================================

const { readPrescription } = require('./vision');
const { normalizeAll } = require('./normalize');
const { checkInteractions } = require('./interactions');
const { client, TEXT_MODEL } = require('./qwenClient');

// Thresholds for the decision gate
const CONFIDENCE_THRESHOLD = 0.8;   // below this, a human must verify the reading
const LEGIBILITY_THRESHOLD = 0.6;   // below this, the whole prescription needs review

// ---------- Audit trail helper ----------

function auditEntry(stage, detail) {
  return {
    stage: stage,
    detail: detail,
    at: new Date().toISOString()
  };
}

// ---------- Step 3c: AI clinical review ----------

async function aiClinicalReview(extraction, normalizedMeds, patient) {
  const reviewInput = {
    patient_age: (patient && patient.age) || extraction.patient?.age || null,
    patient_conditions: (patient && patient.conditions) || [],
    medications: extraction.medications.map((m, i) => ({
      written: m.raw_text,
      generic: normalizedMeds[i] ? normalizedMeds[i].generics : [m.drug_name],
      strength: m.strength,
      dose: m.dose,
      frequency: m.frequency,
      duration: m.duration
    }))
  };

  const response = await client.chat.completions.create({
    model: TEXT_MODEL,
    messages: [
      {
        role: 'system',
        content: 'You are the clinical review engine of RxPilot, assisting a licensed pharmacist. ' +
          'Review the medications for: (1) doses outside usual adult/pediatric ranges, ' +
          '(2) therapeutic duplication (two drugs from the same class), ' +
          '(3) frequency/duration red flags, (4) anything a careful pharmacist would question. ' +
          'You DO NOT need to check drug-drug interactions (a separate deterministic engine handles that). ' +
          'Respond with ONLY strict JSON: ' +
          '{"flags": [{"medication": string, "issue": string, "severity": "high"|"medium"|"low", "recommendation": string}]} ' +
          'If everything looks reasonable, respond: {"flags": []}'
      },
      { role: 'user', content: JSON.stringify(reviewInput) }
    ]
  });

  const raw = response.choices[0].message.content
    .replace(/```json/gi, '').replace(/```/g, '').trim();

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.flags) ? parsed.flags : [];
  } catch (e) {
    return [{
      medication: 'ALL',
      issue: 'AI clinical review output could not be parsed - manual review required',
      severity: 'medium',
      recommendation: 'Pharmacist should review the prescription manually.'
    }];
  }
}

// ---------- Step 3b: allergy check ----------

function checkAllergies(normalizedMeds, patient) {
  const allergies = ((patient && patient.allergies) || [])
    .map(a => String(a).toLowerCase().trim())
    .filter(Boolean);
  if (allergies.length === 0) return [];

  const hits = [];
  for (const med of normalizedMeds) {
    for (const generic of med.generics) {
      for (const allergy of allergies) {
        if (generic.includes(allergy) || allergy.includes(generic)) {
          hits.push({
            medication: med.original,
            generic: generic,
            allergy: allergy,
            severity: 'high',
            note: 'Patient profile lists an allergy matching this medication.'
          });
        }
      }
    }
  }
  return hits;
}

// ---------- Step 4: decision gate ----------

function decide(caseData) {
  const reasons = [];

  // Rule 1: any contraindicated interaction -> BLOCKED
  const contraindicated = caseData.interactions.filter(i => i.severity === 'contraindicated');
  if (contraindicated.length > 0) {
    reasons.push('Contraindicated drug interaction detected');
    return { status: 'BLOCKED', reasons: reasons };
  }

  // Rule 2: allergy hit -> BLOCKED
  if (caseData.allergyHits.length > 0) {
    reasons.push('Medication matches a documented patient allergy');
    return { status: 'BLOCKED', reasons: reasons };
  }

  // Rule 3: anything that requires pharmacist verification -> NEEDS_REVIEW
  const majorInteractions = caseData.interactions.filter(i => i.severity === 'major');
  if (majorInteractions.length > 0) {
    reasons.push(majorInteractions.length + ' major interaction(s) require pharmacist judgment');
  }

  const lowConfidenceReadings = caseData.extraction.medications
    .filter(m => (m.confidence || 0) < CONFIDENCE_THRESHOLD);
  if (lowConfidenceReadings.length > 0) {
    reasons.push('Low-confidence handwriting reading: ' +
      lowConfidenceReadings.map(m => m.drug_name).join(', '));
  }

  const unresolvedNames = caseData.normalizedMeds
    .filter(m => m.method === 'unresolved' || m.confidence < 0.5);
  if (unresolvedNames.length > 0) {
    reasons.push('Drug name(s) could not be confidently identified: ' +
      unresolvedNames.map(m => m.original).join(', '));
  }

  if ((caseData.extraction.overall_legibility || 1) < LEGIBILITY_THRESHOLD) {
    reasons.push('Overall prescription legibility is low');
  }

  const highAiFlags = caseData.aiFlags.filter(f => f.severity === 'high');
  if (highAiFlags.length > 0) {
    reasons.push('AI clinical review raised high-severity flag(s)');
  }

  const moderateInteractions = caseData.interactions.filter(i => i.severity === 'moderate');
  if (moderateInteractions.length > 0) {
    reasons.push(moderateInteractions.length +
      ' moderate interaction(s) - dispensing requires counseling notes');
  }

  const mediumAiFlags = caseData.aiFlags.filter(f => f.severity === 'medium');
  if (mediumAiFlags.length > 0) {
    reasons.push('AI clinical review raised item(s) worth verifying');
  }

  if (reasons.length > 0) {
    return { status: 'NEEDS_REVIEW', reasons: reasons };
  }

  // Rule 4: nothing flagged -> CLEARED (pharmacist still gives final one-click approval)
  return {
    status: 'CLEARED',
    reasons: ['No interactions, allergies, or reading-confidence issues detected']
  };
}

// ---------- Main pipeline ----------

/**
 * Process a prescription image end-to-end.
 * @param {object} input
 * @param {string} input.imageBase64 - the prescription photo
 * @param {string} [input.mimeType]
 * @param {object} [input.patient] - { id, name, age, currentMedications: [], allergies: [], conditions: [] }
 * @returns {Promise<object>} full case object ready for the pharmacist dashboard
 */
async function processPrescription(input) {
  const startedAt = Date.now();
  const audit = [];
  const patient = input.patient || null;

  // ---- Step 1: vision ----
  audit.push(auditEntry('vision_start', 'Sending image to Qwen-VL'));
  const visionResult = await readPrescription(input.imageBase64, input.mimeType || 'image/jpeg');
  const extraction = visionResult.extraction;

  if (extraction.error === 'not_a_prescription') {
    audit.push(auditEntry('vision_rejected', 'Image is not a prescription'));
    return {
      status: 'REJECTED',
      reasons: ['The uploaded image does not appear to be a prescription'],
      audit: audit,
      processingMs: Date.now() - startedAt
    };
  }

  const medCount = (extraction.medications || []).length;
  audit.push(auditEntry('vision_done', 'Extracted ' + medCount + ' medication(s), legibility ' +
    (extraction.overall_legibility != null ? extraction.overall_legibility : 'n/a')));

  // ---- Step 2: normalization ----
  audit.push(auditEntry('normalize_start', 'Resolving names via RxNorm (Qwen fallback for local brands)'));
  const writtenNames = (extraction.medications || []).map(m => m.drug_name || m.raw_text);
  const normalizedMeds = await normalizeAll(writtenNames);
  audit.push(auditEntry('normalize_done',
    normalizedMeds.map(n => n.original + ' -> ' + n.generics.join('+') + ' [' + n.method + ']').join('; ')));

  // ---- Step 3a: curated interaction check ----
  // Compare BOTH the new meds and the patient's current medications
  const newGenerics = normalizedMeds.flatMap(n => n.generics);
  const historyMeds = (patient && patient.currentMedications) || [];
  const allDrugs = [...newGenerics, ...historyMeds];

  audit.push(auditEntry('interactions_start',
    'Checking ' + allDrugs.length + ' drug(s) (' + newGenerics.length + ' new + ' +
    historyMeds.length + ' from patient history) against curated table'));
  const interactions = checkInteractions(allDrugs);
  audit.push(auditEntry('interactions_done', interactions.length + ' interaction(s) found'));

  // ---- Step 3b: allergy check ----
  const allergyHits = checkAllergies(normalizedMeds, patient);
  audit.push(auditEntry('allergy_check', allergyHits.length + ' allergy match(es)'));

  // ---- Step 3c: AI clinical review ----
  audit.push(auditEntry('ai_review_start', 'Qwen clinical review (doses, duplication, red flags)'));
  let aiFlags = [];
  try {
    aiFlags = await aiClinicalReview(extraction, normalizedMeds, patient);
    audit.push(auditEntry('ai_review_done', aiFlags.length + ' flag(s) raised'));
  } catch (e) {
    aiFlags = [{
      medication: 'ALL',
      issue: 'AI clinical review unavailable: ' + e.message,
      severity: 'medium',
      recommendation: 'Pharmacist should review manually.'
    }];
    audit.push(auditEntry('ai_review_failed', e.message));
  }

  // ---- Step 4: decision gate ----
  const caseData = { extraction, normalizedMeds, interactions, allergyHits, aiFlags };
  const decision = decide(caseData);
  audit.push(auditEntry('decision', decision.status + ' - ' + decision.reasons.join(' | ')));

  return {
    status: decision.status,               // BLOCKED | NEEDS_REVIEW | CLEARED
    reasons: decision.reasons,
    patient: patient,
    extraction: extraction,                // what was read from the paper
    normalizedMeds: normalizedMeds,        // written name -> generics
    interactions: interactions,            // curated engine hits
    allergyHits: allergyHits,
    aiFlags: aiFlags,                      // AI clinical review findings
    tokensUsed: visionResult.tokensUsed,
    processingMs: Date.now() - startedAt,
    audit: audit
  };
}

module.exports = { processPrescription };
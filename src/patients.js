// RxPilot - Patient Memory (v2 - Phase 6: dispensing outputs cache)
// ============================================================
// The agent's long-term memory: patient profiles, current
// medications, allergies, and every processed case.
//
// This is what makes the killer demo possible:
//   "Patient has been on warfarin since last month (from memory).
//    Today's new prescription adds diclofenac.
//    RxPilot remembers -> catches the interaction."
//
// Storage design: a simple JSON file store behind a clean
// interface. For the hackathon deployment, the same interface
// can be re-pointed at Alibaba Cloud Tablestore/OSS without
// touching any other module (only this file changes).
// ============================================================

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.RXPILOT_DATA_DIR || path.join(__dirname, '..', 'data');
const PATIENTS_FILE = path.join(DATA_DIR, 'patients.json');
const CASES_FILE = path.join(DATA_DIR, 'cases.json');

// ---------- Low-level store ----------

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadJson(file, fallback) {
  ensureDataDir();
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.warn('Store read failed for ' + file + ': ' + e.message);
    return fallback;
  }
}

function saveJson(file, data) {
  ensureDataDir();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file); // atomic-ish write: never leaves a half-written file
}

// ---------- Patients ----------

function generateId(prefix) {
  return prefix + '_' + Date.now().toString(36) + '_' +
    Math.random().toString(36).slice(2, 8);
}

/**
 * Create or update a patient profile.
 * @param {object} profile - { id?, name, age?, phone?, allergies?, conditions?, currentMedications? }
 * @returns {object} the saved patient
 */
function upsertPatient(profile) {
  const patients = loadJson(PATIENTS_FILE, []);
  let patient;

  if (profile.id) {
    const idx = patients.findIndex(p => p.id === profile.id);
    if (idx === -1) throw new Error('Patient not found: ' + profile.id);
    patient = {
      ...patients[idx],
      ...profile,
      updatedAt: new Date().toISOString()
    };
    patients[idx] = patient;
  } else {
    patient = {
      id: generateId('pt'),
      name: profile.name || 'Unknown',
      age: profile.age || null,
      phone: profile.phone || null,
      allergies: profile.allergies || [],
      conditions: profile.conditions || [],
      currentMedications: profile.currentMedications || [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    patients.push(patient);
  }

  saveJson(PATIENTS_FILE, patients);
  return patient;
}

function getPatient(id) {
  const patients = loadJson(PATIENTS_FILE, []);
  return patients.find(p => p.id === id) || null;
}

function listPatients() {
  return loadJson(PATIENTS_FILE, []);
}

/**
 * Search patients by (partial) name - used by the dashboard.
 */
function findPatientsByName(query) {
  const q = String(query || '').toLowerCase().trim();
  if (!q) return [];
  return loadJson(PATIENTS_FILE, [])
    .filter(p => (p.name || '').toLowerCase().includes(q));
}

/**
 * After a case is APPROVED and dispensed, add the medications to the
 * patient's current medication list (deduplicated by generic name).
 * @param {string} patientId
 * @param {string[]} generics - e.g. ["warfarin"]
 */
function addMedicationsToPatient(patientId, generics) {
  const patients = loadJson(PATIENTS_FILE, []);
  const idx = patients.findIndex(p => p.id === patientId);
  if (idx === -1) throw new Error('Patient not found: ' + patientId);

  const current = new Set((patients[idx].currentMedications || [])
    .map(m => String(m).toLowerCase()));
  for (const g of generics) current.add(String(g).toLowerCase());

  patients[idx].currentMedications = [...current];
  patients[idx].updatedAt = new Date().toISOString();
  saveJson(PATIENTS_FILE, patients);
  return patients[idx];
}

// ---------- Cases (processed prescriptions) ----------

/**
 * Save a processed case (the full pipeline output).
 * @param {object} caseResult - output of processPrescription()
 * @param {string|null} patientId
 * @returns {object} stored case with id
 */
function saveCase(caseResult, patientId) {
  const cases = loadJson(CASES_FILE, []);
  const stored = {
    id: generateId('case'),
    patientId: patientId || null,
    createdAt: new Date().toISOString(),
    pharmacistDecision: null,          // filled when pharmacist acts
    pharmacistDecisionAt: null,
    pharmacistNote: null,
    finalMedications: null,            // filled on MODIFIED: the pharmacist's edited final list
    dispensingOutputs: null,           // filled once after approval (labels + counseling sheet)
    result: caseResult
  };
  cases.push(stored);
  saveJson(CASES_FILE, cases);
  return stored;
}

function getCase(caseId) {
  const cases = loadJson(CASES_FILE, []);
  return cases.find(c => c.id === caseId) || null;
}

/**
 * List cases, newest first. Optionally filter by status or patient.
 */
function listCases(filter) {
  let cases = loadJson(CASES_FILE, []);
  if (filter && filter.status) {
    cases = cases.filter(c => c.result && c.result.status === filter.status);
  }
  if (filter && filter.patientId) {
    cases = cases.filter(c => c.patientId === filter.patientId);
  }
  return cases.sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));
}

/**
 * Record the pharmacist's final decision on a case (the human in the loop).
 * decision: "APPROVED" | "REJECTED" | "MODIFIED"
 * @param {object[]} [finalMedications] - for MODIFIED: the structured
 *        final list the pharmacist edited. Becomes the single source of
 *        truth for labels, counseling, and patient memory.
 * On APPROVED/MODIFIED, the dispensed medications are written into
 * patient memory (from the final list when present).
 */
function recordPharmacistDecision(caseId, decision, note, finalMedications) {
  const cases = loadJson(CASES_FILE, []);
  const idx = cases.findIndex(c => c.id === caseId);
  if (idx === -1) throw new Error('Case not found: ' + caseId);

  cases[idx].pharmacistDecision = decision;
  cases[idx].pharmacistDecisionAt = new Date().toISOString();
  cases[idx].pharmacistNote = note || null;
  if (Array.isArray(finalMedications) && finalMedications.length > 0) {
    cases[idx].finalMedications = finalMedications;
  }

  // Append to the case's own audit trail
  if (cases[idx].result && Array.isArray(cases[idx].result.audit)) {
    let detail = decision + (note ? ' - ' + note : '');
    if (cases[idx].finalMedications && decision === 'MODIFIED') {
      detail += ' | final list: ' +
        cases[idx].finalMedications
          .map(m => m.drug_name + (m.strength ? ' ' + m.strength : ''))
          .join(', ');
    }
    cases[idx].result.audit.push({
      stage: 'pharmacist_decision',
      detail: detail,
      at: new Date().toISOString()
    });
  }

  saveJson(CASES_FILE, cases);

  // On approval (plain or with modification), update patient memory
  // with what was ACTUALLY dispensed.
  if (['APPROVED', 'MODIFIED'].includes(decision) &&
      cases[idx].patientId && cases[idx].result) {
    let dispensed;
    if (cases[idx].finalMedications && cases[idx].finalMedications.length > 0) {
      // The pharmacist's edited list is the truth
      dispensed = cases[idx].finalMedications.map(m => m.drug_name);
    } else {
      dispensed = (cases[idx].result.normalizedMeds || [])
        .flatMap(m => m.generics || []);
    }
    if (dispensed.length > 0) {
      addMedicationsToPatient(cases[idx].patientId, dispensed);
    }
  }

  return cases[idx];
}

/**
 * Attach generated dispensing outputs (labels + counseling sheet in the
 * language the pharmacist selected) to a case, exactly once. Cached so
 * reprints never regenerate - a printed label must stay identical every time.
 * @param {string} caseId
 * @param {object} outputs - { labels: [...], counselingSheet: string,
 *                             counselingLanguage: 'ar'|'en', tokensUsed }
 */
function attachDispensingOutputs(caseId, outputs) {
  const cases = loadJson(CASES_FILE, []);
  const idx = cases.findIndex(c => c.id === caseId);
  if (idx === -1) throw new Error('Case not found: ' + caseId);

  cases[idx].dispensingOutputs = {
    labels: outputs.labels || [],
    counselingSheet: outputs.counselingSheet || '',
    counselingLanguage: outputs.counselingLanguage || 'ar',
    generatedAt: new Date().toISOString()
  };

  // Record the generation in the case's audit trail
  if (cases[idx].result && Array.isArray(cases[idx].result.audit)) {
    cases[idx].result.audit.push({
      stage: 'dispensing_outputs',
      detail: 'Labels + counseling sheet generated (' +
        (outputs.labels ? outputs.labels.length : 0) + ' label(s), language: ' +
        (outputs.counselingLanguage || 'ar') + ')',
      at: new Date().toISOString()
    });
  }

  saveJson(CASES_FILE, cases);
  return cases[idx];
}

module.exports = {
  upsertPatient,
  getPatient,
  listPatients,
  findPatientsByName,
  addMedicationsToPatient,
  saveCase,
  getCase,
  listCases,
  recordPharmacistDecision,
  attachDispensingOutputs
};
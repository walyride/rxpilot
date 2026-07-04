// RxPilot - AI Prescription Autopilot Agent
// Full API server (v0.7.0): pipeline + patient memory + pharmacist
// decisions (with structured medication modification) + bilingual
// dispensing outputs (labels & counseling sheet, Arabic or English).
// This is the backend the pharmacist dashboard talks to.

require('dotenv').config();
const express = require('express');
const path = require('path');
const { readPrescription } = require('./vision');
const { processPrescription } = require('./pipeline');
const { generateDispensingOutputs } = require('./counseling');
const patients = require('./patients');

const app = express();
app.use(express.json({ limit: '15mb' }));

// Serve the pharmacist dashboard (public/ folder)
app.use(express.static(path.join(__dirname, '..', 'public')));

const PORT = process.env.PORT || 3000;

// ---------- Health ----------

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'RxPilot',
    version: '0.7.0',
    time: new Date().toISOString()
  });
});

// ---------- Patients ----------

// Create or update a patient
// Body: { id?, name, age?, phone?, allergies?, conditions?, currentMedications? }
app.post('/api/patients', (req, res) => {
  try {
    const patient = patients.upsertPatient(req.body || {});
    res.json({ status: 'ok', patient: patient });
  } catch (err) {
    res.status(400).json({ error: 'patient_save_failed', details: err.message });
  }
});

// List all patients (or search: /api/patients?q=ahmed)
app.get('/api/patients', (req, res) => {
  try {
    const q = req.query.q;
    const list = q ? patients.findPatientsByName(q) : patients.listPatients();
    res.json({ status: 'ok', patients: list });
  } catch (err) {
    res.status(500).json({ error: 'patient_list_failed', details: err.message });
  }
});

// Get one patient
app.get('/api/patients/:id', (req, res) => {
  const patient = patients.getPatient(req.params.id);
  if (!patient) return res.status(404).json({ error: 'patient_not_found' });
  res.json({ status: 'ok', patient: patient });
});

// ---------- The agent: process a prescription ----------

// Full pipeline: image -> vision -> normalize -> safety -> decision gate
// Body: { imageBase64, mimeType?, patientId? }
// If patientId is given, the patient's memory (current meds, allergies)
// is loaded and checked against the new prescription.
app.post('/api/prescriptions/process', async (req, res) => {
  try {
    const { imageBase64, mimeType, patientId } = req.body;

    if (!imageBase64) {
      return res.status(400).json({ error: 'imageBase64 is required' });
    }

    let patient = null;
    if (patientId) {
      patient = patients.getPatient(patientId);
      if (!patient) {
        return res.status(404).json({ error: 'patient_not_found' });
      }
    }

    const result = await processPrescription({
      imageBase64: imageBase64,
      mimeType: mimeType || 'image/jpeg',
      patient: patient
    });

    // Persist the case so the pharmacist can review it from the dashboard
    const storedCase = patients.saveCase(result, patient ? patient.id : null);

    res.json({
      status: 'ok',
      caseId: storedCase.id,
      result: result
    });
  } catch (err) {
    console.error('Pipeline error:', err.message);
    res.status(500).json({ error: 'pipeline_failed', details: err.message });
  }
});

// Legacy Phase 2 endpoint: vision-only extraction (kept for testing)
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

// ---------- Cases & the human in the loop ----------

// List cases for the dashboard
// Optional filters: /api/cases?status=NEEDS_REVIEW or ?patientId=pt_xxx
app.get('/api/cases', (req, res) => {
  try {
    const list = patients.listCases({
      status: req.query.status,
      patientId: req.query.patientId
    });
    res.json({ status: 'ok', cases: list });
  } catch (err) {
    res.status(500).json({ error: 'case_list_failed', details: err.message });
  }
});

// Get one case (full report)
app.get('/api/cases/:id', (req, res) => {
  const c = patients.getCase(req.params.id);
  if (!c) return res.status(404).json({ error: 'case_not_found' });
  res.json({ status: 'ok', case: c });
});

// The pharmacist's final decision (human-in-the-loop checkpoint)
// Body: { decision: "APPROVED" | "REJECTED" | "MODIFIED",
//         note?,
//         finalMedications? }   <- required for MODIFIED: the structured
//                                  final list the pharmacist edited.
// Safety design: modifications are STRUCTURED DATA, never free text.
// Labels, counseling and patient memory all flow from this final list,
// so a printed label can never differ from what the pharmacist approved.
app.post('/api/cases/:id/decision', (req, res) => {
  try {
    const { decision, note, finalMedications } = req.body || {};
    const allowed = ['APPROVED', 'REJECTED', 'MODIFIED'];
    if (!allowed.includes(decision)) {
      return res.status(400).json({
        error: 'invalid_decision',
        details: 'decision must be one of: ' + allowed.join(', ')
      });
    }

    // Validate the structured final list (only meaningful for MODIFIED)
    let finalMeds = null;
    if (decision === 'MODIFIED') {
      if (!Array.isArray(finalMedications) || finalMedications.length === 0) {
        return res.status(400).json({
          error: 'final_medications_required',
          details: 'MODIFIED requires finalMedications: a non-empty array of the edited medication list.'
        });
      }
      if (finalMedications.length > 20) {
        return res.status(400).json({
          error: 'too_many_medications',
          details: 'A single prescription cannot exceed 20 medications.'
        });
      }
      const clean = v => (v == null || v === '') ? null : String(v).trim().slice(0, 120);
      finalMeds = [];
      for (const m of finalMedications) {
        const name = clean(m && m.drug_name);
        if (!name) {
          return res.status(400).json({
            error: 'invalid_medication',
            details: 'Every medication in finalMedications must have a non-empty drug_name.'
          });
        }
        finalMeds.push({
          drug_name: name,
          strength: clean(m.strength),
          dose: clean(m.dose),
          frequency: clean(m.frequency),
          duration: clean(m.duration),
          route: clean(m.route) || 'oral'
        });
      }
    }

    const updated = patients.recordPharmacistDecision(req.params.id, decision, note, finalMeds);
    res.json({ status: 'ok', case: updated });
  } catch (err) {
    res.status(400).json({ error: 'decision_failed', details: err.message });
  }
});

// ---------- Dispensing outputs (Phase 6) ----------

// Generate the dispensing labels + patient counseling sheet
// for an APPROVED (or MODIFIED) case.
// Body: { language?: 'ar' | 'en' } - counseling sheet language (default 'ar').
// Outputs are generated once, then cached on the case so reprints
// don't re-call the model (a printed document must stay identical).
app.post('/api/cases/:id/outputs', async (req, res) => {
  try {
    const c = patients.getCase(req.params.id);
    if (!c) return res.status(404).json({ error: 'case_not_found' });

    if (!['APPROVED', 'MODIFIED'].includes(c.pharmacistDecision)) {
      return res.status(400).json({
        error: 'not_approved',
        details: 'Dispensing outputs are only generated after pharmacist approval.'
      });
    }

    // Reprint: return cached outputs if already generated
    if (c.dispensingOutputs) {
      return res.json({ status: 'ok', cached: true, outputs: c.dispensingOutputs });
    }

    // SOURCE OF TRUTH for what gets dispensed:
    // - MODIFIED: the pharmacist's edited finalMedications list
    // - APPROVED: the medications as read from the prescription
    let meds;
    if (c.finalMedications && c.finalMedications.length > 0) {
      meds = c.finalMedications.map(m => ({
        drug_name: m.drug_name,
        generic: null,               // edited by hand; name is already what the pharmacist wants
        strength: m.strength,
        dose: m.dose,
        frequency: m.frequency,
        duration: m.duration,
        route: m.route
      }));
    } else {
      const extraction = (c.result && c.result.extraction) || {};
      const normalized = (c.result && c.result.normalizedMeds) || [];
      meds = (extraction.medications || []).map((m, i) => ({
        drug_name: m.drug_name,
        generic: normalized[i] ? (normalized[i].generics || []).join(' + ') : null,
        strength: m.strength,
        dose: m.dose,
        frequency: m.frequency,
        duration: m.duration,
        route: m.route
      }));
    }

    const patient = c.patientId ? patients.getPatient(c.patientId) : null;

    // Counseling sheet language selected by the pharmacist ('ar' default)
    const language = (req.body && req.body.language === 'en') ? 'en' : 'ar';

    const outputs = await generateDispensingOutputs({
      medications: meds,
      patient: patient,
      interactions: (c.result && c.result.interactions) || [],
      pharmacistNote: c.pharmacistNote,
      language: language
    });

    const saved = patients.attachDispensingOutputs(c.id, outputs);

    res.json({ status: 'ok', cached: false, outputs: saved.dispensingOutputs });
  } catch (err) {
    console.error('Outputs error:', err.message);
    res.status(500).json({ error: 'outputs_failed', details: err.message });
  }
});

// ---------- Start ----------

app.listen(PORT, () => {
  console.log('==========================================');
  console.log('  RxPilot server is running (v0.7.0)');
  console.log('  Health:    http://localhost:' + PORT + '/health');
  console.log('  Dashboard: http://localhost:' + PORT + '/');
  console.log('==========================================');
});
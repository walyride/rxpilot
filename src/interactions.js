// RxPilot - Dangerous Drug Interactions Table (v2)
// ============================================================
// CLINICALLY CURATED AND REVIEWED by Mostafa Waly,
// clinical pharmacy student.
// v2 changes (clinical review round 1):
//   + DOACs vs strong CYP3A4/P-gp inhibitors and enzyme inducers
//   + PDE5 inhibitors vs alpha-blockers (severe hypotension)
//   + Oral contraceptives vs enzyme inducers (contraceptive failure)
//   + Fluoroquinolones/Tetracyclines vs polyvalent cations (chelation)
//   * Matching engine rewritten: whole-word matching to prevent
//     false positives from partial string overlap
// This curated layer catches well-known killer interactions
// deterministically, BEFORE any AI reasoning is involved.
// ============================================================

// Drug class groups: lets one rule cover a whole family
const DRUG_CLASSES = {
  nsaid: [
    'diclofenac', 'ibuprofen', 'naproxen', 'ketorolac', 'indomethacin',
    'piroxicam', 'meloxicam', 'celecoxib', 'ketoprofen', 'mefenamic acid'
  ],
  ssri: [
    'fluoxetine', 'sertraline', 'paroxetine', 'citalopram', 'escitalopram',
    'fluvoxamine'
  ],
  maoi: [
    'phenelzine', 'tranylcypromine', 'isocarboxazid', 'selegiline',
    'moclobemide'
  ],
  ace_inhibitor: [
    'lisinopril', 'enalapril', 'ramipril', 'captopril', 'perindopril'
  ],
  arb: [
    'losartan', 'valsartan', 'candesartan', 'telmisartan', 'irbesartan'
  ],
  potassium_sparing: [
    'spironolactone', 'eplerenone', 'amiloride', 'triamterene'
  ],
  triptan: [
    'sumatriptan', 'rizatriptan', 'zolmitriptan', 'eletriptan'
  ],
  nitrate: [
    'nitroglycerin', 'glyceryl trinitrate', 'isosorbide mononitrate',
    'isosorbide dinitrate'
  ],
  pde5_inhibitor: [
    'sildenafil', 'tadalafil', 'vardenafil'
  ],
  macrolide: [
    'clarithromycin', 'erythromycin'
  ],
  statin_cyp3a4: [
    'simvastatin', 'atorvastatin', 'lovastatin'
  ],
  fluoroquinolone: [
    'ciprofloxacin', 'levofloxacin', 'moxifloxacin', 'norfloxacin',
    'ofloxacin'
  ],
  tetracycline_class: [
    'tetracycline', 'doxycycline', 'minocycline'
  ],
  benzodiazepine: [
    'diazepam', 'alprazolam', 'lorazepam', 'clonazepam', 'midazolam'
  ],
  opioid: [
    'morphine', 'tramadol', 'codeine', 'oxycodone', 'fentanyl', 'pethidine'
  ],
  // v2 additions (clinical review)
  doac: [
    'rivaroxaban', 'apixaban', 'dabigatran', 'edoxaban'
  ],
  strong_cyp3a4_pgp_inhibitor: [
    'ketoconazole', 'itraconazole', 'voriconazole', 'posaconazole',
    'ritonavir', 'lopinavir'
  ],
  enzyme_inducer: [
    'rifampicin', 'rifampin', 'carbamazepine', 'phenytoin',
    'phenobarbital', 'st johns wort', 'st john wort'
  ],
  alpha_blocker: [
    'tamsulosin', 'doxazosin', 'terazosin', 'alfuzosin', 'prazosin'
  ],
  oral_contraceptive: [
    'ethinylestradiol', 'ethinyl estradiol', 'levonorgestrel',
    'desogestrel', 'norethisterone', 'drospirenone', 'gestodene',
    'combined oral contraceptive'
  ],
  polyvalent_cation: [
    'calcium carbonate', 'calcium citrate', 'ferrous sulfate',
    'ferrous fumarate', 'ferrous gluconate', 'iron', 'magnesium hydroxide',
    'magnesium oxide', 'magnesium trisilicate', 'aluminum hydroxide',
    'aluminium hydroxide', 'zinc sulfate', 'antacid', 'sucralfate'
  ]
};

// Interaction rules.
// severity levels:
//   "contraindicated" - block, do not dispense without prescriber change
//   "major"           - pharmacist must review before dispensing
//   "moderate"        - dispense with mandatory counseling (e.g. dose separation)
// Each side can be a specific drug name or "class:<name>" referring to DRUG_CLASSES.
const INTERACTION_RULES = [
  {
    a: 'warfarin', b: 'class:nsaid',
    severity: 'major',
    risk: 'Severely increased bleeding risk (GI bleeding, intracranial hemorrhage)',
    mechanism: 'NSAIDs inhibit platelet function and damage GI mucosa; additive anticoagulation effect, some NSAIDs displace warfarin from protein binding',
    action: 'Avoid combination. If analgesia needed, consider paracetamol. If unavoidable, add GI protection and monitor INR closely.'
  },
  {
    a: 'warfarin', b: 'aspirin',
    severity: 'major',
    risk: 'Severely increased bleeding risk',
    mechanism: 'Additive antiplatelet + anticoagulant effect',
    action: 'Only under specialist supervision with strict INR monitoring.'
  },
  {
    a: 'warfarin', b: 'class:macrolide',
    severity: 'major',
    risk: 'Elevated INR and bleeding',
    mechanism: 'CYP inhibition reduces warfarin metabolism',
    action: 'Prefer azithromycin if a macrolide is needed; monitor INR.'
  },
  {
    a: 'warfarin', b: 'metronidazole',
    severity: 'major',
    risk: 'Marked INR elevation and bleeding',
    mechanism: 'Inhibition of warfarin (S-isomer) metabolism',
    action: 'Avoid if possible; otherwise reduce warfarin dose and monitor INR.'
  },
  // v2: DOACs (clinical review addition)
  {
    a: 'class:doac', b: 'class:strong_cyp3a4_pgp_inhibitor',
    severity: 'major',
    risk: 'Markedly increased DOAC levels - severe bleeding risk',
    mechanism: 'Strong CYP3A4 and/or P-gp inhibition reduces DOAC clearance',
    action: 'Avoid combination (contraindicated for rivaroxaban/apixaban with strong dual inhibitors). Contact prescriber for alternative.'
  },
  {
    a: 'class:doac', b: 'class:enzyme_inducer',
    severity: 'major',
    risk: 'Reduced DOAC levels - treatment failure and thrombosis/stroke risk',
    mechanism: 'CYP3A4/P-gp induction accelerates DOAC elimination',
    action: 'Avoid combination; contact prescriber. Warfarin with INR monitoring may be preferred if inducer is essential.'
  },
  {
    a: 'methotrexate', b: 'trimethoprim',
    severity: 'contraindicated',
    risk: 'Severe bone marrow suppression (pancytopenia), potentially fatal',
    mechanism: 'Both are folate antagonists; trimethoprim also reduces methotrexate clearance',
    action: 'Do not dispense together. Contact prescriber for alternative antibiotic.'
  },
  {
    a: 'methotrexate', b: 'class:nsaid',
    severity: 'major',
    risk: 'Methotrexate toxicity (especially at high MTX doses)',
    mechanism: 'NSAIDs reduce renal clearance of methotrexate',
    action: 'Caution with low-dose MTX; avoid with high-dose MTX. Monitor renal function and blood counts.'
  },
  {
    a: 'class:maoi', b: 'class:ssri',
    severity: 'contraindicated',
    risk: 'Serotonin syndrome (hyperthermia, rigidity, death)',
    mechanism: 'Massive synaptic serotonin accumulation',
    action: 'Do not dispense. Requires 2-week washout (5 weeks after fluoxetine).'
  },
  {
    a: 'class:maoi', b: 'pethidine',
    severity: 'contraindicated',
    risk: 'Serotonin syndrome / fatal excitatory reaction',
    mechanism: 'Pethidine blocks serotonin reuptake',
    action: 'Do not dispense together.'
  },
  {
    a: 'tramadol', b: 'class:ssri',
    severity: 'major',
    risk: 'Serotonin syndrome and lowered seizure threshold',
    mechanism: 'Additive serotonergic activity',
    action: 'Prefer alternative analgesic; if combined, counsel on serotonin syndrome symptoms.'
  },
  {
    a: 'class:nitrate', b: 'class:pde5_inhibitor',
    severity: 'contraindicated',
    risk: 'Profound refractory hypotension, potentially fatal',
    mechanism: 'Synergistic cGMP-mediated vasodilation',
    action: 'Do not dispense. At least 24h gap after sildenafil (48h after tadalafil).'
  },
  // v2: PDE5i + alpha-blockers (clinical review addition)
  {
    a: 'class:pde5_inhibitor', b: 'class:alpha_blocker',
    severity: 'major',
    risk: 'Severe symptomatic hypotension (syncope, falls)',
    mechanism: 'Additive vasodilation and alpha-adrenergic blockade',
    action: 'If patient is stable on the alpha-blocker, start PDE5 inhibitor at the lowest dose with time separation. Counsel on orthostatic symptoms.'
  },
  // v2: Oral contraceptives + enzyme inducers (clinical review addition)
  {
    a: 'class:oral_contraceptive', b: 'class:enzyme_inducer',
    severity: 'major',
    risk: 'Contraceptive failure - unintended pregnancy (high clinical and legal impact)',
    mechanism: 'Enzyme induction accelerates estrogen/progestin metabolism',
    action: 'Advise additional non-hormonal contraception during treatment and for 28 days after stopping the inducer. Contact prescriber about alternatives.'
  },
  {
    a: 'class:ace_inhibitor', b: 'class:potassium_sparing',
    severity: 'major',
    risk: 'Life-threatening hyperkalemia',
    mechanism: 'Both reduce potassium excretion',
    action: 'Requires potassium and renal function monitoring; verify indication (may be intentional in heart failure).'
  },
  {
    a: 'class:arb', b: 'class:potassium_sparing',
    severity: 'major',
    risk: 'Life-threatening hyperkalemia',
    mechanism: 'Both reduce potassium excretion',
    action: 'Requires potassium and renal function monitoring; verify indication.'
  },
  {
    a: 'class:ace_inhibitor', b: 'class:arb',
    severity: 'major',
    risk: 'Hyperkalemia, hypotension, renal impairment',
    mechanism: 'Dual RAAS blockade',
    action: 'Combination generally not recommended; contact prescriber.'
  },
  {
    a: 'spironolactone', b: 'potassium chloride',
    severity: 'major',
    risk: 'Severe hyperkalemia',
    mechanism: 'Potassium retention plus supplementation',
    action: 'Verify recent potassium level with prescriber before dispensing.'
  },
  {
    a: 'class:statin_cyp3a4', b: 'class:macrolide',
    severity: 'major',
    risk: 'Rhabdomyolysis and acute kidney injury',
    mechanism: 'CYP3A4 inhibition raises statin levels',
    action: 'Hold statin during clarithromycin/erythromycin course, or switch antibiotic.'
  },
  {
    a: 'simvastatin', b: 'gemfibrozil',
    severity: 'contraindicated',
    risk: 'Rhabdomyolysis',
    mechanism: 'Gemfibrozil inhibits statin metabolism and transport',
    action: 'Do not dispense together; contact prescriber.'
  },
  {
    a: 'digoxin', b: 'amiodarone',
    severity: 'major',
    risk: 'Digoxin toxicity (arrhythmias, nausea, visual changes)',
    mechanism: 'Amiodarone reduces digoxin clearance',
    action: 'Digoxin dose usually needs ~50% reduction; verify with prescriber.'
  },
  {
    a: 'digoxin', b: 'verapamil',
    severity: 'major',
    risk: 'Digoxin toxicity and additive AV block',
    mechanism: 'Reduced digoxin clearance + additive cardiac conduction effects',
    action: 'Monitor digoxin level and heart rate; verify with prescriber.'
  },
  {
    a: 'verapamil', b: 'propranolol',
    severity: 'major',
    risk: 'Severe bradycardia, AV block, heart failure',
    mechanism: 'Additive negative chronotropic and inotropic effects',
    action: 'Combination requires specialist supervision.'
  },
  {
    a: 'class:fluoroquinolone', b: 'theophylline',
    severity: 'major',
    risk: 'Theophylline toxicity (seizures, arrhythmias)',
    mechanism: 'CYP1A2 inhibition (especially ciprofloxacin)',
    action: 'Prefer levofloxacin or reduce theophylline dose; monitor levels.'
  },
  // v2: Chelation interactions (clinical review addition)
  {
    a: 'class:fluoroquinolone', b: 'class:polyvalent_cation',
    severity: 'moderate',
    risk: 'Antibiotic treatment failure due to chelation and reduced absorption',
    mechanism: 'Polyvalent cations (Ca, Fe, Mg, Al, Zn) chelate fluoroquinolones in the gut',
    action: 'Separate doses: take the fluoroquinolone 2 hours before or 4-6 hours after the cation-containing product.'
  },
  {
    a: 'class:tetracycline_class', b: 'class:polyvalent_cation',
    severity: 'moderate',
    risk: 'Antibiotic treatment failure due to chelation and reduced absorption',
    mechanism: 'Polyvalent cations chelate tetracyclines in the gut',
    action: 'Separate doses: take the tetracycline 2 hours before or 4 hours after the cation-containing product.'
  },
  {
    a: 'class:opioid', b: 'class:benzodiazepine',
    severity: 'major',
    risk: 'Profound sedation, respiratory depression, death',
    mechanism: 'Additive CNS and respiratory depression',
    action: 'Avoid combination when possible; if prescribed together, verify intent and counsel patient/family.'
  },
  {
    a: 'clopidogrel', b: 'omeprazole',
    severity: 'major',
    risk: 'Reduced antiplatelet effect - stent thrombosis risk',
    mechanism: 'Omeprazole inhibits CYP2C19 activation of clopidogrel',
    action: 'Switch PPI to pantoprazole, or use H2 blocker (not cimetidine).'
  },
  {
    a: 'allopurinol', b: 'azathioprine',
    severity: 'contraindicated',
    risk: 'Severe myelosuppression',
    mechanism: 'Allopurinol blocks xanthine oxidase metabolism of azathioprine',
    action: 'Do not dispense at standard doses; azathioprine needs major dose reduction under specialist care.'
  },
  {
    a: 'lithium', b: 'class:nsaid',
    severity: 'major',
    risk: 'Lithium toxicity (tremor, confusion, renal injury)',
    mechanism: 'NSAIDs reduce renal lithium clearance',
    action: 'Prefer paracetamol; if NSAID necessary, monitor lithium level.'
  },
  {
    a: 'lithium', b: 'class:ace_inhibitor',
    severity: 'major',
    risk: 'Lithium toxicity',
    mechanism: 'Reduced renal lithium clearance',
    action: 'Monitor lithium levels closely; verify with prescriber.'
  },
  {
    a: 'class:triptan', b: 'class:maoi',
    severity: 'contraindicated',
    risk: 'Serotonin syndrome and hypertensive crisis',
    mechanism: 'Reduced triptan metabolism + serotonergic excess',
    action: 'Do not dispense together.'
  },
  {
    a: 'colchicine', b: 'class:macrolide',
    severity: 'major',
    risk: 'Fatal colchicine toxicity (especially in renal impairment)',
    mechanism: 'CYP3A4/P-gp inhibition raises colchicine levels',
    action: 'Avoid combination or drastically reduce colchicine dose; check renal function.'
  },
  {
    a: 'amiodarone', b: 'class:fluoroquinolone',
    severity: 'major',
    risk: 'QT prolongation and torsades de pointes',
    mechanism: 'Additive QT-prolonging effect',
    action: 'Avoid combination; if needed, ECG monitoring required.'
  },
  {
    a: 'potassium chloride', b: 'class:ace_inhibitor',
    severity: 'major',
    risk: 'Hyperkalemia',
    mechanism: 'Reduced potassium excretion plus supplementation',
    action: 'Verify recent potassium level before dispensing.'
  }
];

// ---------- Matching engine (v2: whole-word matching) ----------

function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')   // strip punctuation
    .replace(/\s+/g, ' ')
    .trim();
}

// Expand a rule side to a list of concrete drug names
function expandSide(side) {
  if (side.startsWith('class:')) {
    const className = side.slice(6);
    return DRUG_CLASSES[className] || [];
  }
  return [side];
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// v2 fix: match only whole words/phrases, never partial substrings.
// "Warfarin" matches "warfarin sodium 5mg" but NOT a drug whose name
// merely contains overlapping letters.
function sideMatches(side, normalizedDrugName) {
  const candidates = expandSide(side);
  return candidates.some(c => {
    const pattern = new RegExp('\\b' + escapeRegex(c) + '\\b', 'i');
    return pattern.test(normalizedDrugName);
  });
}

/**
 * Check a list of drug names (new prescription + patient's current meds)
 * against the curated interaction table.
 * @param {string[]} drugNames
 * @returns {object[]} list of triggered interactions with the pair involved
 */
function checkInteractions(drugNames) {
  const names = drugNames.map(normalizeName).filter(Boolean);
  const hits = [];

  for (const rule of INTERACTION_RULES) {
    for (let i = 0; i < names.length; i++) {
      for (let j = 0; j < names.length; j++) {
        if (i === j) continue;
        if (sideMatches(rule.a, names[i]) && sideMatches(rule.b, names[j])) {
          const pairKey = [names[i], names[j]].sort().join('|') + '|' + rule.risk;
          if (!hits.some(h => h._key === pairKey)) {
            hits.push({
              _key: pairKey,
              drug1: names[i],
              drug2: names[j],
              severity: rule.severity,
              risk: rule.risk,
              mechanism: rule.mechanism,
              action: rule.action,
              source: 'RxPilot curated table (clinically reviewed)'
            });
          }
        }
      }
    }
  }

  // Strip internal keys before returning
  return hits.map(({ _key, ...rest }) => rest);
}

module.exports = { checkInteractions, INTERACTION_RULES, DRUG_CLASSES };
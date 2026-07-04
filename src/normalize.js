// RxPilot - Drug Name Normalization (v2)
// Converts whatever is written on the prescription (brand names,
// misspellings, salts) into the generic active ingredient, so the
// interaction engine always compares generics.
//
// v2 fix: confidence is now computed as string similarity (Dice
// coefficient on character bigrams) between the cleaned input and the
// matched RxNorm concept name. The raw RxNorm "score" field uses an
// internal relative scale and produced misleading values (e.g. 0.15
// for a perfect brand match).
//
// Strategy (two layers):
//   1. RxNorm API (US National Library of Medicine - free, no key needed)
//      Handles international brands and misspellings via approximate match.
//   2. Qwen fallback for local/regional brand names not in RxNorm
//      (e.g. Egyptian market brands), returning the generic + confidence.

const { client, TEXT_MODEL } = require('./qwenClient');

const RXNORM_BASE = 'https://rxnav.nlm.nih.gov/REST';

// ---------- String similarity (v2) ----------

function bigrams(str) {
  const s = str.toLowerCase().replace(/\s+/g, '');
  const grams = [];
  for (let i = 0; i < s.length - 1; i++) grams.push(s.slice(i, i + 2));
  return grams;
}

// Dice coefficient: 1.0 = identical, 0.0 = nothing in common
function diceSimilarity(a, b) {
  const gramsA = bigrams(a);
  const gramsB = bigrams(b);
  if (gramsA.length === 0 || gramsB.length === 0) {
    return a.toLowerCase() === b.toLowerCase() ? 1 : 0;
  }
  const counts = new Map();
  for (const g of gramsA) counts.set(g, (counts.get(g) || 0) + 1);
  let overlap = 0;
  for (const g of gramsB) {
    const c = counts.get(g) || 0;
    if (c > 0) {
      overlap++;
      counts.set(g, c - 1);
    }
  }
  return (2 * overlap) / (gramsA.length + gramsB.length);
}

// ---------- Layer 1: RxNorm ----------

async function rxnormApproximateMatch(term) {
  const url = RXNORM_BASE + '/approximateTerm.json?term=' +
    encodeURIComponent(term) + '&maxEntries=1';
  const res = await fetch(url);
  if (!res.ok) throw new Error('RxNorm HTTP ' + res.status);
  const data = await res.json();
  const candidate = data.approximateGroup &&
    data.approximateGroup.candidate &&
    data.approximateGroup.candidate[0];
  if (!candidate || !candidate.rxcui) return null;
  return { rxcui: candidate.rxcui };
}

async function rxnormGetName(rxcui) {
  const url = RXNORM_BASE + '/rxcui/' + rxcui +
    '/property.json?propName=RxNorm%20Name';
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  const prop = data.propConceptGroup &&
    data.propConceptGroup.propConcept &&
    data.propConceptGroup.propConcept[0];
  return prop ? prop.propValue : null;
}

async function rxnormGetIngredients(rxcui) {
  const url = RXNORM_BASE + '/rxcui/' + rxcui + '/related.json?tty=IN';
  const res = await fetch(url);
  if (!res.ok) throw new Error('RxNorm HTTP ' + res.status);
  const data = await res.json();
  const groups = (data.relatedGroup && data.relatedGroup.conceptGroup) || [];
  const ingredients = [];
  for (const g of groups) {
    for (const c of (g.conceptProperties || [])) {
      if (c.name) ingredients.push(c.name.toLowerCase());
    }
  }
  return [...new Set(ingredients)];
}

// ---------- Layer 2: Qwen fallback (local brands) ----------

async function qwenBrandFallback(term) {
  const response = await client.chat.completions.create({
    model: TEXT_MODEL,
    messages: [
      {
        role: 'system',
        content: 'You are a pharmacology reference assistant. ' +
          'Given a drug brand name (possibly an Egyptian or Middle Eastern market brand, possibly misspelled), ' +
          'identify the generic active ingredient(s). ' +
          'Respond with ONLY strict JSON: ' +
          '{"generic": ["ingredient1", "ingredient2"], "confidence": 0.0_to_1.0} ' +
          'If you genuinely do not recognize the brand, respond: {"generic": [], "confidence": 0}'
      },
      { role: 'user', content: term }
    ]
  });

  const raw = response.choices[0].message.content
    .replace(/```json/gi, '').replace(/```/g, '').trim();

  try {
    const parsed = JSON.parse(raw);
    return {
      generics: (parsed.generic || []).map(g => String(g).toLowerCase()),
      confidence: Number(parsed.confidence) || 0
    };
  } catch (e) {
    return { generics: [], confidence: 0 };
  }
}

// ---------- Public API ----------

/**
 * Normalize one drug name to its generic ingredient(s).
 * @param {string} rawName - as written on the prescription (e.g. "Cataflam 50mg")
 * @returns {Promise<object>} { original, generics[], method, confidence, rxcui, matchedName }
 */
async function normalizeDrug(rawName) {
  // Strip strength/units so RxNorm sees a clean name ("Cataflam 50mg" -> "Cataflam")
  const cleaned = String(rawName || '')
    .replace(/\d+(\.\d+)?\s*(mg|mcg|g|ml|iu|%)/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) {
    return {
      original: rawName, generics: [], method: 'unresolved',
      confidence: 0, rxcui: null, matchedName: null
    };
  }

  // Layer 1: RxNorm
  try {
    const match = await rxnormApproximateMatch(cleaned);
    if (match) {
      const matchedName = await rxnormGetName(match.rxcui);
      // v2: confidence = how close the written name is to what RxNorm matched
      const confidence = matchedName
        ? Math.round(diceSimilarity(cleaned, matchedName) * 100) / 100
        : 0.5;
      const ingredients = await rxnormGetIngredients(match.rxcui);

      return {
        original: rawName,
        generics: ingredients.length > 0 ? ingredients : [cleaned.toLowerCase()],
        method: 'rxnorm',
        confidence: confidence,
        rxcui: match.rxcui,
        matchedName: matchedName
      };
    }
  } catch (e) {
    console.warn('RxNorm unavailable for "' + cleaned + '": ' + e.message);
  }

  // Layer 2: Qwen fallback (local brands)
  try {
    const fallback = await qwenBrandFallback(cleaned);
    if (fallback.generics.length > 0) {
      return {
        original: rawName,
        generics: fallback.generics,
        method: 'qwen_fallback',
        confidence: fallback.confidence,
        rxcui: null,
        matchedName: null
      };
    }
  } catch (e) {
    console.warn('Qwen fallback failed for "' + cleaned + '": ' + e.message);
  }

  // Unresolved: keep the cleaned name so the interaction engine
  // can still try a direct match, but flag it for pharmacist review.
  return {
    original: rawName,
    generics: [cleaned.toLowerCase()],
    method: 'unresolved',
    confidence: 0,
    rxcui: null,
    matchedName: null
  };
}

/**
 * Normalize a whole medication list (runs in parallel).
 * @param {string[]} rawNames
 * @returns {Promise<object[]>}
 */
async function normalizeAll(rawNames) {
  return Promise.all(rawNames.map(normalizeDrug));
}

module.exports = { normalizeDrug, normalizeAll };
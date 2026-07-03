// RxPilot - Drug Name Normalization (Phase 3, File 2)
// Converts whatever is written on the prescription (brand names,
// misspellings, salts) into the generic active ingredient, so the
// interaction engine always compares generics.
//
// Strategy (two layers):
//   1. RxNorm API (US National Library of Medicine - free, no key needed)
//      Handles international brands and misspellings via approximate match.
//   2. Qwen fallback for local/regional brand names not in RxNorm
//      (e.g. Egyptian market brands), returning the generic + confidence.

const { client, TEXT_MODEL } = require('./qwenClient');

const RXNORM_BASE = 'https://rxnav.nlm.nih.gov/REST';

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
  return {
    rxcui: candidate.rxcui,
    score: Number(candidate.score) || 0
  };
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
 * @returns {Promise<object>} { original, generics[], method, confidence, rxcui }
 */
async function normalizeDrug(rawName) {
  // Strip strength/units so RxNorm sees a clean name ("Cataflam 50mg" -> "Cataflam")
  const cleaned = String(rawName || '')
    .replace(/\d+(\.\d+)?\s*(mg|mcg|g|ml|iu|%)/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) {
    return { original: rawName, generics: [], method: 'unresolved', confidence: 0, rxcui: null };
  }

  // Layer 1: RxNorm
  try {
    const match = await rxnormApproximateMatch(cleaned);
    if (match) {
      const ingredients = await rxnormGetIngredients(match.rxcui);
      if (ingredients.length > 0) {
        return {
          original: rawName,
          generics: ingredients,
          method: 'rxnorm',
          confidence: Math.min(match.score / 100, 1),
          rxcui: match.rxcui
        };
      }
      // RxNorm found the concept itself (it may already be a generic)
      return {
        original: rawName,
        generics: [cleaned.toLowerCase()],
        method: 'rxnorm',
        confidence: Math.min(match.score / 100, 1),
        rxcui: match.rxcui
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
        rxcui: null
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
    rxcui: null
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
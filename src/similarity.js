function tokenize(text) {
  return new Set(
    String(text)
      .toLowerCase()
      .replace(/[^a-z0-9à-ɏ\s]/gi, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2)
  );
}

function jaccard(a, b) {
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const w of setA) if (setB.has(w)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Compares each participant's response this round against their own
 * response last round. Returns the average similarity across participants
 * who answered in both rounds (0 when there's nothing to compare).
 */
export function roundSimilarity(prevRoundResponses, currRoundResponses) {
  const ids = Object.keys(currRoundResponses).filter((id) => prevRoundResponses[id]);
  if (ids.length === 0) return 0;
  const scores = ids.map((id) => jaccard(prevRoundResponses[id].text, currRoundResponses[id].text));
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

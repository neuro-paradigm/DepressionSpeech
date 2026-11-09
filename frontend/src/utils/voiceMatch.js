// Voice-driven read-along matching engine.
//
// Speech recognition output is noisy: partial results get revised, small
// words get dropped, and accuracy varies with accents. These helpers turn a
// raw transcript stream into a monotonic pointer over the prompt's words.

/** Words the reader says but that should never drive the highlight. */
export const FILLER_WORDS = new Set(['um', 'uh', 'erm', 'hmm', 'mmm']);

/**
 * Normalize a single word for comparison: lowercase, strip punctuation
 * (including curly quotes and dashes) and collapse possessive/contraction
 * apostrophes so "don't" === "dont".
 */
export function normalizeWord(word = '') {
  return String(word)
    .toLowerCase()
    .replace(/[''`]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Tokenize spoken text: normalized words with fillers removed.
 */
export function spokenTokens(text = '') {
  return String(text)
    .split(/\s+/)
    .map(normalizeWord)
    .filter((token) => token && !FILLER_WORDS.has(token));
}

/**
 * Levenshtein distance with early bailout once the distance provably exceeds
 * maxDist — keeps fuzzy matching O(n·m) but fast for short words.
 */
export function boundedLevenshtein(a, b, maxDist) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > maxDist) return maxDist + 1;

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowMinimum = i;
    for (let j = 1; j <= b.length; j += 1) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + substitutionCost,
      );
      current.push(value);
      if (value < rowMinimum) rowMinimum = value;
    }
    if (rowMinimum > maxDist) return maxDist + 1;
    previous = current;
  }
  return previous[b.length];
}

/**
 * Tolerant comparison between a prompt word and a spoken word. Short words
 * must match exactly (too risky to fuzz "a"/"the"); longer words tolerate
 * proportional edit distance for accents and mispronunciations.
 */
export function wordsMatch(target, spoken) {
  if (!target || !spoken) return false;
  if (target === spoken) return true;
  const tolerance = target.length >= 8 ? 2 : target.length >= 4 ? 1 : 0;
  if (!tolerance) return false;
  return boundedLevenshtein(target, spoken, tolerance) <= tolerance;
}

/**
 * Advance a read pointer through spoken tokens.
 *
 * Look-ahead windowing: each spoken word may match any prompt word within
 * `lookAhead` slots of the current pointer, so a dropped or mangled word
 * ("the", "is") never strands the highlight.
 *
 * @param {string[]} tokens       Normalized spoken words, in order.
 * @param {number}   startPos     Current pointer (first unspoken word).
 * @param {string[]} targets      Normalized prompt words.
 * @param {number}   lookAhead    How many words ahead to search.
 * @returns {number} New pointer. Never moves backwards.
 */
export function advancePointer(tokens, startPos, targets, lookAhead = 6) {
  let position = Math.max(0, Math.min(startPos, targets.length));
  for (const token of tokens) {
    if (position >= targets.length) break;
    const limit = Math.min(position + lookAhead, targets.length - 1);
    for (let candidate = position; candidate <= limit; candidate += 1) {
      if (wordsMatch(targets[candidate], token)) {
        position = candidate + 1;
        break;
      }
    }
  }
  return position;
}

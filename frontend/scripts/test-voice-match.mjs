// Run with: node scripts/test-voice-match.cjs
import { normalizeWord, spokenTokens, wordsMatch, advancePointer, boundedLevenshtein } from '../src/utils/voiceMatch.js';

let failures = 0;
function check(name, actual, expected) {
  const pass = Object.is(actual, expected);
  if (!pass) failures += 1;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
}

check('norm punctuation', normalizeWord('Hello,'), 'hello');
check('norm curly apostrophe', normalizeWord('don\u2019t'), 'dont');
check('norm straight apostrophe', normalizeWord("I'm"), 'im');
check('norm em-dash', normalizeWord('okay\u2014wait'), 'okaywait');

check('fillers stripped', JSON.stringify(spokenTokens('um the uh quick brown hmm')), JSON.stringify(['the', 'quick', 'brown']));

check('exact match', wordsMatch('quick', 'quick'), true);
check('fuzzy 1-edit len>=4', wordsMatch('jumps', 'jumpt'), true);
check('fuzzy 2-edit len>=8', wordsMatch('beginning', 'begiming'), true);
check('short word strict', wordsMatch('the', 'then'), false);
check('lev bailout works', boundedLevenshtein('kitten', 'sitting', 2) > 2, true);

const targets = 'The lake was perfectly still that morning.'.split(/\s+/).map(normalizeWord);
// [the, lake, was, perfectly, still, that, morning]

check('sequential match', advancePointer(['the', 'lake'], 0, targets), 2);
check('look-ahead skips dropped word', advancePointer(['perfectly', 'still'], 2, targets), 5);
check('mangled word skipped, next catches up', advancePointer(['wuz', 'that'], 3, targets), 6);
check('monotonic on garbage', advancePointer(['zebra', 'unicorn'], 4, targets), 4);
check('clamps at end', advancePointer(['morning', 'extra', 'words'], 6, targets), targets.length);
check('never rewinds pointer', advancePointer(['lake'], 5, targets), 5);

if (failures) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nAll voice-match tests passed.');

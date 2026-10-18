// Lessons written for you: Gemini writes a short story at your level that uses mostly words
// you know plus a handful of the LingQs you're learning, so you meet them again in new
// sentences (review by reading). The story becomes an ordinary text lesson.
import { state, lang, langName } from './state.js';
import { KNOWN, isLearning } from './srs.js';
import { geminiJson } from './ai.js';

export const LENGTHS = { short: 150, medium: 300, long: 500 };
const TARGETS = 8;
const KNOWN_SAMPLE = 300;

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING' },
    paragraphs: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['title', 'paragraphs'],
};

// A rough level from the size of the known-word pool (word families vs. CEFR, loosely).
export function levelOf(known) {
  if (known < 300) return { cefr: 'A1', note: 'a complete beginner: very short sentences, present tense, the most common words only' };
  if (known < 1000) return { cefr: 'A2', note: 'a beginner: short simple sentences, everyday words' };
  if (known < 3000) return { cefr: 'B1', note: 'an intermediate learner: clear sentences, common tenses' };
  if (known < 8000) return { cefr: 'B2', note: 'an upper-intermediate learner: natural sentences, some idioms' };
  return { cefr: 'C1', note: 'an advanced learner: natural, varied language' };
}

// The LingQs to practise: the least known first (lowest level, then the most recently added),
// shuffled a little among the weakest so two stories in a row don't use the same words.
export function pickTargets(vocab = state.vocab, n = TARGETS, rand = Math.random) {
  const learning = [...vocab.values()].filter((w) => isLearning(w.status));
  learning.sort((a, b) => a.status - b.status || (b.createdAt || 0) - (a.createdAt || 0));
  const pool = learning.slice(0, n * 3);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n).map((w) => w.term);
}

// Known words the learner meets most often, to steer the vocabulary.
function knownSample(vocab) {
  return [...vocab.values()]
    .filter((w) => w.status === KNOWN && !w.isPhrase)
    .sort((a, b) => (b.freq || 0) - (a.freq || 0))
    .slice(0, KNOWN_SAMPLE)
    .map((w) => w.term);
}

export function buildStoryPrompt({ topic = '', length = 'medium', targets, known, knownCount }) {
  const L = langName(lang());
  const lvl = levelOf(knownCount);
  const words = LENGTHS[length] || LENGTHS.medium;
  return {
    system: `You write graded reading for language learners. Write an original, engaging ${L} text of about ${words} words for ${lvl.note} (about CEFR ${lvl.cefr}). `
      + 'Keep almost every word simple and common, so the learner understands at least 95% of it. '
      + 'Use each of the target words naturally, in a sentence whose context makes its meaning clear; use each one twice if it fits. '
      + 'A target word may change form (conjugation, plural, agreement). '
      + 'No translations, glossary, notes or English in the text. Split it into short paragraphs. '
      + `Reply with JSON: {"title": "", "paragraphs": [""]}; the title in ${L}, a few words.`,
    user: [
      `Topic: ${topic.trim() || 'anything interesting from everyday life (your choice)'}.`,
      targets.length ? `Target words: ${targets.join(', ')}.` : 'No target words: just write at the level.',
      known.length ? `Words the learner already knows (prefer these): ${known.join(', ')}.` : '',
    ].filter(Boolean).join('\n'),
  };
}

// -> {title, text, targets}
export async function writeStory({ topic = '', length = 'medium' } = {}) {
  const vocab = state.vocab;
  const targets = pickTargets(vocab);
  const knownCount = [...vocab.values()].filter((w) => w.status === KNOWN && !w.isPhrase).length;
  const { result } = await geminiJson({
    ...buildStoryPrompt({ topic, length, targets, known: knownSample(vocab), knownCount }),
    schema: SCHEMA,
    temperature: 0.9, // a different story each time
  });
  const paragraphs = (result.paragraphs || []).map((p) => String(p).trim()).filter(Boolean);
  if (!paragraphs.length) throw new Error('The AI didn’t write anything. Try again.');
  return { title: String(result.title || '').trim() || topic.trim() || 'Story', text: paragraphs.join('\n\n'), targets };
}

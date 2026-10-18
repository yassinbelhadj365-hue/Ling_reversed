// Hand-offs to free chat websites for "Still unclear?": DeepSeek's free web chat and
// ChatGPT (the user's own subscription), opened with the question written for them.
// (In-app answers come from ai.js.)
import { state, langName } from './state.js';

// ---------- hand-offs to chat websites ----------

const CHATGPT_CONTEXT_CHARS = 2500;  // the question travels in the URL, so keep it short
const DEEPSEEK_CONTEXT_CHARS = 30000; // pasted from the clipboard: the whole transcript fits

function excerpt(transcript, sentence, max) {
  if (!transcript || transcript.length <= max) return transcript || '';
  const at = Math.max(0, transcript.indexOf(sentence));
  const start = Math.max(0, Math.min(at - Math.floor(max / 2), transcript.length - max));
  return `…${transcript.slice(start, start + max)}…`;
}

// The question for ChatGPT / DeepSeek: explanation in the target language first,
// with example sentences, then the native-language version.
// input: {kind: 'word' | 'passage', term, sentence, transcript}
export function handoffPrompt(input, maxChars) {
  const L = langName(state.settings.lang), N = langName(state.settings.native);
  const ctx = excerpt(input.transcript, input.sentence, maxChars);
  const ask = input.kind === 'passage'
    ? `I don't fully understand this passage:\n\n"${input.term}"`
    : `I don't understand "${input.term}" in this sentence:\n\n"${input.sentence}"`;
  return `I'm learning ${L} (my native language is ${N}). It comes from a video I'm watching. ${ask}\n\n` +
    `Please answer in this order:\n` +
    `1. Explain it in simple ${L}, the way a teacher would explain it in ${L} (meaning here, a simpler paraphrase).\n` +
    `2. Explain the grammar or structure in simple ${L}.\n` +
    `3. Give 4 natural example sentences in ${L} that use ${input.kind === 'passage' ? 'the same structure' : 'it the same way'} (typical uses).\n` +
    `4. Then, under a heading "${N}", translate the explanation and the examples, and the ${input.kind === 'passage' ? 'passage' : 'sentence'}.` +
    `${ctx ? `\n\nTranscript, for context:\n"""\n${ctx}\n"""` : ''}`;
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

// Opens a ChatGPT temporary (private) chat — not saved in the history — with the
// question prefilled. Also copies it, in case the prefill isn't picked up.
export async function openChatGpt(input) {
  const text = handoffPrompt(input, CHATGPT_CONTEXT_CHARS);
  const copied = await copyText(text);
  window.open(`https://chatgpt.com/?temporary-chat=true&q=${encodeURIComponent(text)}`, '_blank', 'noopener');
  return { text, copied };
}

// DeepSeek's web chat is free but can't be prefilled: copy the question (with the
// whole transcript), then open it so the user can paste.
export async function openDeepSeek(input) {
  const text = handoffPrompt(input, DEEPSEEK_CONTEXT_CHARS);
  const copied = await copyText(text);
  window.open('https://chat.deepseek.com/', '_blank', 'noopener');
  return { text, copied };
}

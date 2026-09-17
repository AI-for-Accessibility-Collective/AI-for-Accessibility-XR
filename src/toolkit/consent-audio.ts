// audioConsent — the toolkit Consent port in the app's accessible modality
// (docs/PLAN.md §3.3): consent is SPOKEN through the glasses and mirrored as
// a card on the panels; the answer comes back by voice ("yes" / "not now")
// or a panel tap, whichever lands first.
//
// The toolkit core only ever calls notifyPending(); present()/capture() are
// the host-driven halves ensureGrant() and the insight beat use.
//
// Consent parsing is deliberately conservative: only a reply made entirely of
// yes-words grants anything. A hedge, a question, a negation next to "okay",
// or a longer sentence gets a re-ask (or, on a card nobody asked about just
// now, is simply not consent).

import type { ConsentPort, Proposal } from '@ai4a11y/toolkit';

export interface ConsentCard {
  id: string;
  kind: 'grant' | 'insight';
  title: string;
  body: string;
}

export interface ConsentIO {
  speak(text: string): Promise<void>;
  // Show (or clear, with null) the consent card on every attached panel.
  showCard(card: ConsentCard | null): void;
  // The next answer from the wearer: the session resolves this from EITHER
  // the STT stream's next utterance or a panel tap (taps arrive as the
  // literal strings 'yes' / 'not now'). null = timeout, no decision.
  nextUtterance(timeoutMs: number): Promise<string | null>;
  onPending?(count: number): void;
  // How long capture listens for each answer. Default 15 s.
  answerTimeoutMs?: number;
}

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/[‘’]/g, "'");
}

function wordsOnly(t: string): string {
  return t.replace(/[^a-z' ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const YES_PHRASES = /\b(?:all right|go ahead|go for it|please do|sounds good|of course|thank you|i don't mind|that(?:'s| is) (?:fine|okay|ok|good|alright|all right))\b/g;
const YES_WORDS = new Set(['yes', 'yeah', 'yep', 'yup', 'sure', 'ok', 'okay', 'alright', 'fine', 'absolutely', 'definitely']);
const NO_PHRASES = /\b(?:not now|not right now|not today|no thanks|no thank you|maybe later)\b/g;
const NO_WORDS = new Set(['no', 'nope', 'nah', 'later', 'never']);
const COURTESY = new Set(['please', 'thanks']);

// True when every word is an answer word of one polarity (courtesy words
// allowed alongside), with at least one real answer word.
function onlyAnswerWords(t: string, phrases: RegExp, words: Set<string>): boolean {
  const tokens = wordsOnly(t).replace(phrases, ' @ ').split(' ').filter(Boolean);
  return tokens.some((w) => w === '@' || words.has(w)) && tokens.every((w) => w === '@' || words.has(w) || COURTESY.has(w));
}

const isClearYes = (t: string) => onlyAnswerWords(t, YES_PHRASES, YES_WORDS);
const isClearNo = (t: string) => onlyAnswerWords(t, NO_PHRASES, NO_WORDS);

const UNCLEAR_RE = /\b(?:not sure|unsure|no idea|don't (?:know|understand)|what|which|how|why|repeat|again|pardon|sorry|wait|hold on|hang on|let me think|one (?:sec|second|moment)|you can say)\b/;
const QUESTION_START_RE = /^(?:is|are|can|could|do|does|did|will|would|should|shall|may|who|where|when)\b/;
const NO_WORD_RE = /\b(?:no|nope|nah|never|not now|later)\b/;
const NEGATION_RE = /\bnot\b|n't\b|\bcannot\b/;
const ANY_YES_RE = /\b(?:yes|yeah|yep|yup|sure|ok|okay|alright|all right|fine|go ahead)\b/;
const MAX_ANSWER_WORDS = 6;
const MAX_BARE_WORDS = 5;

// A reply to the question just asked → a proposal response, or null when it
// isn't clearly an answer (capture then re-asks once).
export function parseConsentAnswer(text: string | null): 'accept' | 'declineOnce' | null {
  if (!text) return null;
  const n = normalize(text);
  if (!n || n.includes('?')) return null;
  const t = wordsOnly(n);
  if (!t || QUESTION_START_RE.test(t) || UNCLEAR_RE.test(t)) return null;
  if (t.split(' ').length > MAX_ANSWER_WORDS) return null;
  if (NO_WORD_RE.test(t)) return 'declineOnce'; // "no" wins over an embedded "okay"
  if (isClearYes(t)) return 'accept';
  // "I'd rather not" is a no; "that's not okay" / "not so sure" are unclear.
  if (NEGATION_RE.test(t)) return ANY_YES_RE.test(t) ? null : 'declineOnce';
  return null;
}

// Stricter, for an utterance heard while a card is visible but nobody is
// listening for the answer: only a short, whole-utterance yes or no counts —
// "okay, start the washing machine" is a request, "Okay?" is a question back.
export function parseBareConsentAnswer(text: string): 'accept' | 'declineOnce' | null {
  const n = normalize(text);
  if (!n || n.includes('?')) return null;
  const t = wordsOnly(n);
  if (!t || t.split(' ').length > MAX_BARE_WORDS) return null;
  if (isClearYes(t)) return 'accept';
  if (isClearNo(t)) return 'declineOnce';
  return null;
}

function spokenCopy(item: { type: string; proposal: Proposal }): string {
  if (item.type === 'grant-request') {
    return (
      'Appliance Guide would like to read your accessibility profile — ' +
      'your needs, speech, and reading level — so it can guide you the way you prefer. Is that okay?'
    );
  }
  // cross-app-insight / generic proposal: the rationale is written for ears.
  return `${item.proposal.rationale} You can say yes, or not now.`;
}

export function audioConsent(io: ConsentIO): ConsentPort {
  const timeoutMs = io.answerTimeoutMs ?? 15_000;
  return {
    notifyPending(count: number) {
      io.onPending?.(count);
    },

    async present(item: { type: 'proposal' | 'grant-request' | 'cross-app-insight'; proposal: Proposal }) {
      io.showCard({
        id: item.proposal.id,
        kind: item.type === 'grant-request' ? 'grant' : 'insight',
        title: item.proposal.aspectLabel,
        body: item.proposal.rationale,
      });
      await io.speak(spokenCopy(item));
    },

    async capture(_proposalId: string): Promise<'accept' | 'declineOnce' | 'suppress' | null> {
      // Two chances to hear an answer; anything unparseable in between gets
      // one short clarifying re-ask. Panel taps arrive through the same
      // nextUtterance seam and win ties by simply being first.
      for (let attempt = 0; attempt < 2; attempt++) {
        const heard = await io.nextUtterance(timeoutMs);
        const answer = parseConsentAnswer(heard);
        if (answer) {
          io.showCard(null);
          return answer;
        }
        if (heard == null) break; // silence — leave the card up, no decision
        if (attempt === 0) await io.speak('Sorry — was that a yes or a no?');
      }
      return null;
    },
  };
}

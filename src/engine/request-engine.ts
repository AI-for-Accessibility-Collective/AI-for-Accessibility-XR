// Request/response conversational engine — now central (docs/PLAN.md §2):
// every content turn in BOTH modes goes through here. No streaming, no Live
// API; film-day reliability over latency.
//
// Rebuilt from the old draft's RequestEngine with three deliberate changes:
//   - turn() RETURNS the reply text instead of speaking it (the speaker owns
//     delivery — the whole A/B rests on that separation);
//   - the conversation keeps its own history as an explicit contents array
//     and passes systemInstruction per call;
//   - requests go over gemini-rest.ts (direct REST), not the deprecated SDK,
//     which stripped thinkingConfig and let thought tokens truncate replies.
//
// Temperature comes from LLM_TEMPERATURE (default 0.2 — §5.2 determinism).

import type { FrameEntry } from '../transport/frames.ts';
import type { TurnEngine } from './engine.ts';
import { generateContent, type GeminiContent, type GeminiPart } from './gemini-rest.ts';

// Room for a full spoken reply plus Gemini 3.x thought tokens, which bill
// against this cap (gemini-rest.ts header). Brevity comes from the prompt.
export const TURN_MAX_OUTPUT_TOKENS = 1024;

export interface ConversationOpts {
  apiKey: string;
  model: string;
  systemInstruction: string;
  temperature?: number;
  maxOutputTokens?: number;
  // Cap on retained turns (user+model pairs), so a long rehearsal session
  // doesn't grow the prompt without bound.
  maxHistoryTurns?: number;
  // The reply as it is being written, so a caller can start making the voice
  // for its first sentences before the model has finished the last.
  onPartial?: (soFar: string) => void;
  // Tools the model may call mid-turn (function declarations), and what runs
  // them. The handler's `result` goes back to the model, which then writes
  // the spoken reply; `standing` is kept as an instruction for the rest of
  // this conversation (a running task's prompt was fixed when it began).
  tools?: readonly unknown[];
  onToolCall?: (name: string, args: Record<string, unknown>) => Promise<{ result: string; standing?: string }>;
}

export function createConversation(opts: ConversationOpts, fetchImpl?: typeof fetch): TurnEngine {
  let history: GeminiContent[] = [];
  let chain: Promise<unknown> = Promise.resolve();
  const standing: string[] = [];
  const instruction = (): string =>
    standing.length ? `${opts.systemInstruction}\n\nSTANDING INSTRUCTIONS FROM THE WEARER (these override the profile above):\n${standing.map((s) => `- ${s}`).join('\n')}` : opts.systemInstruction;

  async function oneTurn(text: string, frames?: FrameEntry[]): Promise<string> {
    const parts: GeminiPart[] = [];
    for (const f of frames ?? []) {
      parts.push({ inlineData: { mimeType: 'image/jpeg', data: f.jpeg.toString('base64') } });
    }
    parts.push({ text });

    const ask = (contents: GeminiContent[], offerTools: boolean) =>
      generateContent(
        {
          apiKey: opts.apiKey,
          model: opts.model,
          systemInstruction: instruction(),
          contents,
          maxOutputTokens: opts.maxOutputTokens ?? TURN_MAX_OUTPUT_TOKENS,
          temperature: opts.temperature ?? 0.2,
          onText: opts.onPartial,
          tools: offerTools ? opts.tools : undefined,
        },
        fetchImpl,
      );
    const asked: GeminiContent[] = [...history, { role: 'user', parts }];
    let result = await ask(asked, !!opts.onToolCall);
    // The model asked for a tool: run it, hand back what happened, and let it
    // write the spoken reply with that in hand. One round only — the second
    // request offers no tools, so it must answer in words.
    if (result.toolCalls?.length && opts.onToolCall) {
      const responses: GeminiPart[] = [];
      for (const call of result.toolCalls) {
        let outcome: { result: string; standing?: string };
        try {
          outcome = await opts.onToolCall(call.name, call.args);
        } catch (e) {
          outcome = { result: `That did not work: ${e instanceof Error ? e.message : String(e)}. Tell them, briefly, and carry on.` };
        }
        if (outcome.standing) standing.push(outcome.standing);
        responses.push({ functionResponse: { name: call.name, response: { result: outcome.result } } });
      }
      result = await ask(
        [...asked, { role: 'model', parts: result.toolCalls.map((c) => c.part) }, { role: 'user', parts: responses }],
        false,
      );
    }
    if (result.finishReason !== 'STOP') {
      console.warn(`[engine] non-STOP finish: ${result.finishReason} (thoughts=${result.thoughtTokens})`);
    }

    // History keeps the TEXT of the exchange only — re-sending every past
    // frame each turn would balloon cost for no guidance benefit. An empty
    // reply (blocked prompt, safety stop, exhausted budget) is left out
    // entirely: the API rejects a model turn with empty text, which would
    // break every later turn of this conversation.
    if (result.text) {
      history.push({ role: 'user', parts: [{ text }] });
      history.push({ role: 'model', parts: [{ text: result.text }] });
      const maxTurns = opts.maxHistoryTurns ?? 24;
      if (history.length > maxTurns * 2) history = history.slice(-maxTurns * 2);
    }

    return result.text;
  }

  return {
    turn(text: string, frames?: FrameEntry[]): Promise<string> {
      const p = chain.then(
        () => oneTurn(text, frames),
        () => oneTurn(text, frames),
      );
      chain = p.catch(() => {});
      return p;
    },
    reset(): void {
      history = [];
    },
  };
}

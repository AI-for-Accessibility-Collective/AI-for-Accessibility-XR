// Direct REST client for Gemini generateContent — the one place a content
// request is built. tts.ts already talks REST; this brings the text/vision
// turns onto the same path and off the deprecated @google/generative-ai SDK,
// which silently STRIPS unknown generationConfig keys (thinkingConfig
// included), so thinking could never even be requested off through it.
//
// Thinking, probed across the key's models 2026-09-14:
//   - thought tokens BILL AGAINST maxOutputTokens on every 3.x model;
//   - thinkingBudget:0 is honored by some models (3.5-flash: ~1 s, 0 thoughts),
//     merely advisory on others (3.8-flash still thinks ~200–350 tokens), and
//     REJECTED by the rest with HTTP 400 — pro models ("Budget 0 is invalid.
//     This model only works in thinking mode") and some flash versions (a
//     bare "Request contains an invalid argument").
// So each request walks a ladder — budget 0 → thinkingLevel low → the model's
// default — and the first rung a model accepts is remembered for the process,
// making a rejection cost one extra request per model, not per turn. Callers
// still size maxOutputTokens with thought headroom; on the model-default rung
// the cap is raised further because thinking-only models can reason for
// thousands of tokens before the first word. The cap is a runaway guard, not
// a brevity control — brevity comes from the prompt, and a cap that bites
// truncates speech mid-sentence.
//
// The API key travels in the x-goog-api-key header, never the URL: runtime
// fetch errors carry the request URL (Bun sets it on `error.path`), and any
// error that escapes would print it. Every failure leaving this function —
// the request, reading the body, parsing it — is a plain Error whose message
// is built here, with the key redacted.
//
// Spending controls: every Gemini request in the app (these turns and
// tts.ts) goes through guardedRequest(). haltGemini() refuses every later
// request and cancels the ones in flight — the Stop path. abortInFlightGemini()
// only cancels what is running — the pause path. And the runaway guard halts
// Gemini on its own when requests pile up faster than any real take needs,
// which is what an echo loop or a stuck retry looks like.

export interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

export interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

export interface GenerateOpts {
  apiKey: string;
  model: string;
  systemInstruction?: string;
  contents: GeminiContent[];
  maxOutputTokens: number;
  temperature: number;
  // Per-request deadline. Defaults: 30 s, or 90 s on the model-default rung.
  timeoutMs?: number;
  // When set, the answer is streamed and this is called with the text so far
  // as it grows. The resolved result is the same either way.
  onText?: (soFar: string) => void;
}

export type ThinkingRung = 'budget0' | 'level-low' | 'model-default';

export interface GenerateResult {
  text: string;
  // The candidate's finishReason, or BLOCKED_<reason> when the prompt itself
  // was blocked (HTTP 200 with promptFeedback and no candidates).
  finishReason: string;
  thoughtTokens: number;
  thinking: ThinkingRung;
}

// ---- stop switch + runaway guard ------------------------------------------------

export interface GeminiGuardOpts {
  maxPerMinute: number;
  maxPerRun: number;
  // Called once, when the guard halts Gemini, so the host can pause and say why.
  onHalt?: (reason: string) => void;
}

const DEFAULT_GUARD: GeminiGuardOpts = { maxPerMinute: 40, maxPerRun: 800 };
const guard: GeminiGuardOpts = { ...DEFAULT_GUARD };
let haltReason: string | null = null;
let callsThisRun = 0;
let recentCalls: number[] = [];
const inFlight = new Set<AbortController>();

class GeminiStopped extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'GeminiStopped';
  }
}

export function configureGeminiGuard(opts: Partial<GeminiGuardOpts>): void {
  Object.assign(guard, opts);
}

// Refuse every later Gemini request and cancel the ones in flight.
export function haltGemini(reason: string): void {
  if (!haltReason) haltReason = reason;
  abortInFlightGemini(reason);
}

// Cancel what is in flight; later requests still go out.
export function abortInFlightGemini(reason: string): void {
  for (const controller of inFlight) controller.abort(new GeminiStopped(reason));
  inFlight.clear();
}

export function geminiHaltReason(): string | null {
  return haltReason;
}

export function resetGeminiGuard(): void {
  haltReason = null;
  callsThisRun = 0;
  recentCalls = [];
  inFlight.clear();
  Object.assign(guard, DEFAULT_GUARD, { onHalt: undefined });
}

// Admit one outgoing request, or throw if Gemini is stopped or the guard
// trips. Pass `signal` to fetch and call `release` once the body is read.
export function guardedRequest(timeoutMs: number): { signal: AbortSignal; release: () => void } {
  if (haltReason) throw new Error(`Gemini is stopped (${haltReason})`);
  const now = Date.now();
  recentCalls = recentCalls.filter((t) => now - t < 60_000);
  const reason =
    recentCalls.length >= guard.maxPerMinute
      ? `${recentCalls.length} Gemini requests in the last minute reached the limit of ${guard.maxPerMinute} — something may be looping`
      : callsThisRun >= guard.maxPerRun
        ? `${callsThisRun} Gemini requests this run reached the limit of ${guard.maxPerRun}`
        : null;
  if (reason) {
    haltGemini(reason);
    guard.onHalt?.(reason);
    throw new Error(`Gemini is stopped (${reason})`);
  }
  recentCalls.push(now);
  callsThisRun++;
  const controller = new AbortController();
  inFlight.add(controller);
  return {
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]),
    release: () => void inFlight.delete(controller),
  };
}

// ---- generateContent ----------------------------------------------------------------

const LADDER: Array<{ rung: ThinkingRung; config: Record<string, unknown> | null }> = [
  { rung: 'budget0', config: { thinkingBudget: 0 } },
  { rung: 'level-low', config: { thinkingLevel: 'low' } },
  { rung: 'model-default', config: null },
];

const MODEL_DEFAULT_MIN_OUTPUT_TOKENS = 8192;
const TIMEOUT_MS = 30_000;
const MODEL_DEFAULT_TIMEOUT_MS = 90_000;

// model id → index of the first LADDER rung that model accepted.
const acceptedRung = new Map<string, number>();

export function resetThinkingCache(): void {
  acceptedRung.clear();
}

export function redactKey(text: string, key: string): string {
  return key ? text.split(key).join('[key]') : text;
}

function failure(model: string, key: string, timeoutMs: number, what: string, e: unknown): Error {
  if (e instanceof GeminiStopped) return new Error(`gemini ${model} stopped: ${e.message}`);
  const name = e instanceof Error || e instanceof DOMException ? e.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') return new Error(`gemini ${model} timed out after ${timeoutMs} ms`);
  const message = e instanceof Error ? e.message : String(e);
  return new Error(`gemini ${model} ${what}: ${redactKey(message, key)}`);
}

// One streamed response (server-sent events, one JSON chunk per `data:` line)
// folded into the shape a plain response has, with the text so far reported
// as each chunk lands.
async function readStream(res: Response, onText: (soFar: string) => void): Promise<any> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let text = '';
  let last: any = null;
  const take = (line: string): void => {
    if (!line.startsWith('data:')) return;
    const chunk = JSON.parse(line.slice(5).trim());
    last = chunk;
    const parts: any[] = chunk?.candidates?.[0]?.content?.parts ?? [];
    const piece = parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('');
    if (piece) {
      text += piece;
      onText(text);
    }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffered.indexOf('\n')) >= 0) {
      take(buffered.slice(0, nl).trim());
      buffered = buffered.slice(nl + 1);
    }
  }
  if (buffered.trim()) take(buffered.trim());
  return { ...last, candidates: [{ ...last?.candidates?.[0], content: { parts: [{ text }] } }] };
}

export async function generateContent(opts: GenerateOpts, fetchImpl: typeof fetch = fetch): Promise<GenerateResult> {
  const url = opts.onText
    ? `https://generativelanguage.googleapis.com/v1beta/models/${opts.model}:streamGenerateContent?alt=sse`
    : `https://generativelanguage.googleapis.com/v1beta/models/${opts.model}:generateContent`;
  let index = acceptedRung.get(opts.model) ?? 0;
  let firstRejection = '';

  for (;;) {
    const { rung, config } = LADDER[index]!;
    const generationConfig: Record<string, unknown> = {
      maxOutputTokens: config ? opts.maxOutputTokens : Math.max(opts.maxOutputTokens, MODEL_DEFAULT_MIN_OUTPUT_TOKENS),
      temperature: opts.temperature,
    };
    if (config) generationConfig.thinkingConfig = config;
    const body: Record<string, unknown> = { contents: opts.contents, generationConfig };
    if (opts.systemInstruction) body.systemInstruction = { parts: [{ text: opts.systemInstruction }] };
    const timeoutMs = opts.timeoutMs ?? (config ? TIMEOUT_MS : MODEL_DEFAULT_TIMEOUT_MS);

    const request = guardedRequest(timeoutMs);
    try {
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': opts.apiKey },
          body: JSON.stringify(body),
          signal: request.signal,
        });
      } catch (e) {
        throw failure(opts.model, opts.apiKey, timeoutMs, 'request failed', request.signal.reason ?? e);
      }

      if (res.ok) {
        let data: any;
        try {
          data = opts.onText ? await readStream(res, opts.onText) : await res.json();
        } catch (e) {
          throw failure(opts.model, opts.apiKey, timeoutMs, 'unreadable response', request.signal.reason ?? e);
        }
        if (acceptedRung.get(opts.model) !== index) {
          if (index > 0) console.warn(`[gemini] ${opts.model}: using thinking rung '${rung}' (earlier rungs rejected)`);
          acceptedRung.set(opts.model, index);
        }
        const candidate = data?.candidates?.[0];
        const parts: any[] = candidate?.content?.parts ?? [];
        const blockReason = data?.promptFeedback?.blockReason;
        return {
          text: parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('').trim(),
          finishReason: blockReason ? `BLOCKED_${blockReason}` : String(candidate?.finishReason ?? 'UNKNOWN'),
          thoughtTokens: Number(data?.usageMetadata?.thoughtsTokenCount ?? 0),
          thinking: rung,
        };
      }

      let detail: string;
      try {
        detail = redactKey((await res.text()).slice(0, 300), opts.apiKey);
      } catch (e) {
        throw failure(opts.model, opts.apiKey, timeoutMs, `HTTP ${res.status} with an unreadable body`, request.signal.reason ?? e);
      }
      if (res.status === 400 && config && index < LADDER.length - 1) {
        firstRejection ||= detail;
        index++;
        continue;
      }
      const ladderNote = firstRejection ? ` (thinking fallback exhausted; first rejection: ${firstRejection.slice(0, 120)})` : '';
      throw new Error(`gemini ${opts.model} HTTP ${res.status}${ladderNote}: ${detail}`);
    } finally {
      request.release();
    }
  }
}

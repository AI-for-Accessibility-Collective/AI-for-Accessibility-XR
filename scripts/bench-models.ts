#!/usr/bin/env bun
// Model bench — runs the app's OWN prompts against candidate Gemini models so
// a model is picked on evidence, not recency (docs/CHECKING.md §5).
//
//   bun scripts/bench-models.ts --models gemini-3.5-flash,gemini-3.9-flash [--out bench-out]
//
// Per model: the baseline answer + a follow-up (3 runs), the toolkit opening
// (3), a full stepwise walkthrough driven by "done" (2), the camera check on
// the dial fixtures (3 yes + 3 no), the bill read through readVisibleText (2)
// and the toolkit bill gist (2). Writes <out>/results.json (named),
// <out>/blind/*.md (letters only — hand ONLY this directory to judges) and
// <out>/key.json (letter → model). Prints a latency/accuracy summary.
// Requests mirror src/engine/gemini-rest.ts's thinking ladder.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AbilityModel } from '@ai4a11y/toolkit';
import { config } from '../src/config.ts';
import { composePrompt } from '../src/skills/compose.ts';
import { profilePromptBlock } from '../src/toolkit/prompt-block.ts';
import { renderAudioSettings } from '../src/audio/render.ts';
import { readTextAloud, readVisibleText } from '../src/skills/builtin/read-text-aloud.ts';
import { isCompletionReply, parseVerifyAnswer, verifyQuestion, VERIFY_MAX_OUTPUT_TOKENS } from '../src/skills/builtin/task-guide.ts';
import { TURN_MAX_OUTPUT_TOKENS } from '../src/engine/request-engine.ts';
import type { Task } from '../src/skills/types.ts';
import washing from '../src/tasks/washing-machine.json';
import fixture from '../test/fixtures/margaret.blob.json';

const ROOT = resolve(import.meta.dir, '..');
const FIXTURES = join(ROOT, 'test/fixtures');
const argOf = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const MODELS = (argOf('models') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const OUT = resolve(ROOT, argOf('out') ?? 'bench-out');
if (!config.geminiApiKey) throw new Error('GEMINI_API_KEY is not set (see .env.example)');
if (!MODELS.length) {
  console.error('usage: bun scripts/bench-models.ts --models <id,id,...> [--out bench-out]');
  process.exit(2);
}

// ---- the app's real prompts -------------------------------------------------------
const task = washing as Task;
const margaret = fixture.abilityModel as AbilityModel;
const render = renderAudioSettings(margaret);
const block = profilePromptBlock(margaret, render);
const SI_BASELINE_TASK = composePrompt({ task, profileBlock: '' });
const SI_TOOLKIT_TASK = composePrompt({ task, profileBlock: block });
const SI_TOOLKIT_CHAT = composePrompt({ profileBlock: block, extra: [readTextAloud.promptBlock ?? ''] });
const OPEN = 'Hello? Can you help me start the washing machine? I want to wash my cottons at forty degrees.';
const FOLLOW = 'Wait, which hole does the soap go in?';
const DONE = "Done. What's the next step?";
const BILL_TEXT = readFileSync(join(FIXTURES, 'bill.txt'), 'utf8').trim();
const IMG = {
  dialYes: readFileSync(join(FIXTURES, 'dial-cottons.jpg')).toString('base64'),
  dialNo: readFileSync(join(FIXTURES, 'dial-synthetics.jpg')).toString('base64'),
  bill: readFileSync(join(FIXTURES, 'bill.jpg')),
};

// ---- transport (mirrors gemini-rest.ts, plus timing + model version) ---------------
type Call = { ms: number; finish: string; thoughts: number; text: string; thinking: string; version?: string; error?: string };
const LADDER: Array<[string, object | null]> = [
  ['budget0', { thinkingBudget: 0 }],
  ['level-low', { thinkingLevel: 'low' }],
  ['model-default', null],
];
const rungOf = new Map<string, number>();

async function call(model: string, req: { si?: string; contents: any[]; max: number; temp: number }): Promise<Call> {
  let rung = rungOf.get(model) ?? 0;
  let lastErr = '';
  for (let attempt = 0; attempt < 8; attempt++) {
    const [mode, cfg] = LADDER[rung]!;
    const generationConfig: any = { maxOutputTokens: cfg ? req.max : Math.max(req.max, 8192), temperature: req.temp };
    if (cfg) generationConfig.thinkingConfig = cfg;
    const body: any = { contents: req.contents, generationConfig };
    if (req.si) body.systemInstruction = { parts: [{ text: req.si }] };
    const t0 = performance.now();
    let res: Response;
    try {
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.geminiApiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      await Bun.sleep(2000 * (attempt + 1));
      continue;
    }
    const ms = Math.round(performance.now() - t0);
    if (res.status === 400) {
      const detail = (await res.text()).slice(0, 300);
      if (cfg && rung < LADDER.length - 1) {
        rung++;
        continue;
      }
      return { ms, finish: 'HTTP400', thoughts: 0, text: '', thinking: mode, error: detail };
    }
    if (res.status === 429 || res.status >= 500) {
      lastErr = `HTTP ${res.status}`;
      await Bun.sleep(4000 * (attempt + 1));
      continue;
    }
    if (!res.ok) return { ms, finish: `HTTP${res.status}`, thoughts: 0, text: '', thinking: mode, error: (await res.text()).slice(0, 300) };
    rungOf.set(model, rung);
    const d: any = await res.json();
    const c = d?.candidates?.[0] ?? {};
    return {
      ms,
      finish: String(c.finishReason ?? 'NONE'),
      thoughts: Number(d?.usageMetadata?.thoughtsTokenCount ?? 0),
      text: (c?.content?.parts ?? []).map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('').trim(),
      thinking: mode,
      version: d?.modelVersion,
    };
  }
  return { ms: 0, finish: 'FAILED', thoughts: 0, text: '', thinking: LADDER[rung]![0], error: lastErr };
}

const user = (text: string) => ({ role: 'user', parts: [{ text }] });
const modelTurn = (text: string) => ({ role: 'model', parts: [{ text: text || '(no reply)' }] });
const words = (t: string) => (t.trim() ? t.trim().split(/\s+/).length : 0);

// ---- scenarios ---------------------------------------------------------------------
async function runModel(model: string) {
  const out: any = { model, S1: [], S2: [], S3: [], S4: [], S5: [], S6: [], S7: [] };

  for (let i = 0; i < 3; i++) {
    const open = await call(model, { si: SI_BASELINE_TASK, contents: [user(OPEN)], max: TURN_MAX_OUTPUT_TOKENS, temp: config.llmTemperature });
    const follow = open.error
      ? null
      : await call(model, { si: SI_BASELINE_TASK, contents: [user(OPEN), modelTurn(open.text), user(FOLLOW)], max: TURN_MAX_OUTPUT_TOKENS, temp: config.llmTemperature });
    out.S1.push({ open, follow });
  }

  for (let i = 0; i < 3; i++) {
    out.S2.push(await call(model, { si: SI_TOOLKIT_TASK, contents: [user(OPEN)], max: TURN_MAX_OUTPUT_TOKENS, temp: config.llmTemperature }));
  }

  for (let i = 0; i < 2; i++) {
    const history: any[] = [];
    const turns: any[] = [];
    let said = OPEN;
    for (let t = 0; t < 9; t++) {
      const r = await call(model, { si: SI_TOOLKIT_TASK, contents: [...history, user(said)], max: TURN_MAX_OUTPUT_TOKENS, temp: config.llmTemperature });
      turns.push({ user: said, ...r });
      if (r.error) break;
      history.push(user(said), modelTurn(r.text));
      if (isCompletionReply(r.text)) break;
      said = DONE;
    }
    out.S3.push({ turns, completed: isCompletionReply(turns.at(-1)?.text ?? '') });
  }

  const verify = async (data: string) => {
    const r = await call(model, {
      contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/jpeg', data } }, { text: verifyQuestion(task.verify![0]!.prompt) }] }],
      max: VERIFY_MAX_OUTPUT_TOKENS,
      temp: 0,
    });
    return { ...r, parsed: parseVerifyAnswer(r.text) };
  };
  for (let i = 0; i < 3; i++) out.S4.push(await verify(IMG.dialYes));
  for (let i = 0; i < 3; i++) out.S5.push(await verify(IMG.dialNo));

  for (let i = 0; i < 2; i++) {
    let last: Call | null = null;
    const vision = {
      generate: async (q: any) => {
        const parts: any[] = [];
        for (const f of q.frames ?? []) parts.push({ inlineData: { mimeType: 'image/jpeg', data: f.jpeg.toString('base64') } });
        parts.push({ text: q.text });
        last = await call(model, { si: q.systemInstruction, contents: [{ role: 'user', parts }], max: q.maxOutputTokens ?? 800, temp: q.temperature ?? 0.3 });
        return last.text;
      },
    };
    const result = await readVisibleText({ frames: [{ jpeg: IMG.bill, timestamp: 0 }], vision: vision as any });
    const txt = result?.text ?? '';
    out.S6.push({
      call: last,
      result,
      checks: {
        amount: /(?<![\d.])\$?42\.17(?!\d)/.test(txt),
        dueDate: /September 30, 2026/.test(txt),
        sender: /Riverside Water (?:&|and) Power/i.test(txt),
        phone: /1-800-555-0142/.test(txt),
        lateFee: /\$?5\.00/.test(txt),
        kindBill: result?.kind === 'bill',
      },
    });
  }

  for (let i = 0; i < 2; i++) {
    const r = await call(model, {
      si: SI_TOOLKIT_CHAT,
      contents: [user(`The camera just read this bill the user is holding up. Its verbatim text: """${BILL_TEXT}""" — tell the user about it, following your delivery directives.`)],
      max: TURN_MAX_OUTPUT_TOKENS,
      temp: config.llmTemperature,
    });
    out.S7.push({ ...r, checks: { amount: /42\.17|forty[- ]two/i.test(r.text), due: /September\s+(30|thirtieth)/i.test(r.text), words: words(r.text) } });
  }
  return out;
}

// ---- run + write ---------------------------------------------------------------------
const started = performance.now();
const results = await Promise.all(
  MODELS.map(async (m) => {
    const r = await runModel(m);
    console.log(`[bench] ${m} done (${Math.round((performance.now() - started) / 1000)} s)`);
    return r;
  }),
);

mkdirSync(join(OUT, 'blind'), { recursive: true });
writeFileSync(join(OUT, 'results.json'), JSON.stringify({ SI_BASELINE_TASK, SI_TOOLKIT_TASK, SI_TOOLKIT_CHAT, BILL_TEXT, results }, null, 2));

// Blind letters: a deterministic shuffle so letter order ≠ the --models order.
const hash = (s: string) => [...s].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);
const order = [...MODELS].sort((a, b) => hash(a) - hash(b));
const letter = new Map(order.map((m, i) => [m, String.fromCharCode(65 + i)]));
writeFileSync(join(OUT, 'key.json'), JSON.stringify(Object.fromEntries(letter), null, 2));

const byLetter = [...results].sort((a, b) => letter.get(a.model)!.localeCompare(letter.get(b.model)!));
const meta = (c: Call | null) => (c ? `${c.ms} ms · finish ${c.finish} · ${words(c.text)} words${c.error ? ` · ERROR ${c.error}` : ''}` : 'n/a');
const quote = (t: string) => '> ' + (t || '(empty)').replace(/\n/g, '\n> ');

let md = `# S1 — BASELINE mode (no profile block)\n\nThe wearer asks the opening question, then a follow-up. This is the "unadapted model" take of the A/B film: it should be a natural, competent, honest assistant answer — NOT deliberately bad.\n\nSystem instruction:\n\n\`\`\`\n${SI_BASELINE_TASK}\n\`\`\`\n\nUser: "${OPEN}" then "${FOLLOW}"\n`;
for (const r of byLetter) {
  md += `\n## Model ${letter.get(r.model)}\n`;
  r.S1.forEach((x: any, i: number) => {
    md += `\n**Run ${i + 1} — opening** (${meta(x.open)})\n\n${quote(x.open.text)}\n\n**Run ${i + 1} — follow-up** (${meta(x.follow)})\n\n${quote(x.follow?.text ?? '')}\n`;
  });
}
writeFileSync(join(OUT, 'blind/S1-baseline.md'), md);

md = `# S2 — TOOLKIT mode, opening turn\n\nThe same question with the profile block appended (the toolkit's INPUT injection). The block asks for: exactly ONE next action then stop; sentences under ~18 words; plain everyday words, no manual jargon; calm unhurried phrasing with one short warm confirmation.\n\nSystem instruction:\n\n\`\`\`\n${SI_TOOLKIT_TASK}\n\`\`\`\n\nUser: "${OPEN}"\n`;
for (const r of byLetter) {
  md += `\n## Model ${letter.get(r.model)}\n`;
  r.S2.forEach((x: Call, i: number) => (md += `\n**Run ${i + 1}** (${meta(x)})\n\n${quote(x.text)}\n`));
}
writeFileSync(join(OUT, 'blind/S2-toolkit-open.md'), md);

md = `# S3 — TOOLKIT mode, full stepwise walkthrough\n\nSame system instruction as S2. After each reply the wearer says "${DONE}". A correct walkthrough covers, in a sensible order: soap into the biggest (left) section of the top-left drawer → the dial to Cottons → temperature to 40 → press and HOLD Start about 2 seconds until the light comes on — one action per turn, plain words — then clearly says it's finished. Stops when the app's own completion check fires; capped at 9 turns.\n`;
for (const r of byLetter) {
  md += `\n## Model ${letter.get(r.model)}\n`;
  r.S3.forEach((run: any, i: number) => {
    md += `\n### Run ${i + 1} — ${run.turns.length} turns · completion detected: ${run.completed}\n`;
    run.turns.forEach((t: any, k: number) => (md += `\n${k + 1}. user: "${t.user}" → (${meta(t)})\n\n${quote(t.text)}\n`));
  });
}
writeFileSync(join(OUT, 'blind/S3-toolkit-walkthrough.md'), md);

md = `# S4/S5 — camera check · S6 — bill read · S7 — bill gist\n\nS4: the dial pointing at COTTONS (correct: yes). S5: the dial pointing at SYNTHETICS (correct: no). Question: "${verifyQuestion(task.verify![0]!.prompt)}"\n\nS6: a photo of a fabricated bill, read verbatim through the app's readVisibleText. Ground truth:\n\n\`\`\`\n${BILL_TEXT}\n\`\`\`\n\nS7: the toolkit chat instruction (gist first, plain words, short sentences, calm) given that ground-truth text. A good reply leads with a one-sentence gist (who it's from, how much, by when), keeps amounts and dates EXACT, and offers details rather than reciting them.\n\nToolkit chat system instruction:\n\n\`\`\`\n${SI_TOOLKIT_CHAT}\n\`\`\`\n`;
for (const r of byLetter) {
  md += `\n## Model ${letter.get(r.model)}\n\nS4 (expect yes): ${r.S4.map((x: any) => `${x.parsed} [${x.ms} ms, ${x.finish}, raw "${x.text}"]`).join(' · ')}\n\nS5 (expect no): ${r.S5.map((x: any) => `${x.parsed} [${x.ms} ms, ${x.finish}, raw "${x.text}"]`).join(' · ')}\n`;
  r.S6.forEach((x: any, i: number) => (md += `\nS6 run ${i + 1} (${meta(x.call)}) checks ${JSON.stringify(x.checks)}\n\n${quote(x.result?.text ?? '(nothing read)')}\n`));
  r.S7.forEach((x: any, i: number) => (md += `\nS7 run ${i + 1} (${meta(x)})\n\n${quote(x.text)}\n`));
}
writeFileSync(join(OUT, 'blind/S4-S7-vision-read-gist.md'), md);

// ---- named summary --------------------------------------------------------------------
const percentile = (xs: number[], p: number) => {
  const s = xs.filter((x) => x > 0).sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]! : 0;
};
console.log('\nmodel                    | letter | thinking      | p50 ms | p90 ms | non-STOP | walkthrough turns | verify yes/no | bill read | gist amount+due');
for (const r of results) {
  const textCalls: Call[] = [...r.S1.flatMap((x: any) => [x.open, x.follow].filter(Boolean)), ...r.S2, ...r.S3.flatMap((x: any) => x.turns), ...r.S7];
  const allCalls: Call[] = [...textCalls, ...r.S4, ...r.S5, ...r.S6.map((x: any) => x.call).filter(Boolean)];
  const ms = textCalls.map((c) => c.ms);
  const walk = r.S3.map((x: any) => `${x.turns.length}${x.completed ? '✓' : '✗'}`).join(', ');
  const readOk = r.S6.map((x: any) => `${Object.values(x.checks).filter(Boolean).length}/6`).join(', ');
  const gist = r.S7.map((x: any) => (x.checks.amount && x.checks.due ? '✓' : '✗')).join(', ');
  console.log(
    `${r.model.padEnd(24)} | ${letter.get(r.model)!.padEnd(6)} | ${(r.S2[0]?.thinking ?? '?').padEnd(13)} | ${String(percentile(ms, 50)).padStart(6)} | ${String(percentile(ms, 90)).padStart(6)} | ${String(allCalls.filter((c) => c.finish !== 'STOP').length).padStart(8)} | ${walk.padEnd(17)} | ${r.S4.filter((x: any) => x.parsed === 'yes').length}/3 ${r.S5.filter((x: any) => x.parsed === 'no').length}/3       | ${readOk.padEnd(9)} | ${gist}`,
  );
}
console.log(`\n[bench] wrote ${OUT}/results.json, ${OUT}/blind/*.md (judge these) and ${OUT}/key.json (keep from judges) in ${Math.round((performance.now() - started) / 1000)} s`);

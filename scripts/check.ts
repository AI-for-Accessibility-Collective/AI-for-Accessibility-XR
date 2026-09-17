#!/usr/bin/env bun
// bun run check — the system check (docs/CHECKING.md). Three levels:
//
//   offline  always    environment, secrets, toolkit dependency (installed,
//                      pinned, untouched, identical to the sibling), typecheck,
//                      unit tests, the toolkit's own demo, the profile pipeline
//   live     default   the configured Gemini models on the app's REAL prompts:
//                      text turns (baseline + toolkit), conversation memory,
//                      camera verification on the dial fixtures, the bill read,
//                      laptop TTS — skipped with --offline or without a key
//   rig      --rig     boots the demo harness on spare ports with a temp store
//                      and drives the whole A/B film over HTTP, beat by beat
//
// Exit code is 1 when any check FAILS; warnings never fail the run. Never
// touches ./data, the onboarding service's store, or the toolkit.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { AbilityModel } from '@ai4a11y/toolkit';
import { config } from '../src/config.ts';
import { generateContent } from '../src/engine/gemini-rest.ts';
import { createConversation, TURN_MAX_OUTPUT_TOKENS } from '../src/engine/request-engine.ts';
import { VisionClient } from '../src/engine/vision.ts';
import { synthesizeSpeech } from '../src/engine/tts.ts';
import { renderAudioSettings } from '../src/audio/render.ts';
import { styleLine } from '../src/audio/gemini-style.ts';
import { profilePromptBlock } from '../src/toolkit/prompt-block.ts';
import { BASE_PERSONA, composePrompt } from '../src/skills/compose.ts';
import { readVisibleText } from '../src/skills/builtin/read-text-aloud.ts';
import { parseVerifyAnswer, verifyQuestion, VERIFY_MAX_OUTPUT_TOKENS } from '../src/skills/builtin/task-guide.ts';
import { generateTaskBrief } from '../src/skills/task-brief.ts';
import type { Task } from '../src/skills/types.ts';
import washingMachine from '../src/tasks/washing-machine.json';
import fixture from '../test/fixtures/margaret.blob.json';

const ROOT = resolve(import.meta.dir, '..');
// The one toolkit this app consumes: the Collective's repo, checked out as a
// sibling. Any other remote (a fork, a draft) fails the pin check.
const TOOLKIT_REPO = resolve(ROOT, '../AI-for-Accessibility-Toolkit');
const TOOLKIT_REMOTE = 'AI-for-Accessibility-Collective/AI-for-Accessibility-Toolkit';
const PINNED_TOOLKIT_COMMIT = 'a71b34a';
const FIXTURES = join(ROOT, 'test/fixtures');
const RIG_APP_PORT = 3900;
const RIG_DEMO_PORT = 3901;

const argv = process.argv.slice(2);
const OFFLINE = argv.includes('--offline');
const RIG = argv.includes('--rig');

// ---- reporting ------------------------------------------------------------------

type Status = 'pass' | 'warn' | 'fail' | 'skip';
interface Outcome {
  status: Status;
  detail: string;
}
const ICON: Record<Status, string> = { pass: '✓', warn: '!', fail: '✗', skip: '-' };
const tally: Record<Status, number> = { pass: 0, warn: 0, fail: 0, skip: 0 };
const failures: string[] = [];

const pass = (detail: string): Outcome => ({ status: 'pass', detail });
const warn = (detail: string): Outcome => ({ status: 'warn', detail });
const fail = (detail: string): Outcome => ({ status: 'fail', detail });
const skip = (detail: string): Outcome => ({ status: 'skip', detail });

async function check(name: string, fn: () => Promise<Outcome> | Outcome): Promise<Outcome> {
  const t0 = performance.now();
  let o: Outcome;
  try {
    o = await fn();
  } catch (e) {
    o = fail(e instanceof Error ? e.message : String(e));
  }
  tally[o.status]++;
  if (o.status === 'fail') failures.push(`${name}: ${o.detail}`);
  const secs = o.status === 'skip' ? '' : `  (${((performance.now() - t0) / 1000).toFixed(1)}s)`;
  console.log(`  ${ICON[o.status]} ${name.padEnd(36)} ${o.detail}${secs}`);
  return o;
}

function run(cmd: string, args: string[], opts: { env?: Record<string, string>; timeoutMs?: number } = {}) {
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    env: { ...process.env, ...opts.env },
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 300_000,
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const lastLine = (s: string) => s.trim().split('\n').filter(Boolean).at(-1) ?? '(no output)';
const words = (t: string) => (t.trim() ? t.trim().split(/\s+/).length : 0);
const clip = (t: string, n = 70) => (t.length > n ? `${t.slice(0, n)}…` : t);

function walkFiles(dir: string, skipNames: Set<string>, rel = ''): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(dir, rel))) {
    if (skipNames.has(name)) continue;
    const relPath = rel ? join(rel, name) : name;
    if (statSync(join(dir, relPath)).isDirectory()) out.push(...walkFiles(dir, skipNames, relPath));
    else out.push(relPath);
  }
  return out;
}

console.log(`wearable-extension system check · model ${config.visionModel} · tts ${config.ttsModel}`);

// ---- offline ----------------------------------------------------------------------

console.log('\nOffline');

await check('runtime', () => {
  const node = run('node', ['--version']);
  if (node.code !== 0) return fail('node not found — the toolkit demo needs it');
  const base = `bun ${Bun.version} · node ${node.out.trim()}`;
  return run('ffmpeg', ['-version']).code === 0
    ? pass(`${base} · ffmpeg ok`)
    : warn(`${base} · ffmpeg missing — clip and smartglass sources need it (webcam works without)`);
});

await check('secrets stay in .env', () => {
  const ignored = existsSync(join(ROOT, '.gitignore'))
    ? readFileSync(join(ROOT, '.gitignore'), 'utf8').split('\n').map((l) => l.trim())
    : [];
  if (!ignored.includes('.env')) return fail('.gitignore does not list .env');

  const envPath = join(ROOT, '.env');
  const envKey = existsSync(envPath)
    ? readFileSync(envPath, 'utf8')
        .split('\n')
        .map((l) => l.match(/^\s*GEMINI_API_KEY\s*=\s*(.*?)\s*$/)?.[1]?.replace(/^['"]|['"]$/g, ''))
        .find(Boolean)
    : undefined;

  // Scan for every key in play — the one in use and the one in .env — so a
  // shell override can never hide a pasted key.
  const keys = [...new Set([config.geminiApiKey, envKey].filter((k): k is string => !!k))];
  const everyFile = walkFiles(ROOT, new Set(['node_modules', 'data', '.env', '.git']));
  for (const key of keys) {
    const leaks = everyFile.filter((f) => readFileSync(join(ROOT, f)).includes(key));
    if (leaks.length) return fail(`API key found outside .env in: ${leaks.join(', ')}`);
  }
  const keyInUrl = /(?:generateContent|models)\?[^\s"'`]*\bkey=/;
  const urlKeyUse = everyFile.filter(
    (f) => /^(?:src|scripts)\//.test(f) && /\.(?:ts|mjs|js|html)$/.test(f) && keyInUrl.test(readFileSync(join(ROOT, f), 'utf8')),
  );
  if (urlKeyUse.length) return fail(`a Gemini request puts the key in its URL (send x-goog-api-key instead) in: ${urlKeyUse.join(', ')}`);

  if (!envKey && !existsSync(envPath)) return warn('no .env yet — copy .env.example and set GEMINI_API_KEY (live checks need a key)');
  if (!config.geminiApiKey) return warn('GEMINI_API_KEY is empty — live checks will be skipped');
  if (envKey !== config.geminiApiKey) return warn('the key in use comes from the shell environment, not .env');
  return pass('key read from .env · .env gitignored · key in no other file · never sent in a URL');
});

await check('toolkit installed', () => {
  const pkgPath = join(ROOT, 'node_modules/@ai4a11y/toolkit/package.json');
  if (!existsSync(pkgPath)) return fail('node_modules/@ai4a11y/toolkit missing — run bun install');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  return pkg.name === '@ai4a11y/toolkit' ? pass(`${pkg.name}@${pkg.version}`) : fail(`unexpected package ${pkg.name}`);
});

await check('toolkit pinned commit', () => {
  if (!existsSync(TOOLKIT_REPO)) return fail(`sibling checkout not found at ${TOOLKIT_REPO}`);
  const remote = run('git', ['-C', TOOLKIT_REPO, 'remote', 'get-url', 'origin']);
  if (remote.code !== 0) return warn('sibling checkout is not a git repo — cannot confirm the pin');
  const url = remote.out.trim();
  if (!url.replace(/\.git$/, '').endsWith(TOOLKIT_REMOTE)) {
    return fail(`sibling checkout tracks ${url} — the app must use github.com/${TOOLKIT_REMOTE}`);
  }
  const head = run('git', ['-C', TOOLKIT_REPO, 'rev-parse', '--short', 'HEAD']);
  const sha = head.out.trim();
  return sha.startsWith(PINNED_TOOLKIT_COMMIT)
    ? pass(`github.com/${TOOLKIT_REMOTE} at ${sha}`)
    : warn(`github.com/${TOOLKIT_REMOTE} at ${sha}, app verified against ${PINNED_TOOLKIT_COMMIT} — rerun every check, then update the pin`);
});

await check('toolkit untouched', () => {
  const st = run('git', ['-C', TOOLKIT_REPO, 'status', '--porcelain', '--', 'toolkit']);
  if (st.code !== 0) return warn('cannot run git status in the sibling checkout');
  const dirty = st.out.trim();
  return dirty
    ? fail(`uncommitted changes under toolkit/ — toolkit wishes belong in its docs/FOLLOW-UPS.md:\n      ${dirty.split('\n').join('\n      ')}`)
    : pass('no changes under toolkit/');
});

await check('installed toolkit = sibling', () => {
  const installedDir = join(ROOT, 'node_modules/@ai4a11y/toolkit');
  const siblingDir = join(TOOLKIT_REPO, 'toolkit');
  if (!existsSync(join(installedDir, 'index.js'))) return fail('installed toolkit is missing index.js — run bun install');
  const skipNames = new Set(['node_modules', '.git']);
  const installed = walkFiles(installedDir, skipNames);
  const sibling = walkFiles(siblingDir, skipNames);
  const siblingReal = realpathSync(siblingDir) + sep;
  let linked = 0;
  const differing = installed.filter((rel) => {
    const abs = join(installedDir, rel);
    if (realpathSync(abs).startsWith(siblingReal)) {
      linked++;
      return false;
    }
    const twin = join(siblingDir, rel);
    return !existsSync(twin) || !readFileSync(twin).equals(readFileSync(abs));
  });
  const installedSet = new Set(installed);
  const missing = sibling.filter((rel) => !installedSet.has(rel));
  if (differing.length || missing.length) {
    const parts = [
      differing.length ? `${differing.length} differ (${differing.slice(0, 4).join(', ')}${differing.length > 4 ? '…' : ''})` : '',
      missing.length ? `${missing.length} missing (${missing.slice(0, 4).join(', ')}${missing.length > 4 ? '…' : ''})` : '',
    ].filter(Boolean);
    return fail(`the app would not run the pinned toolkit: ${parts.join('; ')} — run bun install`);
  }
  return pass(
    linked === installed.length
      ? `all ${installed.length} files are symlinks into the sibling checkout`
      : `${installed.length} files identical to the sibling (${linked} linked, ${installed.length - linked} copied)`,
  );
});

await check('typecheck', () => {
  const r = run('bunx', ['tsc', '--noEmit']);
  return r.code === 0 ? pass('tsc --noEmit clean') : fail(r.out.trim().split('\n').slice(0, 6).join('\n      '));
});

await check('unit tests', () => {
  const r = run('bun', ['test']);
  const passed = r.out.match(/(\d+) pass/)?.[1] ?? '?';
  const failed = r.out.match(/(\d+) fail/)?.[1] ?? '?';
  return r.code === 0 ? pass(`${passed} pass · 0 fail`) : fail(`${failed} failing — run bun test for details`);
});

await check("toolkit's own XR demo", () => {
  const r = run('node', ['node_modules/@ai4a11y/toolkit/hosts/xr-demo/demo.js']);
  return r.code === 0 && r.out.includes('Cross-surface loop complete')
    ? pass('grant → export → insight → accept loop, from the installed toolkit')
    : fail(lastLine(r.out));
});

{
  const tmp = mkdtempSync(join(tmpdir(), 'we-check-'));
  try {
    await check('profile import (fixture)', () => {
      const r = run('bun', ['scripts/import-profile.mjs', '--fixture', '--to', join(tmp, 'app')]);
      return r.out.includes('exactly the four demo needs') ? pass('4 needs · accurate sources · no stray reduceMotion') : fail(lastLine(r.out));
    });
    await check('profile seed (onboarding helpers)', () => {
      const r = run('bun', [
        'scripts/import-profile.mjs', '--uid', 'margaret', '--seed',
        '--from', join(tmp, 'onboarding'), '--to', join(tmp, 'seeded'),
      ]);
      return r.out.includes('exactly the four demo needs')
        ? pass("cleaned repo's fileStore + createToolkitHost → blob → app store")
        : fail(lastLine(r.out));
    });
    await check('retake reset', () => {
      const leftover = join(tmp, 'app', 'left-from-last-take.json');
      writeFileSync(leftover, '{}');
      const r = run('bun', ['scripts/reset-take.mjs', '--to', join(tmp, 'app')]);
      if (existsSync(leftover)) return fail('the store was not wiped — state from the last take would survive');
      return r.out.includes('pre-consent state restored') ? pass('store wiped · fixture re-imported') : fail(lastLine(r.out));
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- stopping ------------------------------------------------------------------------
// Start a real demo process on spare ports, then stop it the two ways a person
// would, and prove the process is gone. It never presses Start, so no Gemini
// request is made; a placeholder key is enough when none is configured.

{
  const waitExit = (child: ChildProcess, ms: number) =>
    new Promise<boolean>((resolveExit) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolveExit(true);
      const timer = setTimeout(() => resolveExit(false), ms);
      child.once('exit', () => {
        clearTimeout(timer);
        resolveExit(true);
      });
    });

  const bootDemo = async (appPort: number, demoPort: number) => {
    const dataDir = mkdtempSync(join(tmpdir(), 'we-stop-'));
    const child = spawn('bun', ['src/scripts/drive-core.ts'], {
      cwd: ROOT,
      env: {
        ...process.env,
        APP_DATA_DIR: dataDir,
        PORT: String(appPort),
        DEMO_PORT: String(demoPort),
        GUIDE_MODE: 'baseline',
        GEMINI_API_KEY: config.geminiApiKey || 'placeholder-key-for-the-stop-check',
      },
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    const base = `http://localhost:${demoPort}`;
    let up = false;
    for (let i = 0; i < 80 && !up; i++) {
      up = await fetch(`${base}/status`).then((r) => r.ok, () => false);
      if (!up) await Bun.sleep(250);
    }
    return { child, base, up, dataDir };
  };

  const portClosed = (base: string) => fetch(`${base}/status`).then(() => false, () => true);

  await check('■ Stop button shuts the demo down', async () => {
    const d = await bootDemo(3910, 3911);
    try {
      if (!d.up) return fail('the demo never started on :3911');
      const res = await fetch(`${d.base}/shutdown`, { method: 'POST' });
      if (res.status !== 202) return fail(`POST /shutdown answered HTTP ${res.status}`);
      if (!(await waitExit(d.child, 5000))) return fail('the demo process was still running 5 s after Stop');
      return (await portClosed(d.base)) ? pass('process exited and its port closed') : fail('the process exited but its port still answers');
    } finally {
      d.child.kill('SIGKILL');
      rmSync(d.dataDir, { recursive: true, force: true });
    }
  });

  await check('Ctrl-C shuts the demo down', async () => {
    const d = await bootDemo(3912, 3913);
    try {
      if (!d.up) return fail('the demo never started on :3913');
      d.child.kill('SIGINT');
      if (!(await waitExit(d.child, 5000))) return fail('the demo process ignored Ctrl-C for 5 s');
      return (await portClosed(d.base)) ? pass('process exited and its port closed') : fail('the process exited but its port still answers');
    } finally {
      d.child.kill('SIGKILL');
      rmSync(d.dataDir, { recursive: true, force: true });
    }
  });
}

// ---- live ---------------------------------------------------------------------------

console.log('\nLive Gemini');

const LIVE_CHECKS = [
  'models available', 'text turn: baseline', 'text turn: toolkit', 'conversation memory',
  'camera verify (Cottons → yes)', 'camera verify (Synthetics → no)', 'bill read (exact values)',
  'task brief (model-written)', 'laptop voice (Gemini TTS)',
];
const liveSkipReason = OFFLINE ? '--offline' : !config.geminiApiKey ? 'GEMINI_API_KEY unset' : '';

const task = washingMachine as Task;
const margaret = fixture.abilityModel as AbilityModel;
const render = renderAudioSettings(margaret);
const toolkitTaskPrompt = composePrompt({ task, profileBlock: profilePromptBlock(margaret, render) });
const OPEN = 'Hello? Can you help me start the washing machine? I want to wash my cottons at forty degrees.';

if (liveSkipReason) {
  for (const name of LIVE_CHECKS) await check(name, () => skip(`skipped (${liveSkipReason})`));
} else {
  await check('models available', async () => {
    const names: string[] = [];
    let pageToken = '';
    do {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?pageSize=200${pageToken ? `&pageToken=${pageToken}` : ''}`,
        { headers: { 'x-goog-api-key': config.geminiApiKey }, signal: AbortSignal.timeout(30_000) },
      );
      if (!res.ok) return fail(`ListModels HTTP ${res.status} — is the key valid?`);
      const d: any = await res.json();
      for (const m of d.models ?? []) names.push(String(m.name).replace(/^models\//, ''));
      pageToken = d.nextPageToken ?? '';
    } while (pageToken);
    const missing = [config.visionModel, config.ttsModel].filter((m) => !names.includes(m));
    if (missing.length) return fail(`not available on this key: ${missing.join(', ')}`);
    const flash = names
      .map((n) => n.match(/^gemini-(\d+)\.(\d+)-flash$/))
      .filter((m): m is RegExpMatchArray => !!m)
      .sort((a, b) => Number(b[1]) - Number(a[1]) || Number(b[2]) - Number(a[2]));
    const newest = flash[0]?.[0];
    const note = newest && newest !== config.visionModel ? ` · newest flash on key: ${newest} (bench before switching — CHECKING.md §5)` : '';
    return pass(`${config.visionModel} + ${config.ttsModel}${note}`);
  });

  const textTurn = async (systemInstruction: string) => {
    const t0 = performance.now();
    const r = await generateContent({
      apiKey: config.geminiApiKey,
      model: config.visionModel,
      systemInstruction,
      contents: [{ role: 'user', parts: [{ text: OPEN }] }],
      maxOutputTokens: TURN_MAX_OUTPUT_TOKENS,
      temperature: config.llmTemperature,
    });
    return { ...r, ms: Math.round(performance.now() - t0) };
  };
  const endsCleanly = (t: string) => /[.!?…"'”’)\]]$/.test(t.trim());

  await check('text turn: baseline', async () => {
    const r = await textTurn(composePrompt({ task, profileBlock: '' }));
    const facts = `${r.ms} ms · ${words(r.text)} words · thinking ${r.thinking} (${r.thoughtTokens} thought tokens)`;
    if (!r.text) return fail(`empty reply (finish ${r.finishReason}) · ${facts}`);
    if (r.finishReason !== 'STOP') return fail(`cut off (finish ${r.finishReason}) — thought tokens are eating the output budget · ${facts}`);
    if (!endsCleanly(r.text)) return warn(`reply ends without punctuation — make sure it isn't cut off · ${facts}`);
    return r.ms > 6000 ? warn(`slow for a voice turn · ${facts}`) : pass(facts);
  });

  await check('text turn: toolkit', async () => {
    const r = await textTurn(toolkitTaskPrompt);
    const facts = `${r.ms} ms · ${words(r.text)} words · "${clip(r.text)}"`;
    if (!r.text) return fail(`empty reply (finish ${r.finishReason})`);
    if (r.finishReason !== 'STOP') return fail(`cut off (finish ${r.finishReason}) · ${facts}`);
    if (!endsCleanly(r.text)) return warn(`reply ends without punctuation — make sure it isn't cut off · ${facts}`);
    if (words(r.text) > 40) return warn(`long for a one-step reply · ${facts}`);
    if (/compartment (ii|2)\b|program selector|start\/pause key/i.test(r.text)) return warn(`manual jargon despite the plain-words directive · ${facts}`);
    return r.ms > 6000 ? warn(`slow for a voice turn · ${facts}`) : pass(facts);
  });

  await check('conversation memory', async () => {
    const convo = createConversation({
      apiKey: config.geminiApiKey,
      model: config.visionModel,
      systemInstruction: BASE_PERSONA,
      temperature: config.llmTemperature,
    });
    await convo.turn('I want to wash my cottons at forty degrees today.');
    const answer = await convo.turn('What temperature did I say? Answer with just the number.');
    return /\b(40|forty)\b/i.test(answer)
      ? pass(`recalled "${clip(answer, 30)}" from the previous turn`)
      : fail(`did not recall the temperature ("${clip(answer, 40)}") — history is not reaching the model`);
  });

  const vision = new VisionClient(config.geminiApiKey, config.visionModel);
  const frameOf = (file: string) => [{ jpeg: readFileSync(join(FIXTURES, file)), timestamp: Date.now() }];

  const verifyCase = (file: string, expected: 'yes' | 'no') => async (): Promise<Outcome> => {
    const t0 = performance.now();
    const raw = await vision.generate({
      frames: frameOf(file),
      text: verifyQuestion(task.verify![0]!.prompt),
      maxOutputTokens: VERIFY_MAX_OUTPUT_TOKENS,
      temperature: 0,
    });
    const got = parseVerifyAnswer(raw);
    const ms = Math.round(performance.now() - t0);
    if (got === expected) return pass(`${got} · ${ms} ms`);
    if (got === 'yes') return fail(`false "yes" ("${clip(raw, 30)}") — the guide would speak a wrong confirmation · ${ms} ms`);
    return warn(`${got} ("${clip(raw, 30)}") — the beat would stay silent, never wrong · ${ms} ms`);
  };
  await check('camera verify (Cottons → yes)', verifyCase('dial-cottons.jpg', 'yes'));
  await check('camera verify (Synthetics → no)', verifyCase('dial-synthetics.jpg', 'no'));

  await check('bill read (exact values)', async () => {
    const t0 = performance.now();
    const r = await readVisibleText({ frames: frameOf('bill.jpg'), vision });
    const ms = Math.round(performance.now() - t0);
    if (!r) return fail(`nothing read · ${ms} ms`);
    const expectations: Array<[string, RegExp]> = [
      ['$42.17', /(?<![\d.])\$?42\.17(?!\d)/],
      ['September 30, 2026', /September 30, 2026/],
      ['Riverside Water & Power', /Riverside Water (?:&|and) Power/i],
    ];
    const missing = expectations.filter(([, re]) => !re.test(r.text)).map(([label]) => label);
    return missing.length
      ? fail(`misread — missing ${missing.join(', ')} · ${ms} ms`)
      : pass(`amount, due date, sender exact · kind ${r.kind} · ${ms} ms`);
  });

  // A task with no script: the model writes the brief from the request and
  // the camera view. The dial fixture is in view, so the facts should name it.
  await check('task brief (model-written)', async () => {
    const t0 = performance.now();
    const brief = await generateTaskBrief({ request: 'help me start the washing machine', frames: frameOf('dial-cottons.jpg'), vision });
    const ms = Math.round(performance.now() - t0);
    if (!brief.brief.length) return fail(`no usable brief came back · ${ms} ms`);
    const text = brief.brief.join(' ');
    const facts = `"${brief.goal}" · ${brief.brief.length} facts · ${ms} ms`;
    if (!/\b(dial|program|selector|cottons)\b/i.test(text)) return warn(`the facts never mention the dial in view ("${clip(text, 60)}") · ${facts}`);
    return pass(facts);
  });

  await check('laptop voice (Gemini TTS)', async () => {
    const t0 = performance.now();
    const out = await synthesizeSpeech({
      apiKey: config.geminiApiKey,
      model: config.ttsModel,
      voice: config.ttsVoice,
      text: 'First, please open the soap drawer.',
      stylePrefix: styleLine(render),
    });
    const ms = Math.round(performance.now() - t0);
    return out && out.wav.length > 10_000
      ? pass(`${Math.round(out.wav.length / 1024)} KB of audio · ${ms} ms`)
      : fail(`no audio from ${config.ttsModel} — the page would fall back to the browser voice`);
  });
}

// ---- rig ------------------------------------------------------------------------------

console.log('\nRig (the A/B film over HTTP)');

if (!RIG || liveSkipReason) {
  await check('A/B film run', () => skip(`skipped (${!RIG ? 'pass --rig' : liveSkipReason})`));
} else {
  await runRig();
}

async function runRig(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), 'we-rig-'));
  const base = `http://localhost:${RIG_DEMO_PORT}`;
  type Speak = { at: number; rate: number; slower: boolean; text: string };
  const speaks: Speak[] = [];
  const logTail: string[] = [];
  let child: ChildProcess | null = null;
  let broken = false;

  const beat = async (name: string, fn: () => Promise<Outcome>) => {
    if (broken) return check(name, () => skip('skipped (an earlier beat failed)'));
    const o = await check(name, fn);
    if (o.status === 'fail') broken = true;
    return o;
  };
  const post = (path: string, body: unknown) =>
    fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const state = async (): Promise<any> => ((await (await fetch(`${base}/status`)).json()) as any).state;
  const waitFor = async <T>(probe: () => Promise<T | null | undefined | false>, timeoutMs: number): Promise<T | null> => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      try {
        const v = await probe();
        if (v) return v;
      } catch {
        /* server not up yet */
      }
      await Bun.sleep(250);
    }
    return null;
  };
  // An utterance is finished once a SPEAK line past `fromIndex` has appeared
  // and the harness's own speaking-time estimate for the last chunk (drive-core
  // sleeps words ÷ 2.8 s ÷ rate, capped at 12 s) plus 2 s has passed with no
  // further line.
  const settle = async (fromIndex: number, timeoutMs = 75_000): Promise<Speak[]> => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const last = speaks.at(-1);
      if (speaks.length > fromIndex && last) {
        const speakingMs = Math.min(12_000, ((words(last.text) / 2.8) * 1000) / last.rate);
        if (Date.now() > last.at + speakingMs + 2_000) return speaks.slice(fromIndex);
      }
      await Bun.sleep(250);
    }
    return speaks.slice(fromIndex);
  };
  const say = async (text: string) => {
    const from = speaks.length;
    await post('/say', { text });
    return settle(from);
  };
  const joined = (xs: Speak[]) => xs.map((s) => s.text).join(' ');
  const tail = () => logTail.slice(-6).join(' | ');

  try {
    await beat('rig boots', async () => {
      const inUse = await fetch(`${base}/status`).then(() => true, () => false);
      if (inUse) return fail(`port ${RIG_DEMO_PORT} is already serving something — stop it first`);
      const reset = run('bun', ['scripts/reset-take.mjs', '--to', dataDir]);
      if (!reset.out.includes('pre-consent state restored')) return fail(`fixture import failed: ${lastLine(reset.out)}`);
      child = spawn('bun', ['src/scripts/drive-core.ts'], {
        cwd: ROOT,
        env: {
          ...process.env,
          APP_DATA_DIR: dataDir,
          PORT: String(RIG_APP_PORT),
          DEMO_PORT: String(RIG_DEMO_PORT),
          GUIDE_MODE: 'baseline',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let buffer = '';
      const onData = (d: Buffer) => {
        buffer += d.toString();
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (line.trim() && line.trim() !== '>') logTail.push(line.trim());
          if (logTail.length > 40) logTail.shift();
          const m = line.match(/🔊 SPEAK( \(slower\))? \[(\d+\.\d+)×\]: (.*)$/);
          if (m) speaks.push({ at: Date.now(), slower: !!m[1], rate: parseFloat(m[2]!), text: m[3]! });
        }
      };
      child.stdout!.on('data', onData);
      child.stderr!.on('data', onData);
      const up = await waitFor(async () => (await fetch(`${base}/status`)).ok, 20_000);
      if (!up) return fail(`demo server never answered on :${RIG_DEMO_PORT} — ${tail()}`);
      await post('/active', { active: true });
      return pass(`demo harness on :${RIG_DEMO_PORT} · temp store · baseline`);
    });

    let baseline: Speak[] = [];
    await beat('baseline: one raw answer at 1.0×', async () => {
      baseline = await say(OPEN);
      if (!baseline.length) return fail(`no speech within 75 s — ${tail()}`);
      if (!baseline.every((s) => s.rate === 1)) return fail(`rate ${baseline.map((s) => s.rate).join('/')} — baseline must be unshaped`);
      if (baseline.length !== 1) return fail(`${baseline.length} chunks — baseline must be one raw utterance`);
      return pass(`${words(baseline[0]!.text)} words · "${clip(baseline[0]!.text, 50)}"`);
    });

    await beat('baseline: repeat is verbatim', async () => {
      const again = await say('repeat');
      return joined(again) === joined(baseline) ? pass('identical transcript replay') : fail(`replay differed: "${clip(joined(again), 50)}"`);
    });

    // POST /mode resolves only when the consent beat has finished, so it is
    // left running while the question is asked and answered.
    let modeRequest: Promise<Response> | null = null;
    let modeFinished = false;
    await beat('toolkit: consent question spoken', async () => {
      const from = speaks.length;
      modeRequest = post('/mode', { mode: 'toolkit' }).finally(() => {
        modeFinished = true;
      });
      const card = await waitFor(async () => ((await state()).consentCard?.kind === 'grant' ? true : null), 20_000);
      if (!card) return fail('no permission card within 20 s');
      const asked = await waitFor(async () => speaks.slice(from).find((s) => /accessibility profile/i.test(s.text)) ?? null, 15_000);
      return asked ? pass('question spoken + permission card shown') : fail('card shown but the question was never spoken');
    });

    await beat('toolkit: "yes" while listening grants', async () => {
      // Wait until the guide is actually listening for the answer, so the yes
      // is proven to travel the path a wearer's spoken answer takes.
      const listening = await waitFor(async () => ((await state()).listening ? true : null), 40_000);
      if (!listening) {
        return fail(modeFinished ? 'the consent beat ended without ever listening for an answer' : 'the guide never started listening for an answer');
      }
      const answeredAt = Date.now();
      await post('/say', { text: 'Yes, please go ahead.' });
      const s = await waitFor(async () => {
        const st = await state();
        return st.granted && !st.consentCard ? st : null;
      }, 10_000);
      if (!s) return fail('grant not minted within 10 s of answering');
      const res = await (modeRequest as Promise<Response> | null);
      if (!res || res.status !== 204) return fail(`the mode switch answered HTTP ${res?.status ?? 'nothing'}`);
      if (s.rate !== 0.8 || s.deliveryMode !== 'stepwise' || !s.captionsMirror) {
        return fail(`render wrong: rate ${s.rate} · ${s.deliveryMode} · captions ${s.captionsMirror}`);
      }
      return pass(`granted ${((Date.now() - answeredAt) / 1000).toFixed(1)} s after the answer → 0.8× · stepwise · captions`);
    });

    let step1: Speak[] = [];
    await beat('toolkit: one short step at 0.8×', async () => {
      step1 = await say('Can you help me start the washing machine? Cottons at forty degrees.');
      if (!step1.length) return fail(`no speech within 75 s — ${tail()}`);
      if (!step1.every((s) => s.rate === 0.8)) return fail(`rates ${step1.map((s) => s.rate).join('/')}`);
      const long = step1.find((s) => words(s.text) > 30);
      return long
        ? warn(`a chunk ran ${words(long.text)} words: "${clip(long.text, 50)}"`)
        : pass(`${step1.length} chunk(s) · "${clip(joined(step1), 56)}"`);
    });

    let step2: Speak[] = [];
    await beat('toolkit: "done" advances', async () => {
      step2 = await say('done');
      if (!step2.length) return fail('no speech after "done"');
      return joined(step2) === joined(step1) ? fail('same step again — done is not advancing') : pass(`"${clip(joined(step2), 60)}"`);
    });

    await beat('toolkit: repeat is verbatim at 0.8×', async () => {
      const again = await say('repeat');
      return joined(again) === joined(step2) && again.every((s) => s.rate === 0.8)
        ? pass('identical transcript · still 0.8×')
        : fail(`got "${clip(joined(again), 50)}" at ${again.map((s) => s.rate).join('/')}`);
    });

    await beat('toolkit: 2nd repeat slows + suggests', async () => {
      const again = await say('Can you say that again?');
      const slowed = again.filter((s) => s.slower);
      if (!slowed.length || !slowed.every((s) => s.rate === 0.7)) {
        return fail(`no 0.70× slowed replay (got ${again.map((s) => `${s.rate}${s.slower ? ' slower' : ''}`).join(', ') || 'nothing'})`);
      }
      const card = await waitFor(async () => {
        const st = await state();
        return st.consentCard?.kind === 'insight' ? st.consentCard : null;
      }, 25_000);
      return card ? pass(`0.70× replay → suggestion: "${clip(card.body, 44)}"`) : fail('slowed replay happened but no suggestion card');
    });

    await beat('toolkit: accepting applies 0.7×', async () => {
      const listening = await waitFor(async () => ((await state()).listening ? true : null), 30_000);
      if (!listening) return fail('the suggestion never listened for an answer');
      await post('/consent', { response: 'accept' });
      const s = await waitFor(async () => {
        const st = await state();
        return st.rate === 0.7 ? st : null;
      }, 20_000);
      if (!s) return fail('rate still not 0.7 after accepting');
      const need = s.needs.find((n: any) => n.dimension === 'readAloudRate');
      const next = await say('done');
      return next.length && next.every((x) => x.rate === 0.7)
        ? pass(`readAloudRate ${need?.value} (${need?.source}) · next step at 0.70×`)
        : fail(`next step spoken at ${next.map((x) => x.rate).join('/') || 'nothing'}`);
    });
  } finally {
    (child as ChildProcess | null)?.kill('SIGTERM');
    await Bun.sleep(300);
    rmSync(dataDir, { recursive: true, force: true });
  }
}

// ---- summary ----------------------------------------------------------------------

console.log(`\n${tally.pass} passed · ${tally.warn} warnings · ${tally.fail} failed · ${tally.skip} skipped`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ✗ ${f}`);
}
console.log('\nNext: the manual passes (browser page, mic, laptop audio, glasses) — docs/CHECKING.md §3–§6');
process.exit(tally.fail ? 1 : 0);

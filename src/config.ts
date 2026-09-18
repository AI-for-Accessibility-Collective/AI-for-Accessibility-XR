// Centralized env parsing, trimmed from the old draft's wearable config to
// exactly what the Wearable Task Guide uses (docs/PLAN.md §6). Kept
// dependency-free so the glasses-agnostic core can import it freely.

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (see .env.example)`);
  return v;
}

function opt(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v == null) return fallback;
  return v.toLowerCase() === 'true' || v.toLowerCase() === 'on';
}

export type GuideMode = 'baseline' | 'toolkit';

export const config = {
  // The phone app (phone/) dials in to PORT and proves itself with this shared
  // secret — only required when actually running on glasses (index.ts).
  bridgeToken: process.env.BRIDGE_TOKEN || '',
  port: int('PORT', 3000),

  // Gemini
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  // Picked by benchmark, not recency (docs/CHECKING.md §5): on this app's own
  // prompts it was correct every run, the strictest about one step per turn,
  // and ~0.9 s per turn; the newer 3.8-flash invented details and can't turn
  // thinking off. Pin a concrete id — aliases can move mid-shoot.
  visionModel: opt('VISION_MODEL', 'gemini-3.5-flash'),
  // Writes down what the wearer says (src/engine/stt.ts).
  sttModel: opt('STT_MODEL', opt('VISION_MODEL', 'gemini-3.5-flash')),
  ttsModel: opt('TTS_MODEL', 'gemini-3.1-flash-tts-preview'),
  ttsVoice: opt('TTS_VOICE', 'Kore'),
  // Past this, a line is read by the phone's own voice instead of waiting: one
  // stalled Gemini TTS call (21 s has happened) must not freeze a take.
  ttsDeadlineMs: int('TTS_DEADLINE_MS', 9000),
  llmTemperature: num('LLM_TEMPERATURE', 0.2),

  // Spending safety nets. The runaway guard (src/engine/gemini-rest.ts) turns
  // Gemini off for the rest of the run past either limit — a real take needs a
  // few requests a minute; an echo loop or a stuck retry needs many. The demo
  // also pauses Gemini when its last page is closed, and after a stretch with
  // no clicks or typing.
  geminiMaxCallsPerMinute: int('GEMINI_MAX_CALLS_PER_MINUTE', 40),
  geminiMaxCallsPerRun: int('GEMINI_MAX_CALLS_PER_RUN', 800),
  pauseWhenPagesClosedSec: int('PAUSE_WHEN_PAGES_CLOSED_SEC', 10),
  autoPauseIdleMin: int('AUTO_PAUSE_IDLE_MIN', 15),

  // The A/B switch (docs/DESIGN.md §2): which mode the app boots in; panels
  // toggle it live. Baseline by default — it is the film's first take.
  guideMode: (opt('GUIDE_MODE', 'baseline') === 'toolkit' ? 'toolkit' : 'baseline') as GuideMode,

  // FILM_MODE locks the ElevenLabs voice_id constant across modes and turns
  // off the voicePitch voice swap — the same-voice A/B rule.
  filmMode: bool('FILM_MODE', true),
  elevenVoiceId: process.env.ELEVEN_VOICE_ID || '',

  // Toolkit file store for THIS app. Single-writer: never the onboarding dir.
  appDataDir: opt('APP_DATA_DIR', './data'),
  // Which acting-user partition the app reads (who wears the glasses).
  actingUser: opt('APP_USER', 'margaret'),

  // RTMP / frames
  enableRtmpStream: bool('ENABLE_RTMP_STREAM', true),
  useLocalRtmp: bool('USE_LOCAL_RTMP', true),
  rtmpPort: int('RTMP_PORT', 1935),
  rtmpHost: process.env.RTMP_HOST || '',
  frameRate: int('FRAME_RATE', 3),
  // Picture the glasses are asked to send. Left to themselves they send 854×480,
  // too soft to read a dial or a label; 720p reads well and still streams
  // comfortably over ordinary Wi-Fi.
  streamWidth: int('STREAM_WIDTH', 1280),
  streamHeight: int('STREAM_HEIGHT', 720),
  streamBitrate: int('STREAM_BITRATE', 3_000_000),
  captureFps: int('CAPTURE_FPS', 3),
  frameRingSize: int('FRAME_RING_SIZE', 3),

  // Demo browser view — the load-bearing rehearsal rig (docs/PLAN.md rule 3).
  enableDemo: bool('ENABLE_DEMO', true),
  demoPort: int('DEMO_PORT', int('PORT', 3000) + 1),
  demoStreamFps: int('DEMO_STREAM_FPS', 8),

  // Past runs (src/runtime/run-recorder.ts): every Start→Stop take is kept on
  // disk, newest RUNS_KEEP of them. Never inside APP_DATA_DIR — that store is
  // the toolkit's. The pages under /webview/runs show camera images from
  // inside someone's home, so they stay off until ADMIN_PASSWORD is set.
  runsDir: opt('RUNS_DIR', './runs'),
  runsKeep: int('RUNS_KEEP', 40),
  adminPassword: process.env.ADMIN_PASSWORD || '',
};

// Throwing accessors used only by code paths that genuinely need the value.
export function requireGeminiKey(): string {
  if (!config.geminiApiKey) throw new Error('GEMINI_API_KEY is not set (see .env.example)');
  return config.geminiApiKey;
}

export function requireBridgeToken(): string {
  return req('BRIDGE_TOKEN');
}

// Reason the demo server can't safely bind, or null if it's fine.
export function demoPortConflict(): string | null {
  if (config.demoPort === config.port) return `DEMO_PORT (${config.demoPort}) collides with PORT`;
  if (config.demoPort === config.rtmpPort) return `DEMO_PORT (${config.demoPort}) collides with RTMP_PORT`;
  return null;
}

// Gemini text-to-speech for the demo speaker.
//
// On real glasses the device speaks via Mentra's TTS with the ElevenLabs
// SpeakOptions from elevenlabs-map.ts. This lets the BROWSER demo voice
// replies through the laptop speaker using Gemini, so a screen-share and a
// rehearsal actually have audio. Gemini TTS has no numeric knobs — the
// caller approximates the render by prepending gemini-style.ts's style line
// to the text (docs/DESIGN.md §5.1 layer 2).
//
// Uses the REST generateContent endpoint with responseModalities: ['AUDIO'].
// Gemini returns raw little-endian 16-bit PCM (mono, usually 24 kHz); we wrap
// it in a WAV header so a plain <audio> element can play it. The key goes in
// the x-goog-api-key header, never the URL, and is redacted from anything
// logged; the request passes through the same stop switch and runaway guard
// as every other Gemini call (see gemini-rest.ts).

import { guardedRequest, redactKey } from './gemini-rest.ts';

function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // audio format = PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function rateFromMime(mime: string | undefined): number {
  const m = /rate=(\d+)/.exec(mime || '');
  return m ? parseInt(m[1]!, 10) : 24000;
}

// Synthesize one short line. Returns a playable WAV, or null on any failure
// or when Gemini is stopped (the demo falls back to the browser voice).
export async function synthesizeSpeech(opts: {
  apiKey: string;
  model: string;
  voice: string;
  text: string;
  // gemini-style.ts's style instruction, prepended when present.
  stylePrefix?: string;
}): Promise<{ wav: Buffer; mime: string } | null> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${opts.model}:generateContent`;
  const text = (opts.stylePrefix || '') + opts.text;
  let request: ReturnType<typeof guardedRequest>;
  try {
    request = guardedRequest(30_000);
  } catch (e) {
    console.warn(`[tts] not requested: ${e instanceof Error ? e.message : e}`);
    return null;
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': opts.apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: opts.voice } } },
        },
      }),
      signal: request.signal,
    });
    if (!res.ok) {
      console.error(`[tts] gemini tts ${res.status}:`, redactKey((await res.text()).slice(0, 200), opts.apiKey));
      return null;
    }
    const data: any = await res.json();
    const inline = data?.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData)?.inlineData;
    if (!inline?.data) {
      console.error('[tts] no audio in response');
      return null;
    }
    const pcm = Buffer.from(inline.data, 'base64');
    return { wav: pcmToWav(pcm, rateFromMime(inline.mimeType)), mime: 'audio/wav' };
  } catch (e) {
    console.error('[tts] request failed:', redactKey(e instanceof Error ? e.message : String(e), opts.apiKey));
    return null;
  } finally {
    request.release();
  }
}

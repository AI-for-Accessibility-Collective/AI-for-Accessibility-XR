// Thin client for multimodal (frames + text) request/response calls — the
// verification + read path. Same VisionClient surface the old draft had, now
// over gemini-rest.ts (direct REST) instead of the deprecated SDK, which
// stripped thinkingConfig and let Gemini 3.x thought tokens starve small
// output budgets (a one-word verify answer would come back empty).

import type { FrameEntry } from '../transport/frames.ts';
import { generateContent, type GeminiPart } from './gemini-rest.ts';

export interface VisionRequest {
  systemInstruction?: string;
  // Recent camera frames, oldest first. Each is sent as inline image/jpeg.
  frames?: FrameEntry[];
  // The user/instruction text for this turn.
  text: string;
  maxOutputTokens?: number;
  temperature?: number;
}

export class VisionClient {
  constructor(private apiKey: string, private model: string) {}

  async generate(reqOpts: VisionRequest): Promise<string> {
    const parts: GeminiPart[] = [];
    const frames = reqOpts.frames ?? [];
    frames.forEach((f, i) => {
      if (frames.length > 1) parts.push({ text: `Frame ${i + 1} (most recent last):` });
      parts.push({ inlineData: { mimeType: 'image/jpeg', data: f.jpeg.toString('base64') } });
    });
    parts.push({ text: reqOpts.text });

    const result = await generateContent({
      apiKey: this.apiKey,
      model: this.model,
      systemInstruction: reqOpts.systemInstruction,
      contents: [{ role: 'user', parts }],
      // Includes thought-token headroom (gemini-rest.ts header).
      maxOutputTokens: reqOpts.maxOutputTokens ?? 800,
      temperature: reqOpts.temperature ?? 0.3,
    });
    if (result.finishReason !== 'STOP') {
      console.warn(`[vision] non-STOP finish: ${result.finishReason} (thoughts=${result.thoughtTokens})`);
    }
    return result.text;
  }
}

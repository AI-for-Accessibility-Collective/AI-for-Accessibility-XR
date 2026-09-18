// The conversational engine contract.
//
// A TurnEngine turns "the user said X (with these recent frames in view)"
// into reply TEXT — it never speaks. Delivery belongs to the speaker
// (src/audio/speaker.ts): that separation is what lets one model serve both
// modes while the render shapes only the output side.
//
// createConversation (request-engine.ts) is the only implementation: the
// reliable request/response path, with per-conversation history so a
// stepwise task carries its progress turn to turn.

import type { FrameEntry } from '../transport/frames.ts';

export interface TurnEngine {
  // One user turn → the model's reply text ('' when the model had nothing).
  // Turns are serialized per conversation; frames are optional context.
  turn(text: string, frames?: FrameEntry[]): Promise<string>;
  reset(): void;
}

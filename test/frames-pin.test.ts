import { afterEach, describe, expect, test } from 'bun:test';
import { FrameStore } from '../src/transport/frames.ts';

// Distinct JPEG-ish buffers (identical frames are deduped by the store).
const frame = (n: number) => Buffer.from(`frame-${n}`);

// The clock stays faked (just after the last frame) until the test ends, so
// "is the stream stalled?" is judged against the frames' own time.
const realNow = Date.now;
afterEach(() => {
  Date.now = realNow;
});
function storeWith(times: number[], historyMs?: number): { store: FrameStore; at: (i: number) => number } {
  const store = historyMs == null ? new FrameStore(3) : new FrameStore(3, historyMs);
  times.forEach((t, i) => {
    Date.now = () => t;
    store.push(frame(i));
  });
  const last = times[times.length - 1] ?? 0;
  Date.now = () => last + 100;
  return { store, at: (i) => times[i]! };
}
const names = (fs: { jpeg: Buffer }[]) => fs.map((f) => f.jpeg.toString());

describe('FrameStore: answering from the moment the wearer started speaking', () => {
  const times = [1000, 1333, 1666, 2000, 2333, 2666, 3000, 3333, 3666, 4000];

  test('unpinned, the engine sees the newest frames', () => {
    const { store } = storeWith(times);
    expect(names(store.recent())).toEqual(['frame-7', 'frame-8', 'frame-9']);
  });

  test('pinned, it sees the view at that moment and what followed — not the newest', () => {
    const { store } = storeWith(times);
    store.pin(2100); // they began speaking just after frame-3 arrived
    expect(names(store.recent())).toEqual(['frame-3', 'frame-4', 'frame-5']);
    expect(store.viewed()!.toString()).toBe('frame-3');
    store.unpin();
    expect(names(store.recent())).toEqual(['frame-7', 'frame-8', 'frame-9']);
    expect(store.viewed()!.toString()).toBe('frame-9');
  });

  test('a still scene: the view at a moment is the last frame that changed, however old', () => {
    const { store } = storeWith([1000, 9000]);
    store.pin(7000);
    expect(names(store.recent())).toEqual(['frame-0']); // frame-1 is outside the span after the moment
  });

  test('a moment older than the history falls back to the oldest frame held', () => {
    const { store } = storeWith(times);
    store.pin(10);
    expect(names(store.recent())[0]).toBe('frame-0');
  });

  test('no frames at all: pinning is harmless and recent() is empty', () => {
    const store = new FrameStore(3);
    store.pin(Date.now());
    expect(store.recent()).toEqual([]);
    expect(store.viewed()).toBeNull();
  });

  test('history is bounded in time', () => {
    const { store } = storeWith([0, 500, 1000, 1500, 2000, 2500], 1000);
    store.pin(0);
    expect(names(store.recent())[0]).toBe('frame-3'); // older ones have been dropped
  });
});

describe('FrameStore: a stalled stream is not a view', () => {
  test('frames that stopped arriving are withheld — the guide gets no picture rather than an old one', () => {
    const { store } = storeWith([1000, 1333, 1666]);
    expect(store.stalled()).toBe(false);
    expect(store.recent().length).toBe(3);
    Date.now = () => 1666 + 7000; // seven seconds of nothing
    expect(store.stalled()).toBe(true);
    expect(store.recent()).toEqual([]);
    expect(store.viewed()).toBeNull();
    store.pin(1500);
    expect(store.recent()).toEqual([]); // pinning does not bring a dead stream back
  });

  test('a still scene is not a stall: identical frames keep arriving', () => {
    const store = new FrameStore(3);
    Date.now = () => 1000;
    store.push(frame(1));
    for (let t = 1333; t <= 20_000; t += 333) {
      Date.now = () => t;
      store.push(frame(1)); // same picture, deduped — but it arrived
    }
    Date.now = () => 20_100;
    expect(store.stalled()).toBe(false);
    expect(names(store.recent())).toEqual(['frame-1']);
  });

  test('before any frame has ever arrived nothing is "stalled"', () => {
    const store = new FrameStore(3);
    expect(store.stalled()).toBe(false);
    expect(store.sinceLastArrivalMs()).toBeNull();
  });

  test('frames arriving again ends the stall', () => {
    const { store } = storeWith([1000, 1333]);
    Date.now = () => 10_000;
    expect(store.stalled()).toBe(true);
    store.push(frame(99));
    expect(store.stalled()).toBe(false);
    expect(names(store.recent())).toContain('frame-99');
  });
});

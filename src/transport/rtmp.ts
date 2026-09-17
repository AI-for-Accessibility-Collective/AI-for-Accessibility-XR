// Generic local RTMP ingest. No Mentra dependency: this just runs a
// node-media-server the glasses (or `ffmpeg`, for hardware-free testing)
// publish to. Ported from tdbank/src/index.ts (startRtmpServer /
// getLocalRtmpUrl).

// node-media-server ships no type declarations.
// @ts-ignore
import NodeMediaServer from 'node-media-server';

let rtmpServer: any = null;

export function startRtmpServer(rtmpPort: number): void {
  if (rtmpServer) return;
  // We only ingest RTMP (ffmpeg reads it on loopback); node-media-server's HTTP
  // server is unused. `port: 0` doesn't disable it in NMS v2 — it falls back to
  // privileged :80, which fails to bind as a non-root user. Point it at a free
  // high port derived from the RTMP port so it binds harmlessly and stays quiet.
  const nmsConfig = {
    logType: 1,
    rtmp: { port: rtmpPort, chunk_size: 60000, gop_cache: true, ping: 30, ping_timeout: 60 },
    http: { port: rtmpPort + 7000, allow_origin: '*' },
  };
  rtmpServer = new NodeMediaServer(nmsConfig);
  rtmpServer.on('prePublish', (id: string, p: string) => console.log(`  [RTMP] publishing: ${p} (${id})`));
  rtmpServer.on('donePublish', (id: string, p: string) => console.log(`  [RTMP] stopped: ${p} (${id})`));
  rtmpServer.run();
  console.log(`  [RTMP] server started on port ${rtmpPort}`);
}

export function stopRtmpServer(): void {
  if (!rtmpServer) return;
  try {
    rtmpServer.stop();
    console.log('  [RTMP] server stopped');
  } catch {
    /* ignore */
  }
  rtmpServer = null;
}

// URL the glasses publish to (their LAN view of this machine).
export function getPublishUrl(rtmpHost: string, rtmpPort: number): string {
  if (!rtmpHost) throw new Error('RTMP_HOST must be set (this machine\'s LAN IP, reachable by the glasses)');
  return `rtmp://${rtmpHost}:${rtmpPort}/live/stream`;
}

// URL ffmpeg reads from locally (always loopback).
export function getPlayUrl(rtmpPort: number): string {
  return `rtmp://127.0.0.1:${rtmpPort}/live/stream`;
}

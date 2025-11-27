import { createWriteStream } from 'fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

export type StreamToFileOptions = {
  signal?: AbortSignal;
  highWaterMark?: number;
};

// Write a Web ReadableStream<Uint8Array> to a filesystem path using
// Readable.fromWeb() + pipeline() so the runtime can handle backpressure
// and avoid extra buffer copies. This is Bun/Node-18+ friendly.
export async function streamWebToFile(stream: ReadableStream<Uint8Array> | null, path: string, options?: StreamToFileOptions): Promise<void> {
  if (!stream) throw new Error('No stream provided');

  const signal = options?.signal;
  // @ts-ignore - bridge between DOM ReadableStream and Node's stream/web typings
  const nodeReadable = Readable.fromWeb(stream as any, { signal, highWaterMark: options?.highWaterMark });
  const ws = createWriteStream(path);

  try {
    // pipeline will propagate errors and handle proper cleanup/backpressure
    // The third argument (options) with signal is supported in modern runtimes
    // (Bun / Node 18+). If the runtime does not support it, pipeline will
    // still work but the signal won't automatically abort the pipeline.
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore - some libdefs may not include the pipeline options signature
    await pipeline(nodeReadable, ws, { signal });
  } finally {
    try { ws.destroy(); } catch (_) {}
  }
}

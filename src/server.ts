import { convertFile } from './lib/convert';
import FileTemp from './common/class/FileTemp';
import { streamWebToFile } from './common/stream';
import { buildContentDispositionAttachment } from './common/filename';
import { withTemp } from './common/withTemp';
import { withTimeout } from './common/withTimeout';
import * as metrics from './lib/metrics';
import { Readable } from 'node:stream';

// Constant timeout estimate based on 50 Mbps bandwidth and 2 GiB file with safety factor 2
// Calculation: ms = ceil((2 GiB / (50_000_000 bits/s / 8)) * 2 * 1000)
const DEFAULT_TIMEOUT_MS = Math.ceil((2 * 1024 * 1024 * 1024) / (50_000_000 / 8) * 2 * 1000);

if (!globalThis.Headers) {
  // Bun provides Headers/Request/Response globally inside the runtime. This is a noop guard for other runtimes.
              // push metrics immediately after a conversion (best-effort)
              try { void metrics.pushNow(); } catch (_) {}
}

              // push failure metric immediately (best-effort)
              try { void metrics.pushNow(); } catch (_) {}
const port = parseInt(process.env.PORT || '3000', 10);

function badRequest(message: string) {
  return new Response(JSON.stringify({ error: message }), { status: 400, headers: { 'Content-Type': 'application/json' } });
}

function jsonResponse(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

type BunLike = { serve?: (opts: unknown) => void };
const bun = (globalThis as unknown as { Bun?: BunLike }).Bun;

if (!bun || typeof bun.serve !== 'function') {
  throw new Error('This server must run on Bun.');
}

bun.serve({
  port,
  fetch: async (req: Request) => {
    const reqStart = Date.now();
    try {
      const url = new URL(req.url);

      // Do not expose a /metrics scraping endpoint. Metrics are pushed to a
      // Pushgateway when configured via environment variables. Return 404
      // to avoid accidental scraping of a single instance in environments
      // like Cloud Run where scraping won't reach every instance.
      if (req.method === 'GET' && url.pathname === '/metrics') {
        return new Response('Not Found', { status: 404 });
      }

      if (req.method !== 'POST' || url.pathname !== '/process') {
        return new Response('Not Found', { status: 404 });
      }

      const contentType = req.headers.get('content-type') || '';
      metrics.counterInc('api_requests_total', 1, { endpoint: url.pathname });
      metrics.gaugeInc('api_requests_in_flight', 1);
      const wantsDownload = url.searchParams.has('download');
      const uploadUrlParam = url.searchParams.get('uploadUrl') || undefined;

      // We'll support two modes:
      // 1) multipart/form-data with `file`, `from`, `to` (existing behavior)
      // 2) application/json with `{ downloadUrl, from, to }` — we download the file

      // we use streaming/temp files for inputs to avoid buffering; no in-memory buffer needed
      let from: string | undefined;
      let to: string | undefined;
      let originalName = '';
      let uploadUrlFromForm: string | undefined;
      let uploadUrlFromJson: string | undefined;
      let result: unknown = undefined;
      let conversionDone = false;
      let tempForCleanup: FileTemp | undefined;
      let tempCleaned = false;

      const cleanTempNow = async () => {
        if (tempForCleanup && !tempCleaned) {
          try { await tempForCleanup.cleanFileOnTmpFolder(); } catch (_) {}
          tempCleaned = true;
        }
      };

      if (contentType.includes('multipart/form-data')) {
        const form = await req.formData();

        const file = form.get('file') as File | null;
        from = (form.get('from') as string) || undefined;
        to = (form.get('to') as string) || undefined;
        uploadUrlFromForm = (form.get('uploadUrl') as string) || undefined;

        if (!file) return badRequest('Missing file field');
        if (!from || !to) return badRequest('Missing from or to fields');

        // Stream uploaded file to a temporary file and process using withTemp
        try {
          const fileStream = (file as File & Blob).stream();
          if (!fileStream) {
            await cleanTempNow();
            return badRequest('Uploaded file has no stream');
          }

          const keepTempForStreaming = wantsDownload;
          const finalUploadUrlForMultipart = uploadUrlParam || uploadUrlFromForm;
          if (!finalUploadUrlForMultipart && !wantsDownload) {
            await cleanTempNow();
            return badRequest('When not using ?download you must provide uploadUrl as a query parameter or form field');
          }

          const handlerResult = await withTemp<{ type: string; outputPath?: string; originalName?: string; uploadResp?: { status: number; headers: Record<string,string>; body: ArrayBuffer } ; temp?: FileTemp }>(undefined, async (temp) => {
            tempForCleanup = temp;
            const inputPath = `${temp.filePath}.${from}`;

            await streamWebToFile(fileStream as ReadableStream<Uint8Array>, inputPath);

            originalName = (file as File & { name?: string }).name || `converted.${to}`;

            const conversionTimeout = DEFAULT_TIMEOUT_MS;

            try {
              const convStart = Date.now();
              metrics.gaugeInc('conversions_in_flight', 1);

              const fromExt = String(from).replace(/^[.]/, '');
              const toExt = String(to).replace(/^[.]/, '');

              const res = await withTimeout(async (signal) => {
                return await convertFile(inputPath, fromExt, toExt, { temp, keepTemp: true, timeoutMs: conversionTimeout, signal });
              }, conversionTimeout);

              result = res;
              conversionDone = true;
              metrics.counterInc('conversion_success_total', 1);
              try { void metrics.pushNow(); } catch (_) {}
              const convSec = (Date.now() - convStart) / 1000;
              metrics.histogramObserve('conversion_duration_seconds', convSec);
            } catch (err) {
              metrics.counterInc('conversion_failure_total', 1);
              try { void metrics.pushNow(); } catch (_) {}
              throw err;
            } finally {
              metrics.gaugeDec('conversions_in_flight', 1);
            }

            if (result && typeof result === 'object' && 'outputPath' in result && typeof (result as { outputPath?: unknown }).outputPath === 'string') {
              const outputPath = (result as { outputPath: string }).outputPath;
              if (keepTempForStreaming) {
                return { type: 'stream', outputPath, originalName, temp };
              }

              // perform upload inside withTemp so temp is cleaned afterwards
              const fs = await import('fs');
              const rs = fs.createReadStream(outputPath);

              const uploadTimeoutMs = DEFAULT_TIMEOUT_MS;
              try {
                const uploadResult = await withTimeout(async (signal) => {
                  try { signal.addEventListener('abort', () => { try { rs.destroy(); } catch (_) {} }); } catch (_) {}

                  const uploadResp = await fetch(finalUploadUrlForMultipart as string, {
                    method: 'PUT',
                    headers: {
                      'Content-Type': to === 'pdf' ? 'application/pdf' : 'application/octet-stream',
                      'Content-Disposition': buildContentDispositionAttachment(originalName, String(to)),
                    },
                    body: rs as unknown as BodyInit,
                    signal,
                  });

                  const respArrayBuffer = await uploadResp.arrayBuffer();
                  const forwardedHeaders: Record<string,string> = {};
                  const allowed = new Set([
                    'content-type', 'content-length', 'location', 'etag', 'last-modified', 'content-disposition', 'cache-control'
                  ]);
                  uploadResp.headers.forEach((value, key) => { if (allowed.has(key.toLowerCase())) forwardedHeaders[key] = value; });

                  return { status: uploadResp.status, headers: forwardedHeaders, body: respArrayBuffer };
                }, uploadTimeoutMs);

                return { type: 'upload', uploadResp: uploadResult };
              } catch (err) {
                throw err;
              }
            }

            return { type: 'memory', originalName };
          }, { keepTemp: keepTempForStreaming });

          if (handlerResult && handlerResult.type === 'stream' && handlerResult.outputPath) {
            const outputPath = handlerResult.outputPath;
            const fs = await import('fs');
            const rs = fs.createReadStream(outputPath);

            // Ensure temp cleanup on stream end/error
            rs.on('end', async () => { try { await handlerResult.temp?.cleanFileOnTmpFolder(); } catch (_) {} });
            rs.on('error', async () => { try { await handlerResult.temp?.cleanFileOnTmpFolder(); } catch (_) {} });

            const webStream = Readable.toWeb(rs);

            const disposition = buildContentDispositionAttachment(originalName, String(to));

            return new Response(webStream as unknown as BodyInit, {
              status: 200,
              headers: {
                'Content-Type': to === 'pdf' ? 'application/pdf' : 'application/octet-stream',
                'Content-Disposition': disposition,
              },
            });
          }

          if (handlerResult && handlerResult.type === 'upload' && handlerResult.uploadResp) {
            return new Response(handlerResult.uploadResp.body, { status: handlerResult.uploadResp.status, headers: handlerResult.uploadResp.headers });
          }
        } catch (err: unknown) {
          await cleanTempNow();
          const msg = err instanceof Error ? err.message : String(err);
          return new Response(JSON.stringify({ error: 'Failed to stream uploaded file to temp', details: msg }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }
      } else if (contentType.includes('application/json') || contentType.includes('text/json')) {
        // JSON body with downloadUrl
        const text = await req.text();
        let data: unknown;
        try {
          data = text ? JSON.parse(text) : {};
        } catch {
          return badRequest('Invalid JSON body');
        }

        if (typeof data !== 'object' || data === null) return badRequest('Invalid JSON body');
        const d = data as Record<string, unknown>;
        const downloadUrl = typeof d['downloadUrl'] === 'string' ? d['downloadUrl'] as string : undefined;
        from = typeof d['from'] === 'string' ? (d['from'] as string) : undefined;
        to = typeof d['to'] === 'string' ? (d['to'] as string) : undefined;
        uploadUrlFromJson = typeof d['uploadUrl'] === 'string' ? (d['uploadUrl'] as string) : undefined;

        if (!downloadUrl) return badRequest('Missing downloadUrl in JSON body');
        if (!from || !to) return badRequest('Missing from or to fields');

        // Download the file (stream to temp file to avoid buffering whole content)
        // Use AbortController + timeout estimated from bandwidth/file size to avoid stuck downloads
        const timeoutMs = DEFAULT_TIMEOUT_MS;
        const keepTempForStreaming = wantsDownload;

        try {
        const handlerResult = await withTemp<{ type: string; outputPath?: string; originalName?: string; uploadResp?: { status: number; headers: Record<string,string>; body: ArrayBuffer } ; temp?: FileTemp }>(undefined, async (temp) => {
          tempForCleanup = temp;
          const inputPath = `${temp.filePath}.${from}`;

          // perform fetch + streaming under a single timeout and signal
          await withTimeout(async (signal) => {
            const resp = await fetch(downloadUrl, { signal });
            if (!resp.ok) {
              throw new Error(`FETCH_NOT_OK:${resp.status}:${resp.statusText}`);
            }

            const body = resp.body;
            if (!body) throw new Error('NO_BODY');

            await streamWebToFile(body as ReadableStream<Uint8Array>, inputPath, { signal });
            return;
          }, timeoutMs);

          // determine filename suggestion
          const parsed = new URL(downloadUrl);
          const parts = parsed.pathname.split('/');
          const basename = parts.pop() || '';
          originalName = basename || `downloaded.${to}`;

          const keepTempForStreaming = wantsDownload;
          const finalUploadUrl = uploadUrlParam || uploadUrlFromJson;
          if (!finalUploadUrl && !keepTempForStreaming) {
            throw new Error('MISSING_UPLOAD_URL');
          }

          // conversion timeout uses constant value
          const conversionTimeout = DEFAULT_TIMEOUT_MS;

          try {
            const convStart = Date.now();
            metrics.gaugeInc('conversions_in_flight', 1);

            const fromExt = String(from).replace(/^[.]/, '');
            const toExt = String(to).replace(/^[.]/, '');

            const res = await withTimeout(async (signal) => {
              return await convertFile(inputPath, fromExt, toExt, { temp, keepTemp: true, timeoutMs: conversionTimeout, signal });
            }, conversionTimeout);

            result = res;
            conversionDone = true;
            metrics.counterInc('conversion_success_total', 1);
            try { void metrics.pushNow(); } catch (_) {}
            const convSec = (Date.now() - convStart) / 1000;
            metrics.histogramObserve('conversion_duration_seconds', convSec);
          } catch (err) {
            metrics.counterInc('conversion_failure_total', 1);
            try { void metrics.pushNow(); } catch (_) {}
            throw err;
          } finally {
            metrics.gaugeDec('conversions_in_flight', 1);
          }

          // If convertFile returned an outputPath (we asked to keep temp), handle upload or streaming here
          if (result && typeof result === 'object' && 'outputPath' in result && typeof (result as { outputPath?: unknown }).outputPath === 'string') {
            const outputPath = (result as { outputPath: string }).outputPath;
            if (keepTempForStreaming) {
              return { type: 'stream', outputPath, originalName, temp };
            }

            // upload path (performed inside withTemp so temp can be cleaned in finally)
            const fs = await import('fs');
            const rs = fs.createReadStream(outputPath);

            const uploadTimeoutMs = DEFAULT_TIMEOUT_MS;
            const uploadResult = await withTimeout(async (signal) => {
              try { signal.addEventListener('abort', () => { try { rs.destroy(); } catch (_) {} }); } catch (_) {}

              const uploadResp = await fetch(finalUploadUrl as string, {
                method: 'PUT',
                headers: {
                  'Content-Type': to === 'pdf' ? 'application/pdf' : 'application/octet-stream',
                  'Content-Disposition': buildContentDispositionAttachment(originalName, String(to)),
                },
                body: rs as unknown as BodyInit,
                signal,
              });

              const respArrayBuffer = await uploadResp.arrayBuffer();
              const forwardedHeaders: Record<string,string> = {};
              const allowed = new Set([
                'content-type', 'content-length', 'location', 'etag', 'last-modified', 'content-disposition', 'cache-control'
              ]);
              uploadResp.headers.forEach((value, key) => { if (allowed.has(key.toLowerCase())) forwardedHeaders[key] = value; });

              return { status: uploadResp.status, headers: forwardedHeaders, body: respArrayBuffer };
            }, uploadTimeoutMs);

            return { type: 'upload', uploadResp: uploadResult };
          }

          // Fallback: convertedFile in-memory — return to outer handler for upload or download
          return { type: 'memory', originalName };
        }, { keepTemp: keepTempForStreaming });

          // If we got a streaming result, create the Response here and ensure cleanup when stream ends
          if (handlerResult && handlerResult.type === 'stream' && handlerResult.outputPath) {
            const outputPath = handlerResult.outputPath;
            const fs = await import('fs');
            const rs = fs.createReadStream(outputPath);

            // Ensure temp cleanup on stream end/error
            rs.on('end', async () => { try { await handlerResult.temp?.cleanFileOnTmpFolder(); } catch (_) {} });
            rs.on('error', async () => { try { await handlerResult.temp?.cleanFileOnTmpFolder(); } catch (_) {} });

            const webStream = Readable.toWeb(rs);

            const disposition = buildContentDispositionAttachment(originalName, String(to));

            return new Response(webStream as unknown as BodyInit, {
              status: 200,
              headers: {
                'Content-Type': to === 'pdf' ? 'application/pdf' : 'application/octet-stream',
                'Content-Disposition': disposition,
              },
            });
          }

          // If upload was performed inside withTemp, return its response
          if (handlerResult && handlerResult.type === 'upload' && handlerResult.uploadResp) {
            return new Response(handlerResult.uploadResp.body, { status: handlerResult.uploadResp.status, headers: handlerResult.uploadResp.headers });
          }

        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return new Response(JSON.stringify({ error: 'Failed to fetch/stream downloadUrl', details: msg }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }


      } else {
        return badRequest('Content-Type must be multipart/form-data or application/json');
      }

      const toStr = to as string;

      if (!conversionDone) {
        return badRequest('Conversion did not run; no input provided');
      }

      if (result && typeof result === 'object' && 'stderr' in result && (result as { stderr?: string }).stderr) {
        return jsonResponse({ error: 'Conversion error', details: (result as { stderr?: string }).stderr }, 500);
      }

      // If convertFile returned an outputPath (we asked to keep temp), stream from disk
      if (result && typeof result === 'object' && 'outputPath' in result && typeof (result as { outputPath?: unknown }).outputPath === 'string') {
        const outputPath = (result as { outputPath: string }).outputPath;

        const contentTypeForConverted = toStr === 'pdf'
          ? 'application/pdf'
          : toStr === 'docx'
            ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
            : 'application/octet-stream';

        if (wantsDownload) {
          // Stream file to response without loading into memory
          const fs = await import('fs');
          const rs = fs.createReadStream(outputPath);

          // Ensure cleanup when the node stream ends or errors
          rs.on('end', async () => { try { await cleanTempNow(); } catch (_) {} });
          rs.on('error', async () => { try { await cleanTempNow(); } catch (_) {} });

          // Convert Node Readable to Web ReadableStream without copying buffers
          const webStream = Readable.toWeb(rs);

          {
            const disposition = buildContentDispositionAttachment(originalName, String(toStr));

            return new Response(webStream as unknown as BodyInit, {
              status: 200,
              headers: {
                'Content-Type': contentTypeForConverted,
                'Content-Disposition': disposition,
              },
            });
          }
        }

        // upload path: stream file as body to upload URL
        const finalUploadUrl = uploadUrlParam || uploadUrlFromForm || uploadUrlFromJson;
        if (!finalUploadUrl) {
          await cleanTempNow();
          return badRequest('When not using ?download you must provide uploadUrl as a query parameter, form field, or in the JSON body');
        }

        const fs = await import('fs');
        const rs = fs.createReadStream(outputPath);

        let uploadResp: Response;
        try {
          const uploadTimeoutMs = DEFAULT_TIMEOUT_MS;
          uploadResp = await withTimeout(async (signal) => {
            try { signal.addEventListener('abort', () => { try { rs.destroy(); } catch (_) {} }); } catch (_) {}

            const disposition = buildContentDispositionAttachment(originalName, String(toStr));

            const resp = await fetch(finalUploadUrl, {
              method: 'PUT',
              headers: {
                'Content-Type': contentTypeForConverted,
                'Content-Disposition': disposition,
              },
              body: rs as unknown as BodyInit,
              signal,
            });

            return resp;
          }, uploadTimeoutMs);
        } catch (err: unknown) {
          await cleanTempNow();
          const msg = err instanceof Error ? err.message : String(err);
          return new Response(JSON.stringify({ error: 'Failed to upload converted file', details: msg }), { status: 502, headers: { 'Content-Type': 'application/json' } });
        }

        // Repassar a resposta do upload ao cliente (whitelisted headers)
        const respArrayBuffer = await uploadResp.arrayBuffer();
        const forwardedHeaders: Record<string, string> = {};
        const allowed = new Set([
          'content-type',
          'content-length',
          'location',
          'etag',
          'last-modified',
          'content-disposition',
          'cache-control',
        ]);

        uploadResp.headers.forEach((value, key) => {
          const k = key.toLowerCase();
          if (allowed.has(k)) forwardedHeaders[key] = value;
        });

        await cleanTempNow();

        return new Response(respArrayBuffer, { status: uploadResp.status, headers: forwardedHeaders });
      }

      // Fallback: result contains convertedFile Buffer
      const converted = (result as { convertedFile: Buffer }).convertedFile;

      if (wantsDownload) {
        const body = converted.buffer.slice(converted.byteOffset, converted.byteOffset + converted.byteLength);

        {
          const disposition = buildContentDispositionAttachment(originalName, String(toStr));

          return new Response(body as ArrayBuffer, {
            status: 200,
            headers: {
              'Content-Type': 'application/octet-stream',
              'Content-Disposition': disposition,
            },
          });
        }
      }

      const finalUploadUrl = uploadUrlParam || uploadUrlFromForm || uploadUrlFromJson;
      if (!finalUploadUrl) {
        return badRequest('When not using ?download you must provide uploadUrl as a query parameter, form field, or in the JSON body');
      }

      const bodyForUpload = converted.buffer.slice(converted.byteOffset, converted.byteOffset + converted.byteLength);
      const contentTypeForConverted = toStr === 'pdf'
        ? 'application/pdf'
        : toStr === 'docx'
          ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          : 'application/octet-stream';

      let uploadResp: Response;
      // Upload buffer with timeout helper
      try {
        const uploadTimeoutMs = DEFAULT_TIMEOUT_MS;
        uploadResp = await withTimeout(async (signal) => {
          const disposition = buildContentDispositionAttachment(originalName, String(toStr));

          return await fetch(finalUploadUrl, {
            method: 'PUT',
            headers: {
              'Content-Type': contentTypeForConverted,
              'Content-Disposition': disposition,
            },
            body: bodyForUpload as ArrayBuffer,
            signal,
          });
        }, uploadTimeoutMs);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return new Response(JSON.stringify({ error: 'Failed to upload converted file', details: msg }), { status: 502, headers: { 'Content-Type': 'application/json' } });
      }

      const respArrayBuffer = await uploadResp.arrayBuffer();
      const forwardedHeaders: Record<string, string> = {};

      const allowed = new Set([
        'content-type',
        'content-length',
        'location',
        'etag',
        'last-modified',
        'content-disposition',
        'cache-control',
      ]);

      uploadResp.headers.forEach((value, key) => {
        const k = key.toLowerCase();
        if (allowed.has(k)) {
          forwardedHeaders[key] = value;
        }
      });

      return new Response(respArrayBuffer, { status: uploadResp.status, headers: forwardedHeaders });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return new Response(msg, { status: 500 });
    } finally {
      try {
        metrics.gaugeDec('api_requests_in_flight', 1);
        const dur = (Date.now() - reqStart) / 1000;
        try {
          const endpoint = new URL(req.url).pathname;
          metrics.histogramObserve('api_request_duration_seconds', dur, { endpoint });
        } catch (_) {
          metrics.histogramObserve('api_request_duration_seconds', dur);
        }
        try {
          const rss = typeof process !== 'undefined' && typeof process.memoryUsage === 'function' ? process.memoryUsage().rss : 0;
          metrics.gaugeSet('process_memory_rss_bytes', rss);
        } catch (_) {}
      } catch (_) {}
    }
  },
});

console.log(`Server listening on http://0.0.0.0:${port}`);

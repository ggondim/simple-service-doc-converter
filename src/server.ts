import { convertFile } from './lib/convert';

if (!globalThis.Headers) {
  // Bun provides Headers/Request/Response globally inside the runtime. This is a noop guard for other runtimes.
}

const port = parseInt(process.env.PORT || '3000', 10);

function badRequest(message: string) {
  return new Response(JSON.stringify({ error: message }), { status: 400, headers: { 'Content-Type': 'application/json' } });
}

function jsonResponse(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

const bun = (globalThis as any).Bun;

if (!bun || typeof bun.serve !== 'function') {
  throw new Error('This server must run on Bun.');
}

bun.serve({
  port,
  fetch: async (req: Request) => {
    try {
      const url = new URL(req.url);

      if (req.method !== 'POST' || url.pathname !== '/convert') {
        return new Response('Not Found', { status: 404 });
      }

      const contentType = req.headers.get('content-type') || '';
      if (!contentType.includes('multipart/form-data')) {
        return badRequest('Content-Type must be multipart/form-data');
      }

      const form = await req.formData();

  const file = form.get('file') as File | null;
  const from = (form.get('from') as string) || undefined;
  const to = (form.get('to') as string) || undefined;

      if (!file) return badRequest('Missing file field');
      if (!from || !to) return badRequest('Missing from or to fields');

      const arrayBuffer = await file.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      const result = await convertFile(buffer, from.replace(/^[.]/, ''), to.replace(/^[.]/, ''));

      if ('stderr' in result && result.stderr) {
        return jsonResponse({ error: 'Conversion error', details: result.stderr }, 500);
      }

      // agora é seguro acessar convertedFile
      const converted = (result as { convertedFile: Buffer }).convertedFile;
      const originalName = (file as File & { name?: string }).name || `converted.${to}`;

      // Bun/Fetch API aceita ArrayBuffer/Uint8Array como body; convertemos o Buffer
      const body = converted.buffer.slice(converted.byteOffset, converted.byteOffset + converted.byteLength);

      return new Response(body as ArrayBuffer, {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${originalName.replace(/\.[^.]+$/, '')}.${to}"`,
        },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return new Response(msg, { status: 500 });
    }
  },
});

console.log(`Server listening on http://0.0.0.0:${port}`);

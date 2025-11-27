import { spawn } from 'child_process';
import { writeFile, readFile, access } from 'fs/promises';
import FileTemp from '../common/class/FileTemp';
import pLimit from 'p-limit';
import { withTimeout } from '../common/withTimeout';

const limit = pLimit(parseInt(process.env.CONCURRENCY_LIMIT || '5', 10));

export type ConvertResult = { convertedFile: Buffer } | { outputPath: string } | { stdout?: string; stderr?: string };

type ConvertOptions = {
  // If provided, reuse the temp instance (server created it and wrote the input file there)
  temp?: FileTemp;
  // When true, do not load the converted file into memory and return the output path instead.
  keepTemp?: boolean;
  // Maximum time in ms to allow the conversion to run before killing the child process
  timeoutMs?: number;
  // Optional abort signal to cancel the conversion
  signal?: AbortSignal;
  // If true, stream stdout/stderr to console in real time
  verbose?: boolean;
};

export const convertFile = async (
  documentOrPath: Buffer | string,
  fromExt: string,
  toExt: string,
  options?: ConvertOptions,
): Promise<ConvertResult> => {
  return limit(async () => {
    const temp = options?.temp ?? new FileTemp();
    await temp.ready();

    try {
      const inputPath = typeof documentOrPath === 'string' ? documentOrPath : `${temp.filePath}.${fromExt}`;
      const outputPath = `${temp.filePath}.${toExt}`;

      if (typeof documentOrPath !== 'string') {
        // write buffer to inputPath
        await writeFile(inputPath, documentOrPath);
      }

      const args = ['--headless', '--convert-to', toExt, inputPath, '--outdir', temp.tempDir];

      let stdout = '';
      let stderr = '';

      // Run the child process under withTimeout so timeouts/aborts are unified.
      // Capture exit code/signal and implement a graceful kill sequence on abort
      let exitCode: number | null = null;
      let exitSignal: NodeJS.Signals | null = null;

      await withTimeout(async (signal) => {
        const child = spawn('soffice', args, { stdio: ['ignore', 'pipe', 'pipe'] });

        const onAbort = () => {
          try { if (!child.killed) child.kill('SIGTERM'); } catch (_) {}
          const grace = 2000; // ms before forcing kill
          const killTimer = setTimeout(() => {
            try { if (!child.killed) child.kill('SIGKILL'); } catch (_) {}
          }, grace);
          child.once('exit', () => { try { clearTimeout(killTimer); } catch (_) {} });
        };

        try { signal.addEventListener('abort', onAbort); } catch (_) {}

        if (child.stdout) {
          child.stdout.on('data', (chunk: Buffer) => {
            const s = chunk.toString();
            stdout += s;
            if (options?.verbose) console.log('[soffice stdout]', s);
          });
        }

        if (child.stderr) {
          child.stderr.on('data', (chunk: Buffer) => {
            const s = chunk.toString();
            stderr += s;
            if (options?.verbose) console.error('[soffice stderr]', s);
          });
        }

        await new Promise((resolve, reject) => {
          child.once('error', (err) => reject(err));
          child.once('close', (code, sig) => {
            exitCode = code === null ? null : code;
            exitSignal = sig as NodeJS.Signals | null;
            resolve({ code, signal: sig });
          });
        });

        try { signal.removeEventListener('abort', onAbort); } catch (_) {}
      }, options?.timeoutMs, options?.signal);

      // After process exit, check for output file
      try {
        await access(outputPath);
        if (options?.keepTemp) {
          return { outputPath };
        }
      } catch {
        // file not present — throw enriched error so caller can differentiate
        const e = new Error('No output file produced');
        (e as unknown as Record<string, unknown>)['stderr'] = stderr;
        (e as unknown as Record<string, unknown>)['stdout'] = stdout;
        (e as unknown as Record<string, unknown>)['code'] = exitCode;
        (e as unknown as Record<string, unknown>)['signal'] = exitSignal;
        throw e;
      }

      try {
        const convertedFile = await readFile(outputPath);
        return { convertedFile };
      } catch (readErr) {
        const e = new Error('Failed to read converted file');
        (e as unknown as Record<string, unknown>)['stderr'] = stderr;
        (e as unknown as Record<string, unknown>)['stdout'] = stdout;
        (e as unknown as Record<string, unknown>)['code'] = exitCode;
        (e as unknown as Record<string, unknown>)['signal'] = exitSignal;
        (e as unknown as Record<string, unknown>)['cause'] = readErr as unknown;
        throw e;
      }
    } finally {
      // only clean temp here if caller did not ask to keep it
      if (!options?.keepTemp) {
        try { await temp.cleanFileOnTmpFolder(); } catch (_) {}
      }
    }
  });
};

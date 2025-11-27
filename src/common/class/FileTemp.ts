import { mkdtemp, rm, access } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

export default class FileTemp {
  tempDir: string;
  filePath: string;
  fast: boolean;

  constructor(prefix = 'doc-conv-') {
    // will be initialized by init()
    this.tempDir = '';
    this.filePath = '';
    this.fast = false;
    this._initialized = this.init(prefix);
  }

  _initialized: Promise<void>;

  // Determine a fast temporary directory when possible (e.g. /dev/shm or FAST_TMP_DIR env).
  private async chooseBaseDir() {
    const candidate = process.env.FAST_TMP_DIR || '/dev/shm';
    if (candidate) {
      try {
        // check we can access and write to candidate
        await access(candidate);
        return { dir: candidate, fast: candidate === '/dev/shm' };
      } catch {
        // ignore and fallthrough to os.tmpdir()
      }
    }
    return { dir: tmpdir(), fast: false };
  }

  async init(prefix: string) {
    const { dir, fast } = await this.chooseBaseDir();
    try {
      const base = await mkdtemp(join(dir, prefix));
      this.tempDir = base;
      this.fast = fast;
      // base file path without extension
      this.filePath = join(base, 'file');
    } catch {
      // fallback to system tmpdir if mkdtemp with candidate fails
      const base = await mkdtemp(join(tmpdir(), prefix));
      this.tempDir = base;
      this.fast = false;
      this.filePath = join(base, 'file');
    }
  }

  async ready() {
    return this._initialized;
  }

  async cleanFileOnTmpFolder() {
    if (!this.tempDir) return;
    try {
      await rm(this.tempDir, { recursive: true, force: true });
    } catch {
      // ignore errors during cleanup
    }
  }
}

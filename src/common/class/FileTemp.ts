import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

export default class FileTemp {
  tempDir: string;
  filePath: string;

  constructor(prefix = 'doc-conv-') {
    // will be initialized by init()
    this.tempDir = '';
    this.filePath = '';
    this._initialized = this.init(prefix);
  }

  _initialized: Promise<void>;

  async init(prefix: string) {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    this.tempDir = dir;
    // base file path without extension
    this.filePath = join(dir, 'file');
  }

  async ready() {
    return this._initialized;
  }

  async cleanFileOnTmpFolder() {
    if (!this.tempDir) return;
    try {
      await rm(this.tempDir, { recursive: true, force: true });
    } catch (err) {
      // ignore errors during cleanup
    }
  }
}

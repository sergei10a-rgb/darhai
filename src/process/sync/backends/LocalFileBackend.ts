import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeFileSyncAtomic } from '@process/utils/atomicWrite';

/** Reads/writes a single encrypted blob file at a user-specified path. */
export class LocalFileBackend {
  private readonly filePath: string;

  constructor(dirPath: string) {
    this.filePath = path.join(dirPath, 'wayland-sync.enc');
  }

  /** Read the raw encrypted blob. Returns null if the file doesn't exist. */
  read(): Buffer | null {
    try {
      return fs.readFileSync(this.filePath);
    } catch {
      return null;
    }
  }

  /**
   * Write the raw encrypted blob atomically. Uses the shared helper so a
   * pid-stamped tmp avoids two writers clobbering each other, and the Windows
   * rename-over-open-file fallback keeps the sync blob from being lost when
   * another process holds it open for reading.
   */
  write(data: Buffer): void {
    writeFileSyncAtomic(this.filePath, data);
  }
}

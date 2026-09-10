import path from 'node:path';
import { restoreSnapshot } from '../src/archive.js';
import { renderOutput } from '../src/render.js';
import { withBackupLock } from '../src/storage.js';

try {
  const [archive = 'archive', destination = 'restored-output', snapshot, media] = process.argv.slice(2);
  withBackupLock(process.cwd(), () => {
    restoreSnapshot(path.resolve(archive), path.resolve(destination), snapshot === 'latest' ? undefined : snapshot, media ? path.resolve(media) : undefined);
    renderOutput(path.resolve(destination));
    console.log(`Restored and verified: ${path.resolve(destination)}. Existing output was not replaced.`);
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

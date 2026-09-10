import path from 'node:path';
import { compactArchive } from '../src/zip-output.js';
import { withBackupLock } from '../src/storage.js';

try {
  const backup = process.argv[2];
  if (!backup) throw new Error('Pass a full backup downloaded from your offsite storage: npm run compact-archive -- /path/to/downloaded.zip');
  withBackupLock(process.cwd(), () => {
    const result = compactArchive(path.resolve('output'), path.resolve('archive'), path.resolve(backup));
    console.log(`Removed ${result.removedFiles} verified duplicate media objects (${result.removedBytes} bytes). Messages, sources and snapshots retained.`);
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

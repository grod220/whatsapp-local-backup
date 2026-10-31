import path from 'node:path';
import { DirectoryBackupStore } from '../src/backup-store.js';
import { recoverIncrementalBackup, recoverLocalCheckpoint } from '../src/incremental.js';

try {
  const [repository, destination, flag] = process.argv.slice(2);
  if (!repository || !destination || (flag && flag !== '--local')) throw new Error('Usage: npm run recover-incremental -- BACKUP_FOLDER NEW_DIRECTORY [--local]');
  if (flag === '--local') recoverLocalCheckpoint(path.resolve(repository), path.resolve(destination));
  else recoverIncrementalBackup(new DirectoryBackupStore(path.resolve(repository)), path.resolve(destination));
  console.log(`Verified and recovered into ${path.resolve(destination)}`);
} catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }

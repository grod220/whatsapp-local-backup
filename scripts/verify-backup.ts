import path from 'node:path';
import { verifyPortableBackup } from '../src/zip-output.js';

try {
  const backup = process.argv[2];
  if (!backup) throw new Error('Usage: npm run verify-backup -- /path/to/backup.zip');
  console.log(JSON.stringify(verifyPortableBackup(path.resolve(backup)), null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

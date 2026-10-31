import { deployOutput } from '../src/deploy.js';
import { withBackupLock } from '../src/storage.js';

try { withBackupLock(process.cwd(), () => deployOutput()); } catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

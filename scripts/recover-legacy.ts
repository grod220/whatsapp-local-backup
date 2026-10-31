import fs from 'node:fs';
import path from 'node:path';
import { publishNewDirectory } from '../src/storage.js';
import { recoverHistoricalFiles } from '../src/backup-containers.js';

try {
  const [workspace, snapshotName, target] = process.argv.slice(2);
  if (!workspace || !snapshotName || !target || path.basename(snapshotName) !== snapshotName) throw new Error('Usage: npm run recover-legacy -- RECOVERED_WORKSPACE DATED_LEGACY_SNAPSHOT.json NEW_DIRECTORY');
  const destination = path.resolve(target);
  if (fs.existsSync(destination)) throw new Error('Recovery destination already exists; choose a new directory');
  const manifest = JSON.parse(fs.readFileSync(path.join(workspace, 'archive/legacy-recovery/snapshots', snapshotName), 'utf8'));
  if (manifest.format !== 'clemcast-legacy-recovery' || manifest.version !== 1 || !manifest.files || !manifest.locations) throw new Error('Invalid migrated recovery snapshot');
  const temporary = fs.mkdtempSync(path.join(path.dirname(destination), '.clemcast-legacy-recovery-'));
  try {
    recoverHistoricalFiles(workspace, manifest.files, manifest.locations, temporary);
    publishNewDirectory(temporary, destination);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  console.log(`Recovered earlier backup into ${destination}`);
} catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }

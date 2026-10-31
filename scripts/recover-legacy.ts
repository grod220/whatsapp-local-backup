import fs from 'node:fs';
import path from 'node:path';
import { sha256, writeImmutable, publishNewDirectory } from '../src/storage.js';
import { safeRelative } from '../src/backup-store.js';

try {
  const [workspace, snapshotName, target] = process.argv.slice(2);
  if (!workspace || !snapshotName || !target || path.basename(snapshotName) !== snapshotName) throw new Error('Usage: npm run recover-legacy -- RECOVERED_WORKSPACE DATED_LEGACY_SNAPSHOT.json NEW_DIRECTORY');
  const destination = path.resolve(target);
  if (fs.existsSync(destination)) throw new Error('Recovery destination already exists; choose a new directory');
  const manifest = JSON.parse(fs.readFileSync(path.join(workspace, 'archive/legacy-recovery/snapshots', snapshotName), 'utf8'));
  if (manifest.format !== 'clemcast-legacy-recovery' || manifest.version !== 1 || !manifest.files || !manifest.locations) throw new Error('Invalid migrated recovery snapshot');
  const temporary = fs.mkdtempSync(path.join(path.dirname(destination), '.clemcast-legacy-recovery-'));
  try {
    for (const [name, hash] of Object.entries(manifest.files)) {
      if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid migrated file hash');
      const bytes = fs.readFileSync(path.join(workspace, safeRelative(manifest.locations[hash])));
      if (sha256(bytes) !== hash) throw new Error('Migrated recovery file checksum mismatch');
      writeImmutable(path.join(temporary, safeRelative(name)), bytes);
    }
    publishNewDirectory(temporary, destination);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  console.log(`Recovered earlier backup into ${destination}`);
} catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }

import fs from 'node:fs';
import path from 'node:path';
import { auditSources, captureSnapshot, sourcesDirectory } from '../src/archive.js';
import { importBackup, loadGroup, validateOutput } from '../src/importer.js';
import { renderOutput } from '../src/render.js';
import { verifyPortableBackup } from '../src/zip-output.js';
import { withBackupLock } from '../src/storage.js';

try {
  const [group, backup, ...assignments] = process.argv.slice(2);
  if (!group || !backup || !/^[a-z0-9-]+$/.test(group) || !assignments.length) throw new Error('Usage: npm run migrate -- GROUP VERIFIED_COMPLETE_BACKUP.zip SOURCE_HASH=TIMEZONE [...]');
  const zones = assignments.map(assignment => {
    const match = assignment.match(/^([a-f0-9]{64})=(.+)$/);
    if (!match) throw new Error(`Invalid source timezone assignment: ${assignment}`);
    new Intl.DateTimeFormat('en', { timeZone: match[2]! }).format();
    return { hash: match[1]!, timeZone: match[2]! };
  });
  withBackupLock(process.cwd(), () => {
    const output = path.resolve('output'), archive = path.resolve('archive');
    validateOutput(output);
    const verified = verifyPortableBackup(path.resolve(backup), output, archive);
    if (!verified.sourcesIncluded) throw new Error('Migration requires a complete backup containing the original exports');
    const originals = auditSources(archive);
    const before = fs.readFileSync(path.join(output, group, 'data.json'));
    const previous = loadGroup(path.join(output, group));
    captureSnapshot(output, archive);
    for (const { hash, timeZone } of zones) {
      if (!originals.sources.some(s => s.sha256 === hash)) throw new Error(`Unknown retained source: ${hash}`);
      const current = path.join(sourcesDirectory(archive), `${hash}.zip`);
      const source = fs.existsSync(current) ? current : path.join(archive, 'sources', `${hash}.zip`);
      importBackup(source, output, archive, { group, timeZone, evidenceOnly: true });
      captureSnapshot(output, archive);
    }
    if (!fs.readFileSync(path.join(output, group, 'data.json')).equals(before)) throw new Error('Migration changed legacy data');
    const after = loadGroup(path.join(output, group));
    for (const [hash, filename] of Object.entries(previous.manifest.contentHashes)) {
      if (after.manifest.contentHashes[hash] !== filename) throw new Error('Migration changed a preserved attachment reference');
    }
    renderOutput(output); captureSnapshot(output, archive);
    console.log(`Migration verified: all ${previous.messages.length} legacy records and attachment references retained. Create a new complete recovery backup before publishing.`);
  });
} catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }

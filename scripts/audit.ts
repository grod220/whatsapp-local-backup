import path from 'node:path';
import { auditArchive, auditSources } from '../src/archive.js';
import { validateOutput } from '../src/importer.js';
import { verifyViews } from '../src/verify-views.js';
import { withBackupLock } from '../src/storage.js';

try {
  withBackupLock(process.cwd(), () => {
    const output = path.resolve('output'), archive = path.resolve('archive');
    validateOutput(output); verifyViews(output);
    const history = auditArchive(output, archive), sources = auditSources(archive);
    if (sources.missing.length) throw new Error(`Missing original exports: ${sources.missing.join(', ')}`);
    console.log(`Verified all reading views, source observations, ${history.snapshots.length} snapshots, ${history.mediaHashes.size} media hashes and ${sources.sources.length} original exports.`);
  });
} catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }

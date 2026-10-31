import path from 'node:path';
import { captureSnapshot } from '../src/archive.js';
import { validateOutput } from '../src/importer.js';
import { renderOutput } from '../src/render.js';
import { withBackupLock } from '../src/storage.js';
import { createOutputZip, createRecoveryZip } from '../src/zip-output.js';
import { generateOutputZipPath, getDesktopPath } from '../src/discovery.js';

try {
  withBackupLock(process.cwd(), () => {
    const output = path.resolve('output');
    const archive = path.resolve('archive');
    validateOutput(output);
    if (!captureSnapshot(output, archive)) throw new Error('No existing archive to back up. Import an export first.');
    renderOutput(output);
    captureSnapshot(output, archive);
    const args = process.argv.slice(2);
    const reader = args.includes('--reader');
    const destination = args.find(arg => arg !== '--reader') ?? generateOutputZipPath(getDesktopPath());
    (reader ? createOutputZip : createRecoveryZip)(output, path.resolve(destination), archive);
    console.log(`Verified cumulative backup: ${path.resolve(destination)}`);
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

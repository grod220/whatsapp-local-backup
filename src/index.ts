import fs from 'node:fs';
import path from 'node:path';
import { captureSnapshot } from './archive.js';
import { importBackup, validateOutput, type ImportOptions } from './importer.js';
import { renderOutput } from './render.js';
import { withBackupLock } from './storage.js';
import { discoverWhatsAppZips, getDownloadsPath } from './discovery.js';
import { backupAndPublish } from './publication.js';

function run(): void {
  const configPath = path.resolve('clemcast.config.json');
  const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
  const options: ImportOptions = { ...(config.timeZone && { defaultTimeZone: config.timeZone }) };
  let backupPath: string | undefined;
  let localOnly = false;
  const paths: string[] = [];
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--group') {
      const group = args[++i];
      if (!group) throw new Error('--group requires an existing group slug');
      options.group = group;
    } else if (arg === '--backup-to') {
      backupPath = args[++i];
      if (!backupPath) throw new Error('--backup-to requires a new ZIP file path');
    } else if (arg === '--local-only') localOnly = true;
    else if (arg === '--days-first') options.daysFirst = true;
    else if (arg === '--months-first') options.daysFirst = false;
    else if (arg === '--timezone') {
      const timeZone = args[++i];
      if (!timeZone) throw new Error('--timezone requires an IANA timezone, such as Europe/Rome');
      options.timeZone = timeZone;
    }
    else if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
    else paths.push(arg);
  }
  const zipPaths = paths.length ? paths : discoverWhatsAppZips(getDownloadsPath());
  const outputDir = path.resolve('output');
  const archiveDir = path.resolve('archive');
  if (!zipPaths.length && !fs.existsSync(path.join(archiveDir, 'latest.json'))) throw new Error('No WhatsApp export ZIPs found in Downloads. Use npm run parse -- <file.zip> [file2.zip ...].');
  withBackupLock(process.cwd(), () => {
    // Snapshot the old state before importing anything, including a legacy archive.
    validateOutput(outputDir);
    captureSnapshot(outputDir, archiveDir);
    fs.mkdirSync(outputDir, { recursive: true });
    let failed = 0;
    if (!zipPaths.length) console.log('No new exports found. Backing up and publishing the existing archive.');
    for (const zipPath of zipPaths) {
      try {
        importBackup(zipPath, outputDir, archiveDir, options);
      } catch (error) {
        failed++;
        console.error(`Failed to import ${path.basename(zipPath)}: ${error instanceof Error ? error.message : error}`);
        continue;
      }
      // A checkpoint failure stops the entire run before another import or publication.
      captureSnapshot(outputDir, archiveDir);
    }
    if (failed) throw new Error(`${failed} import(s) failed. Retained data was not deleted. Resolve the failures and rerun; successful imports are safe to repeat.`);
    validateOutput(outputDir);
    renderOutput(outputDir);
    captureSnapshot(outputDir, archiveDir);
    backupAndPublish(process.cwd(), config.driveBackup, { localOnly,
      ...(backupPath && { fullZipPath: backupPath }), ...(config.timeZone && { timeZone: config.timeZone }) });
  });
}

try { run(); } catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

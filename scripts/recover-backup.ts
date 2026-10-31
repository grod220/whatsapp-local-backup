import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { verifyPortableBackup } from '../src/zip-output.js';
import { validateOutput } from '../src/importer.js';
import { auditArchive, auditSources } from '../src/archive.js';
import { writeImmutable } from '../src/storage.js';

try {
  const [filename, target] = process.argv.slice(2);
  if (!filename || !target) throw new Error('Usage: npm run recover -- BACKUP.zip NEW_DIRECTORY');
  const destination = path.resolve(target);
  if (fs.existsSync(destination)) throw new Error('Recovery destination already exists; choose a new directory');
  const verified = verifyPortableBackup(path.resolve(filename));
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of new AdmZip(path.resolve(filename)).getEntries()) {
    if (entry.isDirectory) continue;
    writeImmutable(path.join(destination, entry.entryName), entry.getData());
  }
  validateOutput(path.join(destination, 'output'));
  auditArchive(path.join(destination, 'output'), path.join(destination, 'archive'));
  const originals = auditSources(path.join(destination, 'archive'));
  console.log(JSON.stringify({ destination, ...verified, recoveredOriginals: originals.sources.length - originals.missing.length, missingOriginals: originals.missing.length }, null, 2));
} catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }

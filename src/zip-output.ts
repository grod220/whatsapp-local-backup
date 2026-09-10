import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { auditArchive, canonicalFiles, latestSnapshotHash, objectPath, readObject, readSnapshot, sourceInventory } from './archive.js';
import { isSafeFilename, sha256, writeImmutable } from './storage.js';

interface PortableManifest {
  format: 'clemcast-portable';
  version: 2;
  files: Record<string, string>;
  sourcesIncluded: false;
  separateSources: Array<{ sha256: string; originalNames: string[] }>;
}

const RECOVERY_README = `CLEMCAST BACKUP\n\nOpen output/index.html in a browser to read your chats offline.\n\nThis ZIP contains the cumulative messages and media, plus every retained\nmessage/metadata snapshot. Each media file is stored in output/ only.\nbackup.json contains SHA-256 checksums for every file in the ZIP.\n\nTo resume importing on another computer, copy both output/ and archive/\ninto the Clemcast project. Keep previous backups.\n\nTo restore a historical snapshot using the project:\n  npm run restore -- /path/to/unpacked/archive recovered-output SNAPSHOT_HASH\nThe adjacent unpacked output/ supplies the verified media. The restore\ncommand never replaces an existing directory.\n\nOriginal WhatsApp export ZIPs are stored separately in sources/ on the\noriginal computer. They are NOT included here. backup.json lists their\nhashes and original names. Save each original export offsite once; keep\nthose originals for reparsing. This ZIP can restore the cumulative viewer\nand its history without the originals, but cannot recreate the source ZIPs.\n\nMetadata snapshots can repair message history using intact media. If media\nis lost or damaged locally, recover it from a complete offsite backup.\n`;

/** Verify all snapshots before omitting any duplicate media object. */
function portableFiles(outputDir: string, archiveDir: string): Map<string, string> {
  const inventory = auditArchive(outputDir, archiveDir);
  const latest = readSnapshot(archiveDir, latestSnapshotHash(archiveDir));
  const current = canonicalFiles(outputDir);
  if (current.length !== Object.keys(latest.files).length) throw new Error('Capture a snapshot of the current output before packaging');
  for (const relative of current) {
    if (sha256(fs.readFileSync(path.join(outputDir, relative))) !== latest.files[relative]) {
      throw new Error(`Output changed since its snapshot: ${relative}`);
    }
  }
  const files = new Map<string, string>();
  const walk = (directory: string, prefix: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.DS_Store' || /\.[a-f0-9-]{36}\.tmp$/.test(entry.name)) continue;
      const relative = `${prefix}/${entry.name}`;
      const fullPath = path.join(directory, entry.name);
      if (relative === 'archive/sources') continue; // Legacy originals also stay separate.
      if (prefix === 'archive/objects' && inventory.mediaHashes.has(entry.name) && !inventory.metadataHashes.has(entry.name)) {
        readObject(archiveDir, entry.name); // Detect damaged legacy objects before excluding them.
        continue;
      }
      if (entry.isDirectory()) walk(fullPath, relative);
      else if (entry.isFile()) files.set(relative, fullPath);
      else throw new Error(`Unexpected non-regular file in backup: ${fullPath}`);
    }
  };
  walk(outputDir, 'output');
  walk(archiveDir, 'archive');
  return files;
}

/** Portable v2 keeps the browsable output and metadata history, with media stored once. */
export function createOutputZip(sourceDir: string, outputPath: string, archiveDir: string): void {
  if (fs.existsSync(outputPath)) throw new Error(`Backup already exists: ${outputPath}`);
  for (const dir of [sourceDir, archiveDir]) {
    if (path.resolve(outputPath).startsWith(path.resolve(dir) + path.sep)) throw new Error('Save the backup outside output/ and archive/');
  }
  const zip = new AdmZip();
  const hashes: Record<string, string> = {};
  for (const [relative, filename] of portableFiles(sourceDir, archiveDir)) {
    const bytes = fs.readFileSync(filename);
    hashes[relative] = sha256(bytes);
    zip.addFile(relative, bytes);
  }
  hashes['README.txt'] = sha256(RECOVERY_README);
  zip.addFile('README.txt', Buffer.from(RECOVERY_README));
  const manifest: PortableManifest = {
    format: 'clemcast-portable', version: 2, files: hashes,
    sourcesIncluded: false, separateSources: sourceInventory(archiveDir),
  };
  zip.addFile('backup.json', Buffer.from(JSON.stringify(manifest, null, 2)));
  const bytes = zip.toBuffer();
  verifyZip(new AdmZip(bytes));
  writeImmutable(outputPath, bytes);
  console.log(`Portable v2: media included once; ${manifest.separateSources.length} original export ZIP(s) retained separately.`);
}

function verifyZip(zip: AdmZip): PortableManifest {
  const entry = zip.getEntry('backup.json');
  if (!entry) throw new Error('Not a versioned portable backup: backup.json is missing');
  const manifest = JSON.parse(entry.getData().toString('utf8')) as PortableManifest;
  if (manifest.format !== 'clemcast-portable' || manifest.version !== 2 || !manifest.files || Array.isArray(manifest.files)) {
    throw new Error('Unsupported portable backup format');
  }
  const entries = zip.getEntries().filter(entry => !entry.isDirectory);
  const names = new Set(entries.map(entry => entry.entryName));
  if (names.size !== entries.length || names.size !== Object.keys(manifest.files).length + 1) throw new Error('Backup file inventory mismatch');
  for (const [relative, hash] of Object.entries(manifest.files)) {
    if (!relative.split('/').every(isSafeFilename) || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid backup inventory');
    const file = zip.getEntry(relative);
    if (!file || sha256(file.getData()) !== hash) throw new Error(`Backup checksum mismatch: ${relative}`);
  }
  return manifest;
}

/** Verify stored bytes; optionally require all live data and retained history to be covered. */
export function verifyPortableBackup(filename: string, outputDir?: string, archiveDir?: string): { sha256: string; bytes: number; files: number } {
  const bytes = fs.readFileSync(filename);
  const manifest = verifyZip(new AdmZip(bytes));
  if (outputDir && archiveDir) {
    for (const [relative, file] of portableFiles(outputDir, archiveDir)) {
      if (manifest.files[relative] !== sha256(fs.readFileSync(file))) throw new Error(`Backup does not cover current history: ${relative}`);
    }
    if (JSON.stringify(manifest.separateSources) !== JSON.stringify(sourceInventory(archiveDir))) throw new Error('Backup source inventory is out of date');
  }
  return { sha256: sha256(bytes), bytes: bytes.length, files: Object.keys(manifest.files).length };
}

/** Run only after an offsite copy has been downloaded and verified. Never delete originals or snapshots. */
export function compactArchive(outputDir: string, archiveDir: string, downloadedBackup: string): { removedFiles: number; removedBytes: number } {
  verifyPortableBackup(downloadedBackup, outputDir, archiveDir);
  const inventory = auditArchive(outputDir, archiveDir);
  const duplicates: Array<{ filename: string; bytes: number }> = [];
  for (const hash of inventory.mediaHashes) {
    if (inventory.metadataHashes.has(hash)) continue; // Some objects may serve both roles.
    const filename = objectPath(archiveDir, hash);
    if (!fs.existsSync(filename)) continue;
    const bytes = readObject(archiveDir, hash).length;
    duplicates.push({ filename, bytes });
  }
  // All local media, archive references and backup bytes have passed before the first removal.
  for (const file of duplicates) fs.unlinkSync(file.filename);
  return { removedFiles: duplicates.length, removedBytes: duplicates.reduce((sum, file) => sum + file.bytes, 0) };
}

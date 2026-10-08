import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { auditArchive, auditSources, canonicalFiles, isMediaPath, latestSnapshotHash, objectPath, parseSnapshot, parseSourceReceipt, readObject, readSnapshot, sourceInventory } from './archive.js';
import { readGroupFiles } from './importer.js';
import { isSafeFilename, sha256, writeImmutable } from './storage.js';

interface PortableManifest {
  format: 'clemcast-portable';
  version: 2;
  files: Record<string, string>;
  sourcesIncluded: false;
  separateSources: Array<{ sha256: string; originalNames: string[] }>;
  // Absent in older v2 backups, whose original-source availability was not checked.
  missingSources?: string[];
}

const RECOVERY_README = `CLEMCAST BACKUP\n\nOpen output/index.html in a browser to read your chats offline.\n\nThis ZIP contains the cumulative messages and media, plus every retained\nmessage/metadata snapshot. Each media file is stored in output/ only.\nbackup.json contains SHA-256 checksums for every file in the ZIP.\n\nTo resume importing on another computer, copy both output/ and archive/\ninto the Clemcast project. Keep previous backups.\n\nTo restore a historical snapshot using the project:\n  npm run restore -- /path/to/unpacked/archive recovered-output SNAPSHOT_HASH\nThe adjacent unpacked output/ supplies the verified media. The restore\ncommand never replaces an existing directory.\n\nOriginal WhatsApp export ZIPs are stored separately in sources/ on the\noriginal computer. They are NOT included here. backup.json lists their\nhashes and original names; missingSources records originals missing locally\nwhen this backup was created. Older v2 backups did not check availability.\nSave each original export offsite once; keep\nthose originals for reparsing. This ZIP can restore the cumulative viewer\nand its history without the originals, but cannot recreate the source ZIPs.\n\nMetadata snapshots can repair message history using intact media. If media\nis lost or damaged locally, recover it from a complete offsite backup.\n`;

/** Verify all snapshots before omitting any duplicate media object. */
function portableFiles(outputDir: string, archiveDir: string): Map<string, string> {
  const inventory = auditArchive(outputDir, archiveDir);
  const requiredOutputFiles = new Set(inventory.snapshots.flatMap(id =>
    Object.keys(readSnapshot(archiveDir, id).files).map(relative => `output/${relative}`)));
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
      const relative = `${prefix}/${entry.name}`;
      // A file already referenced by a snapshot must survive, even if its name
      // looks like Finder metadata or a leftover temporary write.
      if ((entry.name === '.DS_Store' || /\.[a-f0-9-]{36}\.tmp$/.test(entry.name)) && !requiredOutputFiles.has(relative)) continue;
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
  const originals = auditSources(archiveDir);
  if (originals.missing.length) {
    console.warn(`Warning: ${originals.missing.length} original export ZIP(s) missing locally: ${originals.missing.join(', ')}. Recover them from your separate source backup. The cumulative backup still preserves the saved messages and media.`);
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
    sourcesIncluded: false, separateSources: originals.sources, missingSources: originals.missing,
  };
  zip.addFile('backup.json', Buffer.from(JSON.stringify(manifest, null, 2)));
  const bytes = zip.toBuffer();
  verifyZip(new AdmZip(bytes));
  writeImmutable(outputPath, bytes);
  console.log(`Portable v2: media included once; ${originals.sources.length - originals.missing.length} original export ZIP(s) verified locally and retained separately; ${originals.missing.length} missing. Originals are not included in this ZIP.`);
}

function verifyZip(zip: AdmZip): PortableManifest {
  const entry = zip.getEntry('backup.json');
  if (!entry) throw new Error('Not a versioned portable backup: backup.json is missing');
  const manifest = JSON.parse(entry.getData().toString('utf8')) as PortableManifest;
  if (manifest.format !== 'clemcast-portable' || manifest.version !== 2 || !manifest.files
    || typeof manifest.files !== 'object' || Array.isArray(manifest.files) || manifest.sourcesIncluded !== false
    || !Array.isArray(manifest.separateSources)) {
    throw new Error('Unsupported portable backup format');
  }
  const entries = zip.getEntries().filter(entry => !entry.isDirectory);
  const names = new Set(entries.map(entry => entry.entryName));
  if (names.size !== entries.length || names.size !== Object.keys(manifest.files).length + 1) throw new Error('Backup file inventory mismatch');
  for (const [relative, hash] of Object.entries(manifest.files)) {
    if (relative === 'backup.json' || !relative.split('/').every(isSafeFilename)
      || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid backup inventory');
    const file = zip.getEntry(relative);
    if (!file || sha256(file.getData()) !== hash) throw new Error(`Backup checksum mismatch: ${relative}`);
  }
  verifyRecovery(zip, manifest);
  return manifest;
}

/** Independently follow recovery references; the ZIP's own inventory can be incomplete. */
function verifyRecovery(zip: AdmZip, manifest: PortableManifest): void {
  const read = (relative: string, hash?: string): Buffer => {
    const entry = zip.getEntry(relative);
    if (!entry || entry.isDirectory || !Object.hasOwn(manifest.files, relative)) throw new Error(`Backup recovery file is missing: ${relative}`);
    if (hash && manifest.files[relative] !== hash) throw new Error(`Backup recovery checksum mismatch: ${relative}`);
    return entry.getData();
  };
  const latest: unknown = JSON.parse(read('archive/latest.json').toString('utf8')).snapshot;
  if (typeof latest !== 'string' || !/^[a-f0-9]{64}$/.test(latest)) throw new Error('Invalid latest snapshot in backup');
  // Require the pointer's target even when the supplied inventory omits it.
  read(`archive/snapshots/${latest}.json`, latest);
  for (const relative of Object.keys(manifest.files).filter(name => /^archive\/objects\/[a-f0-9]{64}$/.test(name))) {
    read(relative, relative.slice('archive/objects/'.length));
  }
  const snapshots = Object.keys(manifest.files).filter(name => /^archive\/snapshots\/[a-f0-9]{64}\.json$/.test(name));
  for (const filename of snapshots) {
    const hash = path.posix.basename(filename, '.json');
    const snapshot = parseSnapshot(read(filename, hash), hash);
    const readSnapshotFile = (relative: string): Buffer => {
      const expected = snapshot.files[relative];
      if (!expected) throw new Error(`Snapshot recovery file is missing: ${relative}`);
      const object = `archive/objects/${expected}`;
      // Match restoreSnapshot's legacy-object preference exactly.
      return read(!isMediaPath(relative) || zip.getEntry(object) ? object : `output/${relative}`, expected);
    };
    if (!Object.keys(snapshot.files).length) throw new Error('Empty recovery snapshot in backup');
    for (const relative of Object.keys(snapshot.files)) {
      readSnapshotFile(relative);
      if (hash === latest && manifest.files[`output/${relative}`] !== snapshot.files[relative]) {
        throw new Error(`Latest output recovery file is missing or changed: ${relative}`);
      }
    }
    const groups = new Set(Object.keys(snapshot.files).map(relative => relative.split('/')[0]!));
    for (const group of groups) readGroupFiles(`snapshot ${hash}/${group}`, relative => readSnapshotFile(`${group}/${relative}`));
  }
  const sources = new Map<string, Set<string>>();
  for (const filename of Object.keys(manifest.files).filter(name => /^archive\/receipts\/[a-f0-9]{64}\.json$/.test(name))) {
    const receipt = parseSourceReceipt(read(filename), path.posix.basename(filename, '.json'));
    if (!sources.has(receipt.sha256)) sources.set(receipt.sha256, new Set());
    sources.get(receipt.sha256)!.add(receipt.originalName);
  }
  const inventory = [...sources].sort(([a], [b]) => a.localeCompare(b))
    .map(([sha256, names]) => ({ sha256, originalNames: [...names].sort() }));
  if (JSON.stringify(inventory) !== JSON.stringify(manifest.separateSources)) throw new Error('Backup source receipts do not match its source inventory');
  if (manifest.missingSources !== undefined && (!Array.isArray(manifest.missingSources)
    || new Set(manifest.missingSources).size !== manifest.missingSources.length
    || manifest.missingSources.some(hash => !sources.has(hash)))) throw new Error('Invalid missing source inventory');
}

/** Verify bytes and recovery of every snapshot; optionally require all live history to be covered. */
export function verifyPortableBackup(filename: string, outputDir?: string, archiveDir?: string): {
  sha256: string; bytes: number; files: number;
  originalExports: { listed: number; missingAtCreation: number | null };
} {
  const bytes = fs.readFileSync(filename);
  const manifest = verifyZip(new AdmZip(bytes));
  if (outputDir && archiveDir) {
    for (const [relative, file] of portableFiles(outputDir, archiveDir)) {
      if (manifest.files[relative] !== sha256(fs.readFileSync(file))) throw new Error(`Backup does not cover current history: ${relative}`);
    }
    if (JSON.stringify(manifest.separateSources) !== JSON.stringify(sourceInventory(archiveDir))) throw new Error('Backup source inventory is out of date');
  }
  return {
    sha256: sha256(bytes), bytes: bytes.length, files: Object.keys(manifest.files).length,
    originalExports: { listed: manifest.separateSources.length, missingAtCreation: manifest.missingSources?.length ?? null },
  };
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

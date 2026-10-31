import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { auditArchive, auditSources, canonicalFiles, isMediaPath, latestSnapshotHash, objectPath, parseSnapshot, parseSourceReceipt, readObject, readSnapshot, sourceInventory, sourcesDirectory } from './archive.js';
import { readGroupFiles, validateOutput } from './importer.js';
import { captureSnapshot } from './archive.js';
import { isSafeFilename, sha256, writeImmutable } from './storage.js';
import { verifyViews } from './verify-views.js';
import { assertExpansionMatches, descriptorPath, flattenBackupContainers, parseExpandedBackup, type ExpandedBackup } from './backup-containers.js';

interface PortableManifest {
  format: 'clemcast-portable';
  version: 2 | 3 | 4;
  files: Record<string, string>;
  sourcesIncluded: boolean;
  separateSources: Array<{ sha256: string; originalNames: string[] }>;
  // Absent in older v2 backups, whose original-source availability was not checked.
  missingSources?: string[];
  toolingIncluded?: boolean;
  expandedContainers?: Record<string, string>;
}

export const RECOVERY_TOOLING_PATHS = ['src', 'scripts', 'tests', 'package.json', 'package-lock.json', 'tsconfig.json', 'README.md', 'CONTEXT.md', 'clemcast.config.json', '.gitignore'];

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
  createBackupZip(sourceDir, outputPath, archiveDir, false);
}

export function createRecoveryZip(sourceDir: string, outputPath: string, archiveDir: string): void {
  createBackupZip(sourceDir, outputPath, archiveDir, true);
}

/** All recovery inputs shared by portable ZIPs and incremental repositories. */
export function collectRecoveryFiles(sourceDir: string, archiveDir: string, includeSources = true): Map<string, string | Buffer> {
  const originals = auditSources(archiveDir);
  if (includeSources && originals.missing.length) throw new Error('Complete recovery backup requires every original export. Recover missing originals, or explicitly create a reader backup.');
  if (originals.missing.length) {
    console.warn(`Warning: ${originals.missing.length} original export ZIP(s) missing locally: ${originals.missing.join(', ')}. Recover them from your separate source backup. The cumulative backup still preserves the saved messages and media.`);
  }
  const files = new Map<string, string | Buffer>();
  const hashes: Record<string, string> = {};
  validateOutput(sourceDir);
  if (includeSources && fs.readdirSync(sourceDir).some(group => fs.existsSync(path.join(sourceDir, group, 'reconciliation.json')))) verifyViews(sourceDir);
  captureSnapshot(sourceDir, archiveDir);
  for (const [relative, filename] of portableFiles(sourceDir, archiveDir)) {
    const bytes = fs.readFileSync(filename);
    hashes[relative] = sha256(bytes);
    files.set(relative, filename);
  }
  if (includeSources) for (const source of originals.sources) {
    const relative = `sources/${source.sha256}.zip`;
    const current = path.join(sourcesDirectory(archiveDir), `${source.sha256}.zip`);
    const filename = fs.existsSync(current) ? current : path.join(archiveDir, 'sources', `${source.sha256}.zip`);
    const bytes = fs.readFileSync(filename);
    hashes[relative] = sha256(bytes);
    files.set(relative, filename);
  }
  if (includeSources) {
    // Preserve the exact tooling that understands the evidence and decisions.
    // A recovered directory is runnable after npm ci; no repository history or
    // credentials are copied into the backup.
    const project = fileURLToPath(new URL('..', import.meta.url));
    const add = (relative: string): void => {
      const filename = path.join(project, relative);
      if (!fs.existsSync(filename)) return;
      const entry = fs.lstatSync(filename);
      if (entry.isDirectory()) { for (const child of fs.readdirSync(filename).sort()) add(`${relative}/${child}`); }
      else if (entry.isFile()) { const bytes = fs.readFileSync(filename); hashes[relative] = sha256(bytes); files.set(relative, filename); }
      else throw new Error(`Unexpected recovery tooling file: ${relative}`);
    };
    for (const relative of RECOVERY_TOOLING_PATHS) add(relative);
    const settings = path.join(path.dirname(path.resolve(sourceDir)), 'clemcast.config.json');
    if (fs.existsSync(settings)) { const bytes = fs.readFileSync(settings); hashes['clemcast.config.json'] = sha256(bytes); files.set('clemcast.config.json', settings); }
  }
  const readme = includeSources ? `CLEMCAST COMPLETE RECOVERY BACKUP\n\nThis backup includes output/, archive/, sources/ and the project tooling.\nPreserve the whole directory. Run npm ci, then npm run audit or npm run preview\nto verify and browse it. See README.md for importing and recovery instructions.\nOpen output/index.html directly to read offline without installing anything.\nOriginal ZIP bytes, source observations, reconciliation decisions and every\nretained snapshot/media are included. backup.json inventories SHA-256 checksums.\nRun npm run verify-backup -- FILE.zip and periodically recover into a new\ndirectory with npm run recover -- FILE.zip NEW_DIRECTORY.\n` : RECOVERY_README;
  hashes['README.txt'] = sha256(readme);
  files.set('README.txt', Buffer.from(readme));
  const expandedContainers = flattenBackupContainers(files, path.dirname(path.resolve(archiveDir)), filename => verifyPortableBackup(filename));
  // Flattening can add unique historical members and omit their redundant envelope.
  const finalHashes = Object.fromEntries([...files].sort(([a], [b]) => a.localeCompare(b)).map(([name, file]) => [name, sha256(recoveryFileBytes(file))]));
  const manifest: PortableManifest = {
    format: 'clemcast-portable', version: Object.keys(expandedContainers).length ? 4 : includeSources ? 3 : 2, files: finalHashes,
    sourcesIncluded: includeSources, separateSources: originals.sources, missingSources: originals.missing,
    ...(includeSources && { toolingIncluded: true }),
    ...(Object.keys(expandedContainers).length && { expandedContainers }),
  };
  files.set('backup.json', Buffer.from(JSON.stringify(manifest, null, 2)));
  return files;
}

export function recoveryFileBytes(file: string | Buffer): Buffer {
  return typeof file === 'string' ? fs.readFileSync(file) : file;
}

function createBackupZip(sourceDir: string, outputPath: string, archiveDir: string, includeSources: boolean): void {
  if (fs.existsSync(outputPath)) throw new Error(`Backup already exists: ${outputPath}`);
  for (const dir of [sourceDir, archiveDir]) {
    if (path.resolve(outputPath).startsWith(path.resolve(dir) + path.sep)) throw new Error('Save the backup outside output/ and archive/');
  }
  const zip = new AdmZip();
  for (const [relative, file] of collectRecoveryFiles(sourceDir, archiveDir, includeSources)) zip.addFile(relative, recoveryFileBytes(file));
  const bytes = zip.toBuffer();
  const manifest = verifyZip(new AdmZip(bytes));
  writeImmutable(outputPath, bytes);
  console.log(includeSources ? `Complete recovery v${manifest.version}: ${manifest.separateSources.length} original ZIPs included and verified, with all observations, decisions, snapshots and media.`
    : `Reader backup v2: original exports retained separately; ${manifest.missingSources?.length ?? 0} missing locally.`);
}

function verifyZip(zip: AdmZip): PortableManifest {
  const entry = zip.getEntry('backup.json');
  if (!entry) throw new Error('Not a versioned portable backup: backup.json is missing');
  const manifest = JSON.parse(entry.getData().toString('utf8')) as PortableManifest;
  if (manifest.format !== 'clemcast-portable' || ![2, 3, 4].includes(manifest.version) || !manifest.files
    || typeof manifest.files !== 'object' || Array.isArray(manifest.files) || typeof manifest.sourcesIncluded !== 'boolean'
    || (manifest.version !== 4 && manifest.sourcesIncluded !== (manifest.version === 3))
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
  verifyRecovery({ has: name => Boolean(zip.getEntry(name)), read: name => zip.getEntry(name)!.getData() }, manifest);
  return manifest;
}

/** Independently follow recovery references; the ZIP's own inventory can be incomplete. */
function verifyRecovery(reader: { has: (name: string) => boolean; read: (name: string) => Buffer }, manifest: PortableManifest): void {
  const expanded: Record<string, ExpandedBackup> = {};
  const descriptors = manifest.expandedContainers ?? {};
  if (typeof descriptors !== 'object' || Array.isArray(descriptors) || (manifest.version !== 4 && Object.keys(descriptors).length)) throw new Error('Invalid expanded backup catalog');
  for (const [hash, name] of Object.entries(descriptors)) {
    if (name !== descriptorPath(hash) || !Object.hasOwn(manifest.files, name) || !reader.has(name)) throw new Error('Expanded backup descriptor is missing');
    expanded[hash] = parseExpandedBackup(reader.read(name), hash);
    if (reader.has(expanded[hash]!.containerPath)) throw new Error('Redundant generated backup envelope remains in compacted backup');
  }
  const resolving = new Set<string>();
  const reference = (relative: string, hash?: string): void => {
    if (hash && expanded[hash]?.containerPath === relative) {
      if (resolving.has(hash)) throw new Error('Cyclic expanded backup reference');
      resolving.add(hash);
      for (const member of Object.values(expanded[hash]!.files)) reference(expanded[hash]!.locations[member]!, member);
      resolving.delete(hash); return;
    }
    if (!reader.has(relative) || !Object.hasOwn(manifest.files, relative)) throw new Error(`Backup recovery file is missing: ${relative}`);
    if (hash && manifest.files[relative] !== hash) throw new Error(`Backup recovery checksum mismatch: ${relative}`);
  };
  // Every expanded member is required even if no older snapshot happens to reference it.
  for (const [hash, value] of Object.entries(expanded)) reference(value.containerPath, hash);
  const read = (relative: string, hash?: string): Buffer => { reference(relative, hash); return reader.read(relative); };
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
      return read(!isMediaPath(relative) || reader.has(object) ? object : `output/${relative}`, expected);
    };
    if (!Object.keys(snapshot.files).length) throw new Error('Empty recovery snapshot in backup');
    for (const relative of Object.keys(snapshot.files)) {
      if (isMediaPath(relative)) {
        const expected = snapshot.files[relative]!;
        const object = `archive/objects/${expected}`;
        reference(reader.has(object) ? object : `output/${relative}`, expected);
      } else readSnapshotFile(relative);
      if (hash === latest && manifest.files[`output/${relative}`] !== snapshot.files[relative]) {
        throw new Error(`Latest output recovery file is missing or changed: ${relative}`);
      }
    }
    const groups = new Set(Object.keys(snapshot.files).map(relative => relative.split('/')[0]!));
    for (const group of groups) {
      const media = new Map(Object.entries(snapshot.files).filter(([relative]) => relative.startsWith(`${group}/attachments/`))
        .map(([relative, hash]) => [relative.slice(group.length + 1), hash]));
      readGroupFiles(`snapshot ${hash}/${group}`, relative => readSnapshotFile(`${group}/${relative}`),
        Object.keys(snapshot.files).filter(name => name.startsWith(`${group}/`)).map(name => name.slice(group.length + 1)), media);
    }
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
  if (manifest.sourcesIncluded) {
    if (manifest.missingSources?.length) throw new Error('Complete backup has missing originals');
    for (const source of inventory) if (sha256(read(`sources/${source.sha256}.zip`, source.sha256)) !== source.sha256) throw new Error('Damaged backup original');
  }
  if (manifest.toolingIncluded) {
    for (const relative of ['package.json', 'package-lock.json', 'tsconfig.json', 'src/index.ts', 'src/reconciliation.ts', 'src/evidence.ts', 'scripts/recover-backup.ts']) read(relative);
  }
  const sourceHashes = new Set(inventory.map(s => s.sha256));
  for (const filename of Object.keys(manifest.files).filter(name => /^output\/[^/]+\/evidence.json$/.test(name))) {
    const evidence = JSON.parse(read(filename).toString('utf8'));
    for (const batch of evidence.imports) if (!sourceHashes.has(batch.source)) throw new Error('Source evidence refers to an unrecorded original export');
  }
  if (manifest.missingSources !== undefined && (!Array.isArray(manifest.missingSources)
    || new Set(manifest.missingSources).size !== manifest.missingSources.length
    || manifest.missingSources.some(hash => !sources.has(hash)))) throw new Error('Invalid missing source inventory');
  for (const filename of Object.keys(manifest.files).filter(name => /^archive\/legacy-recovery\/snapshots\/.+\.json$/.test(name))) {
    const legacy = JSON.parse(read(filename).toString('utf8'));
    if (legacy.format !== 'clemcast-legacy-recovery' || legacy.version !== 1 || !legacy.files || !legacy.locations) throw new Error('Invalid migrated recovery history');
    for (const [name, hash] of Object.entries(legacy.files)) {
      if (!name.split('/').every(isSafeFilename) || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid migrated recovery file');
      const location = legacy.locations[hash];
      if (typeof location !== 'string' || !location.split('/').every(isSafeFilename)) throw new Error('Missing migrated recovery file location');
      reference(location, hash);
    }
  }
}

/** Verify an independently restored tree, including every historical recovery reference. */
export function verifyRecoveryTree(directory: string): void {
  const read = (relative: string) => fs.readFileSync(path.join(directory, relative));
  const manifest = JSON.parse(read('backup.json').toString('utf8')) as PortableManifest;
  if (manifest.format !== 'clemcast-portable' || ![2, 3, 4].includes(manifest.version) || !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)
    || typeof manifest.sourcesIncluded !== 'boolean' || (manifest.version !== 4 && manifest.sourcesIncluded !== (manifest.version === 3)) || !Array.isArray(manifest.separateSources)) throw new Error('Invalid recovered backup inventory');
  for (const [relative, hash] of Object.entries(manifest.files)) {
    if (!relative.split('/').every(isSafeFilename) || !/^[a-f0-9]{64}$/.test(hash) || sha256(read(relative)) !== hash) throw new Error(`Recovered backup checksum mismatch: ${relative}`);
  }
  verifyRecovery({ has: name => fs.existsSync(path.join(directory, name)), read }, manifest);
}

/** Verify bytes and recovery of every snapshot; optionally require all live history to be covered. */
export function verifyPortableBackup(filename: string, outputDir?: string, archiveDir?: string): {
  sha256: string; bytes: number; files: number;
  version: number;
  sourcesIncluded: boolean;
  originalExports: { listed: number; missingAtCreation: number | null };
} {
  const bytes = fs.readFileSync(filename);
  const manifest = verifyZip(new AdmZip(bytes));
  if (outputDir && archiveDir) {
    for (const [relative, file] of portableFiles(outputDir, archiveDir)) {
      const bytes = fs.readFileSync(file), hash = sha256(bytes);
      if (manifest.files[relative] !== hash) {
        const descriptor = manifest.expandedContainers?.[hash];
        if (!descriptor || relative !== `archive/legacy-recovery/objects/${hash}`) throw new Error(`Backup does not cover current history: ${relative}`);
        const zip = new AdmZip(filename);
        assertExpansionMatches(bytes, parseExpandedBackup(zip.getEntry(descriptor)!.getData(), hash));
      }
    }
    if (JSON.stringify(manifest.separateSources) !== JSON.stringify(sourceInventory(archiveDir))) throw new Error('Backup source inventory is out of date');
  }
  return {
    sha256: sha256(bytes), bytes: bytes.length, files: Object.keys(manifest.files).length,
    version: manifest.version, sourcesIncluded: manifest.sourcesIncluded,
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

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import AdmZip from 'adm-zip';
import { collectRecoveryFiles, createRecoveryZip, recoveryFileBytes, verifyPortableBackup, verifyRecoveryTree } from './zip-output.js';
import { sha256, writeAtomic, writeImmutable, assertMessagesRetained, publishNewDirectory } from './storage.js';
import { assertEvidenceRetained } from './evidence.js';
import { safeRelative, type BackupStore, type StoredFile } from './backup-store.js';
import { BACKUP_DATA } from './incremental.js';
import { assertExpansionMatches, expansionCatalog, type ExpandedBackup } from './backup-containers.js';

interface FileSet { hashes: Record<string, string>; read: (name: string) => Buffer; expanded?: Record<string, ExpandedBackup> }
export interface ZipCheckpoint { filename: string; fingerprint: string; sha256: string; bytes: number }
const sorted = <T>(value: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
const protectedFile = (name: string): boolean => /^sources\//.test(name) || (name.startsWith('archive/') && name !== 'archive/latest.json') || /^output\/[^/]+\/attachments\//.test(name);
const ZIP_NAME = /^\d{4}-\d{2}-\d{2} - Clemcast(?: - previous-[a-f0-9]{64})?\.zip$/;
const PENDING = /^\.Clemcast-upload-[a-f0-9]{64}\.zip$/;
const GUIDE = /^(START HERE - Clemcast backups\.txt|Latest backup - .+ - verified\.txt|\d{4}-\d{2}-\d{2} - Latest backup\.txt)$/;
const cacheDirectory = (workspace: string): string => path.join(workspace, 'backups', 'automatic');

function currentFiles(workspace: string): FileSet {
  const files = collectRecoveryFiles(path.join(workspace, 'output'), path.join(workspace, 'archive'));
  return { expanded: expansionCatalog(files), hashes: sorted(Object.fromEntries([...files].map(([name, file]) => [name, sha256(recoveryFileBytes(file))]))),
    read: name => { const file = files.get(name); if (!file) throw new Error(`Missing recovery file: ${name}`); return recoveryFileBytes(file); } };
}
function zipFiles(filename: string): FileSet {
  const zip = new AdmZip(filename), hashes: Record<string, string> = {};
  for (const entry of zip.getEntries()) if (!entry.isDirectory) {
    safeRelative(entry.entryName);
    if (hashes[entry.entryName]) throw new Error('Duplicate ZIP entry');
    hashes[entry.entryName] = sha256(entry.getData());
  }
  return { hashes: sorted(hashes), read: name => { const entry = zip.getEntry(safeRelative(name)); if (!entry) throw new Error(`Missing ZIP file: ${name}`); return entry.getData(); } };
}

/** A historical copy alone is insufficient: earlier records must remain in the current reader too. */
export function assertArchiveRetained(previous: FileSet, current: FileSet): void {
  for (const [name, hash] of Object.entries(previous.hashes)) {
    const expansion = current.expanded?.[hash];
    if (expansion) assertExpansionMatches(previous.read(name), expansion);
    if (protectedFile(name) && current.hashes[name] !== hash && !(expansion && name === expansion.containerPath)) throw new Error(`Previously backed-up file removed or changed: ${name}`);
    if (!/^output\/[^/]+\/(data|evidence|decisions|manifest)\.json$/.test(name)) continue;
    if (!current.hashes[name]) throw new Error(`Previously backed-up group metadata missing: ${name}`);
    const before = JSON.parse(previous.read(name).toString('utf8')), after = JSON.parse(current.read(name).toString('utf8'));
    if (name.endsWith('/data.json')) assertMessagesRetained(before, after);
    else if (name.endsWith('/evidence.json')) assertEvidenceRetained(before, after);
    else if (name.endsWith('/decisions.json') && JSON.stringify(after.slice(0, before.length)) !== JSON.stringify(before)) throw new Error('Earlier reviewed decisions would be lost');
    else if (name.endsWith('/manifest.json')) for (const [key, value] of Object.entries(before.contentHashes)) {
      if (after.contentHashes[key] !== value) throw new Error('Earlier saved media mappings would be lost');
    }
  }
}

/** Preserve file versions, never nest a generated full backup inside its replacement. */
function retainFiles(workspace: string, previous: FileSet, originalName: string, identity: string): void {
  const filename = path.join(workspace, 'archive/legacy-recovery/snapshots', identity + '.json');
  if (fs.existsSync(filename)) return; // Immutable mappings must not drift as equivalent paths appear.
  const current = currentFiles(workspace), locations: Record<string, string> = {};
  const immutable = new Map(Object.entries(current.hashes).filter(([name]) => protectedFile(name)).map(([name, hash]) => [hash, name]));
  for (const [oldName, hash] of Object.entries(previous.hashes)) {
    let name = immutable.get(hash);
    if (!name && current.expanded?.[hash]) {
      assertExpansionMatches(previous.read(oldName), current.expanded[hash]!);
      name = current.expanded[hash]!.containerPath;
    }
    if (!name) {
      name = `archive/legacy-recovery/objects/${hash}`;
      const bytes = previous.read(oldName);
      if (sha256(bytes) !== hash) throw new Error(`Previous backup checksum mismatch: ${oldName}`);
      writeImmutable(path.join(workspace, name), bytes); immutable.set(hash, name);
    }
    locations[hash] = name;
  }
  writeImmutable(filename, JSON.stringify({ format: 'clemcast-legacy-recovery', version: 1, originalName,
    files: previous.hashes, locations: sorted(locations) }, null, 2));
}

/** Complete verified local ZIP, written before any network access. Reused on unchanged runs. */
export function prepareZipBackup(workspace: string): ZipCheckpoint {
  const files = currentFiles(workspace), fingerprint = sha256(JSON.stringify(files.hashes));
  const directory = cacheDirectory(workspace), filename = path.join(directory, fingerprint + '.zip');
  fs.mkdirSync(directory, { recursive: true });
  if (!fs.existsSync(filename)) createRecoveryZip(path.join(workspace, 'output'), filename, path.join(workspace, 'archive'));
  const verified = verifyPortableBackup(filename, path.join(workspace, 'output'), path.join(workspace, 'archive'));
  // Include tooling and the portable manifest in the unchanged check, not just the site data.
  if (sha256(JSON.stringify(zipFiles(filename).hashes)) !== fingerprint) throw new Error('Local ZIP does not match current recovery files');
  const result = { filename, fingerprint, sha256: verified.sha256, bytes: verified.bytes };
  writeAtomic(path.join(directory, 'current.json'), JSON.stringify(result, null, 2));
  console.log(`Verified local recovery ZIP: ${filename}`);
  return result;
}

interface InventoryFile extends StoredFile { name: string }
function inventory(store: BackupStore, directory = ''): InventoryFile[] {
  const files: InventoryFile[] = [];
  for (const file of store.list(directory)) {
    if (!directory && file.name === '.trash') continue; // Offline adapter's recoverable Trash.
    const name = directory ? `${directory}/${file.name}` : file.name; safeRelative(name);
    files.push({ ...file, name });
    if (file.directory) files.push(...inventory(store, name));
  }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}
function signature(files: InventoryFile[]): string {
  return JSON.stringify(files.map(file => ({ name: file.name, directory: file.directory, size: file.size,
    id: file.id, sha256: file.sha256, modifiedAt: file.modifiedAt })));
}
function downloadFiles(store: BackupStore, files: InventoryFile[], destination: string, workspace: string): FileSet {
  const hashes: Record<string, string> = {}, missing: string[] = [];
  for (const file of files.filter(file => !file.directory)) {
    const target = path.join(destination, file.name);
    // Reuse only bytes whose hashes agree with Drive, including metadata. Never trust cache names alone.
    const cached = [path.join(workspace, '.incremental-backup/repository', file.name)];
    const source = file.sha256 && cached.find(name => fs.existsSync(name) && fs.statSync(name).size === file.size && sha256(fs.readFileSync(name)) === file.sha256);
    if (source) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.linkSync(source, target); }
    else missing.push(file.name);
  }
  store.download(missing, destination);
  for (const file of files.filter(file => !file.directory)) {
    const bytes = fs.readFileSync(path.join(destination, file.name)), hash = sha256(bytes);
    if (bytes.length !== file.size || (file.sha256 && hash !== file.sha256)) throw new Error(`Drive readback checksum mismatch: ${file.name}`);
    hashes[file.name] = hash;
  }
  return { hashes: sorted(hashes), read: name => fs.readFileSync(path.join(destination, safeRelative(name))) };
}
function assertRemoteUnchanged(store: BackupStore, initial: InventoryFile[], ownNames: string[] = []): void {
  const now = inventory(store).filter(file => !ownNames.includes(file.name));
  if (signature(now) !== signature(initial)) throw new Error('Drive backup changed during this run. Previous copies retained; retry with only one publisher.');
}
function dateName(timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const value = (name: string) => parts.find(part => part.type === name)!.value;
  return `${value('year')}-${value('month')}-${value('day')} - Clemcast.zip`;
}

export function publishZipBackup(workspace: string, initialCheckpoint: ZipCheckpoint, store: BackupStore, timeZone = 'Europe/Rome'):
  { name: string; sha256: string; bytes: number; uploaded: boolean; localZip: string } {
  const directory = cacheDirectory(workspace), temporary = fs.mkdtempSync(path.join(directory, 'transfer-'));
  let checkpoint = initialCheckpoint;
  try {
    const initial = inventory(store), root = initial.filter(file => !file.name.includes('/'));
    for (const file of root) if (!(file.directory && file.name === BACKUP_DATA) && !(ZIP_NAME.test(file.name) || PENDING.test(file.name) || GUIDE.test(file.name))) {
      throw new Error(`Unrecognized file in Clemcast backup folder; left untouched: ${file.name}`);
    }
    const previous = root.filter(file => !file.directory && ZIP_NAME.test(file.name));
    const pending = root.filter(file => !file.directory && PENDING.test(file.name));
    const legacy = initial.filter(file => file.name === BACKUP_DATA || file.name.startsWith(BACKUP_DATA + '/') || GUIDE.test(file.name));
    const required = new Set<string>();
    // Avoid capturing our own ZIP again on an unchanged rerun.
    const unchanged = previous.length === 1 && !legacy.length && !pending.length && previous[0]!.sha256 === checkpoint.sha256;
    if (unchanged) {
      const old = previous[0]!;
      assertRemoteUnchanged(store, initial);
      console.log(`Drive recovery ZIP unchanged and verified: ${old.name}`);
      return { name: old.name, sha256: checkpoint.sha256, bytes: checkpoint.bytes, uploaded: false, localZip: checkpoint.filename };
    }
    for (const file of [...previous, ...pending]) {
      const downloaded = path.join(temporary, 'old-' + sha256(file.name)); fs.mkdirSync(downloaded);
      const raw = downloadFiles(store, [file], downloaded, workspace), filename = path.join(downloaded, file.name);
      verifyPortableBackup(filename);
      const old = zipFiles(filename); assertArchiveRetained(old, currentFiles(workspace));
      for (const hash of Object.values(old.hashes)) required.add(hash);
      // Exact entry equality avoids history churn even on providers without SHA-256 metadata.
      if (legacy.length || JSON.stringify(old.hashes) !== JSON.stringify(currentFiles(workspace).hashes)) {
        retainFiles(workspace, old, file.name, `zip-${raw.hashes[file.name]}`);
      }
    }
    if (legacy.length) {
      console.log('Preserving the previous Drive backup files inside the complete recovery ZIP.');
      const downloaded = path.join(temporary, 'legacy'); fs.mkdirSync(downloaded);
      const old = downloadFiles(store, legacy, downloaded, workspace);
      // A stopped Trash operation can leave only part of the old folder. Its full
      // inventory is already protected inside the promoted ZIP and local archive.
      const history = path.join(workspace, 'archive/legacy-recovery/snapshots');
      const alreadyPreserved = previous.length > 0 && fs.existsSync(history) && fs.readdirSync(history).some(name => {
        if (!name.startsWith('drive-') || !name.endsWith('.json')) return false;
        const saved = JSON.parse(fs.readFileSync(path.join(history, name), 'utf8'));
        return saved.format === 'clemcast-legacy-recovery' && Object.entries(old.hashes).every(([file, hash]) => saved.files[file] === hash);
      });
      if (!alreadyPreserved && old.hashes[`${BACKUP_DATA}/CURRENT.json`]) {
        const head = JSON.parse(old.read(`${BACKUP_DATA}/CURRENT.json`).toString('utf8'));
        const snapshotName = `${BACKUP_DATA}/snapshots/${safeRelative(head.snapshot.name)}`;
        if (old.hashes[snapshotName] !== head.snapshot.sha256) throw new Error('Previous Drive snapshot checksum mismatch');
        const snapshot = JSON.parse(old.read(snapshotName).toString('utf8'));
        if (snapshot.format !== 'clemcast-incremental-snapshot' || snapshot.kind !== 'archive') throw new Error('Invalid previous Drive archive');
        const read = (name: string) => old.read(`${BACKUP_DATA}/objects/${snapshot.files[name]}`);
        for (const [name, hash] of Object.entries(snapshot.files) as [string, string][]) {
          safeRelative(name);
          if (old.hashes[`${BACKUP_DATA}/objects/${hash}`] !== hash) throw new Error(`Previous Drive data missing: ${name}`);
        }
        assertArchiveRetained({ hashes: snapshot.files, read }, currentFiles(workspace));
      } else if (!alreadyPreserved && legacy.some(file => file.name.startsWith(BACKUP_DATA + '/'))) throw new Error('Previous Drive current snapshot is missing');
      for (const hash of Object.values(old.hashes)) required.add(hash);
      retainFiles(workspace, old, 'Previous Clemcast Drive folder', `drive-${sha256(JSON.stringify(old.hashes))}`);
    }
    checkpoint = prepareZipBackup(workspace);
    const payloadHashes = new Set(Object.values(zipFiles(checkpoint.filename).hashes));
    const expanded = currentFiles(workspace).expanded ?? {};
    for (const hash of required) if (!payloadHashes.has(hash) && !expanded[hash]) throw new Error(`Previous backup bytes missing from replacement: ${hash}`);
    const name = dateName(timeZone), candidate = `.Clemcast-upload-${checkpoint.sha256}.zip`;
    const uploadDir = path.join(temporary, 'upload'); fs.mkdirSync(uploadDir);
    fs.linkSync(checkpoint.filename, path.join(uploadDir, candidate));
    console.log(`Uploading complete recovery ZIP: ${name} (${checkpoint.bytes} bytes).`);
    store.upload(uploadDir, [candidate], true);
    const readback = path.join(temporary, 'readback'); fs.mkdirSync(readback);
    store.download([candidate], readback);
    const verified = verifyPortableBackup(path.join(readback, candidate), path.join(workspace, 'output'), path.join(workspace, 'archive'));
    if (verified.sha256 !== checkpoint.sha256) throw new Error('Uploaded ZIP failed full download verification');
    // Full SHA equality proves all preservation checks on the local ZIP also hold for the Drive copy.
    assertRemoteUnchanged(store, initial.filter(file => file.name !== candidate), [candidate]);
    const sameDay = previous.find(file => file.name === name);
    let displaced: string | undefined;
    if (sameDay) {
      displaced = name.replace('.zip', ` - previous-${required.size ? sha256(JSON.stringify(sameDay)) : checkpoint.sha256}.zip`);
      store.move(name, displaced); // Keep the only old copy until promotion succeeds.
    }
    store.move(candidate, name);
    const promoted = store.list('').find(file => file.name === name && !file.directory);
    if (!promoted || promoted.size !== checkpoint.bytes || (promoted.sha256 && promoted.sha256 !== checkpoint.sha256)) throw new Error('ZIP promotion verification failed; previous copies retained');
    // Check every old object again before retiring it. No unique bytes are removed.
    const expected = initial.filter(file => file.name !== name && file.name !== candidate);
    const actual = inventory(store).filter(file => file.name !== name && file.name !== displaced && file.name !== candidate);
    if (signature(actual) !== signature(expected)) throw new Error('Previous Drive files changed before cleanup; all copies retained');
    store.trash([...previous.map(file => file.name).filter(old => old !== name), ...pending.map(file => file.name).filter(old => old !== candidate),
      ...legacy.filter(file => !file.directory).map(file => file.name), ...(displaced ? [displaced] : [])]);
    // Bottom-up empty-folder removal uses recoverable Drive Trash, never a permanent purge.
    for (const file of legacy.filter(file => file.directory).sort((a, b) => b.name.split('/').length - a.name.split('/').length)) store.trash([file.name]);
    writeAtomic(path.join(directory, 'last-run.json'), JSON.stringify({ name, ...checkpoint, verifiedAt: new Date().toISOString() }, null, 2));
    // Bound only our generated cache; untouched user backups and originals are never pruned.
    for (const file of fs.readdirSync(directory)) if (/^[a-f0-9]{64}\.zip$/.test(file) && path.join(directory, file) !== checkpoint.filename) fs.unlinkSync(path.join(directory, file));
    console.log(`Verified Drive recovery ZIP: ${name}. Previous data and history preserved; superseded copies moved to Trash.`);
    return { name, sha256: checkpoint.sha256, bytes: checkpoint.bytes, uploaded: true, localZip: checkpoint.filename };
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

/** Download, verify, then publish a new recovery directory. Ordinary unzip also works. */
export function recoverDriveZip(store: BackupStore, destination: string): void {
  if (fs.existsSync(destination)) throw new Error('Recovery destination already exists; choose a new directory');
  const files = store.list('').filter(file => !file.directory && ZIP_NAME.test(file.name) && !file.name.includes(' - previous-'));
  if (files.length !== 1) throw new Error('Expected one dated Clemcast ZIP. Download the desired ZIP manually if a previous run was interrupted.');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'clemcast-zip-recovery-'));
  try {
    const filename = files[0]!.name; store.download([filename], temporary);
    const zipPath = path.join(temporary, filename), verified = verifyPortableBackup(zipPath);
    if (files[0]!.sha256 && verified.sha256 !== files[0]!.sha256) throw new Error('Drive recovery checksum mismatch');
    const recovered = path.join(temporary, 'recovered'); fs.mkdirSync(recovered);
    for (const entry of new AdmZip(zipPath).getEntries()) if (!entry.isDirectory) writeImmutable(path.join(recovered, safeRelative(entry.entryName)), entry.getData());
    verifyRecoveryTree(recovered);
    // Destination can be on another volume, so stage beside it before atomic publication.
    const staging = fs.mkdtempSync(path.join(path.dirname(destination), '.clemcast-zip-'));
    try { fs.cpSync(recovered, staging, { recursive: true }); publishNewDirectory(staging, destination); }
    finally { fs.rmSync(staging, { recursive: true, force: true }); }
    console.log(`Verified and recovered ${filename} into ${destination}`);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

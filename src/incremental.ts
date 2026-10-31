import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import AdmZip from 'adm-zip';
import { collectRecoveryFiles, recoveryFileBytes, verifyPortableBackup, verifyRecoveryTree } from './zip-output.js';
import { sha256, writeAtomic, writeImmutable, assertMessagesRetained, publishNewDirectory } from './storage.js';
import { assertEvidenceRetained } from './evidence.js';
import { safeRelative, type BackupStore, type StoredFile } from './backup-store.js';

export const BACKUP_DATA = 'Backup data - keep this folder';
const HEAD = `${BACKUP_DATA}/CURRENT.json`;
const MARKER = `${BACKUP_DATA}/repository.json`;
const HASH = /^[a-f0-9]{64}$/;
export interface SnapshotRef { name: string; sha256: string }
export interface BackupArtifact { name: string; size: number; sha256: string; id?: string }
export interface Migration { name: string; artifacts: BackupArtifact[]; snapshots: SnapshotRef[]; containers: string[] }
export interface BackupSnapshot {
  format: 'clemcast-incremental-snapshot'; version: 1; repository: string; kind: 'archive' | 'legacy';
  createdAt: string; files: Record<string, string>; objects: Record<string, number>;
  previous?: SnapshotRef; legacy: SnapshotRef[]; migrations: Migration[]; summary: Record<string, number>;
  originalName?: string; originalZipSha256?: string;
}
interface Head { format: 'clemcast-incremental-head'; version: 1; repository: string; snapshot: SnapshotRef; verifiedAt: string }
export interface LocalCheckpoint { workspace: string; directory: string; files: Record<string, string>; objects: Record<string, number>; createdAt: string; fingerprint: string }

function objectName(hash: string): string {
  if (!HASH.test(hash)) throw new Error('Invalid backup object hash');
  return `${BACKUP_DATA}/objects/${hash}`;
}
function refName(ref: SnapshotRef): string {
  if (!HASH.test(ref.sha256) || !/^(legacy-)?\d{4}-\d{2}-\d{2}T[\d-]+Z--[a-f0-9]{64}\.json$/.test(ref.name)
    || !ref.name.endsWith(`--${ref.sha256}.json`)) throw new Error('Invalid dated backup snapshot reference');
  return `${BACKUP_DATA}/snapshots/${ref.name}`;
}
function sorted<T>(record: Record<string, T>): Record<string, T> { return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b))); }
function readObject(directory: string, hash: string): Buffer {
  const filename = path.join(directory, objectName(hash));
  if (!fs.lstatSync(filename).isFile()) throw new Error('Expected a regular backup object');
  const bytes = fs.readFileSync(filename);
  if (sha256(bytes) !== hash) throw new Error(`Damaged incremental backup object: ${hash}`);
  return bytes;
}
function addObject(directory: string, bytes: Buffer): string {
  const hash = sha256(bytes); writeImmutable(path.join(directory, objectName(hash)), bytes); return hash;
}
function localObjects(directory: string): Record<string, number> {
  const objects = path.join(directory, BACKUP_DATA, 'objects');
  if (!fs.existsSync(objects)) return {};
  return sorted(Object.fromEntries(fs.readdirSync(objects).map(hash => [hash, readObject(directory, hash).length])));
}

/** A complete local checkpoint is written before Drive is contacted. No routine full ZIP is needed. */
export function prepareIncrementalBackup(workspace: string): LocalCheckpoint {
  const directory = path.join(workspace, '.incremental-backup', 'repository');
  const files: Record<string, string> = {};
  for (const [name, value] of collectRecoveryFiles(path.join(workspace, 'output'), path.join(workspace, 'archive'))) {
    files[name] = addObject(directory, recoveryFileBytes(value));
  }
  const fingerprint = sha256(JSON.stringify(sorted(files)));
  const preparedPath = path.join(directory, 'prepared.json');
  const old = fs.existsSync(preparedPath) ? JSON.parse(fs.readFileSync(preparedPath, 'utf8')) : undefined;
  const checkpoint = { workspace, directory, files: sorted(files), objects: localObjects(directory), fingerprint,
    createdAt: old?.fingerprint === fingerprint ? old.createdAt : new Date().toISOString() };
  writeAtomic(preparedPath, JSON.stringify(checkpoint, null, 2));
  const snapshot: BackupSnapshot = { format: 'clemcast-incremental-snapshot', version: 1, repository: 'local', kind: 'archive',
    createdAt: checkpoint.createdAt, files: checkpoint.files, objects: checkpoint.objects, legacy: [], migrations: [], summary: summary(checkpoint) };
  const ref = saveSnapshot(directory, snapshot);
  writeAtomic(path.join(directory, 'LOCAL.json'), JSON.stringify(ref));
  checkRestorable(directory, snapshot);
  console.log(`Verified local incremental checkpoint: ${directory}`);
  return checkpoint;
}

function summary(checkpoint: Pick<LocalCheckpoint, 'directory' | 'files'>): Record<string, number> {
  let posts = 0, observations = 0;
  for (const [name, hash] of Object.entries(checkpoint.files)) if (/^output\/[^/]+\/reconciliation.json$/.test(name)) {
    const state = JSON.parse(readObject(checkpoint.directory, hash).toString('utf8'));
    posts += state.posts.filter((post: { category: string }) => post.category === 'post').length;
    observations += state.observationCount;
  }
  return { posts, observations, media: Object.keys(checkpoint.files).filter(name => /^output\/[^/]+\/attachments\//.test(name)).length,
    originalExports: Object.keys(checkpoint.files).filter(name => /^sources\/[a-f0-9]{64}\.zip$/.test(name)).length,
    files: Object.keys(checkpoint.files).length };
}

function parseSnapshot(bytes: Buffer, ref: SnapshotRef): BackupSnapshot {
  refName(ref);
  if (sha256(bytes) !== ref.sha256) throw new Error('Backup snapshot checksum mismatch');
  const value = JSON.parse(bytes.toString('utf8')) as BackupSnapshot;
  if (value.format !== 'clemcast-incremental-snapshot' || value.version !== 1 || !['archive', 'legacy'].includes(value.kind)
    || typeof value.repository !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) || !value.files || !value.objects
    || Array.isArray(value.files) || Array.isArray(value.objects) || !Array.isArray(value.legacy) || !Array.isArray(value.migrations)) throw new Error('Invalid backup snapshot');
  for (const [name, hash] of Object.entries(value.files)) { safeRelative(name); if (!HASH.test(hash) || !Object.hasOwn(value.objects, hash)) throw new Error('Incomplete backup object inventory'); }
  for (const [hash, bytes] of Object.entries(value.objects)) if (!HASH.test(hash) || !Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid backup object inventory');
  if (value.previous) refName(value.previous);
  value.legacy.forEach(refName);
  return value;
}
function saveSnapshot(directory: string, value: BackupSnapshot): SnapshotRef {
  value.files = sorted(value.files); value.objects = sorted(value.objects);
  const bytes = Buffer.from(JSON.stringify(value, null, 2)), hash = sha256(bytes);
  const ref = { name: `${value.kind === 'legacy' ? 'legacy-' : ''}${value.createdAt.replace(/[:.]/g, '-')}--${hash}.json`, sha256: hash };
  parseSnapshot(bytes, ref); writeImmutable(path.join(directory, refName(ref)), bytes); return ref;
}
function readSnapshot(directory: string, ref: SnapshotRef): BackupSnapshot { return parseSnapshot(fs.readFileSync(path.join(directory, refName(ref))), ref); }
function parseHead(bytes: Buffer, repository: string): Head {
  const head = JSON.parse(bytes.toString('utf8')) as Head;
  if (head.format !== 'clemcast-incremental-head' || head.version !== 1 || head.repository !== repository) throw new Error('Invalid current backup pointer');
  refName(head.snapshot); return head;
}
function headBytes(store: BackupStore): Buffer | undefined {
  return store.list(BACKUP_DATA).some(file => file.name === 'CURRENT.json') ? store.read(HEAD) : undefined;
}

/** Both file versions and source observations must survive a promotion. */
export function assertBackupRetained(directory: string, previous: BackupSnapshot, current: BackupSnapshot): void {
  for (const [hash, bytes] of Object.entries(previous.objects)) if (current.objects[hash] !== bytes) throw new Error(`Earlier backup data would be lost: ${hash}`);
  const read = (hash: string) => JSON.parse(readObject(directory, hash).toString('utf8'));
  for (const [name, hash] of Object.entries(previous.files)) {
    if (/^sources\//.test(name) || (/^archive\//.test(name) && name !== 'archive/latest.json') || /^output\/[^/]+\/attachments\//.test(name)) {
      if (current.files[name] !== hash) throw new Error(`Previously backed-up file removed or changed: ${name}`);
    } else if (/^output\/[^/]+\/(data|evidence|decisions|manifest)\.json$/.test(name)) {
      const next = current.files[name]; if (!next) throw new Error(`Previously backed-up group metadata missing: ${name}`);
      const old = read(hash), value = read(next);
      if (name.endsWith('/data.json')) assertMessagesRetained(old, value);
      else if (name.endsWith('/evidence.json')) assertEvidenceRetained(old, value);
      else if (name.endsWith('/decisions.json') && JSON.stringify(value.slice(0, old.length)) !== JSON.stringify(old)) throw new Error('Earlier reviewed decisions would be lost');
      else if (name.endsWith('/manifest.json')) for (const [key, content] of Object.entries(old.contentHashes)) {
        if (value.contentHashes[key] !== content) throw new Error('Earlier saved media mappings would be lost');
      }
    }
  }
}

function checkRestorable(directory: string, snapshot: BackupSnapshot): void {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'clemcast-recovery-proof-'));
  try {
    for (const [hash, size] of Object.entries(snapshot.objects)) if (readObject(directory, hash).length !== size) throw new Error('Backup object size mismatch');
    if (snapshot.previous) assertBackupRetained(directory, readSnapshot(directory, snapshot.previous), snapshot);
    for (const [name, hash] of Object.entries(snapshot.files)) {
      const target = path.join(temporary, safeRelative(name)); fs.mkdirSync(path.dirname(target), { recursive: true });
      try { fs.linkSync(path.join(directory, objectName(hash)), target); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error; fs.copyFileSync(path.join(directory, objectName(hash)), target); }
    }
    if (snapshot.kind === 'archive') verifyRecoveryTree(temporary);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

function loadHistory(store: BackupStore, directory: string, ref: SnapshotRef, repository: string, visited = new Set<string>()): BackupSnapshot {
  if (visited.has(ref.sha256)) return readSnapshot(directory, ref);
  visited.add(ref.sha256);
  const filename = refName(ref), bytes = store.read(filename), value = parseSnapshot(bytes, ref);
  if (value.repository !== repository) throw new Error('Backup snapshot belongs to a different repository');
  writeImmutable(path.join(directory, filename), bytes);
  for (const parent of [...(value.previous ? [value.previous] : []), ...value.legacy]) {
    const ancestor = loadHistory(store, directory, parent, repository, visited);
    for (const [hash, size] of Object.entries(ancestor.objects)) if (value.objects[hash] !== size) throw new Error('A recovery point omits earlier backup data');
  }
  return value;
}
function hydrateObjects(store: BackupStore, directory: string, objects: Record<string, number>): void {
  const missing = Object.keys(objects).filter(hash => !fs.existsSync(path.join(directory, objectName(hash))));
  store.download(missing.map(objectName), directory);
  for (const [hash, size] of Object.entries(objects)) if (readObject(directory, hash).length !== size) throw new Error('Downloaded backup object has the wrong size');
}

/** Import the contents of a generated backup ZIP, preserving exact original WhatsApp ZIP entries. */
export function importLegacyZip(directory: string, filename: string, repository: string, originalName: string, modifiedAt?: string): SnapshotRef {
  const zip = new AdmZip(filename), entries = zip.getEntries().filter(entry => !entry.isDirectory);
  if (!entries.length) throw new Error('Empty legacy backup cannot be migrated');
  const portable = zip.getEntry('backup.json');
  if (portable && JSON.parse(portable.getData().toString('utf8')).format === 'clemcast-portable') verifyPortableBackup(filename);
  const files: Record<string, string> = Object.create(null), objects: Record<string, number> = {};
  for (const entry of entries) {
    const name = safeRelative(entry.entryName); if (Object.hasOwn(files, name)) throw new Error('Duplicate legacy ZIP entry');
    const bytes = entry.getData(), hash = addObject(directory, bytes); files[name] = hash; objects[hash] = bytes.length;
  }
  const date = originalName.match(/\d{4}-\d{2}-\d{2}/)?.[0];
  const value: BackupSnapshot = { format: 'clemcast-incremental-snapshot', version: 1, repository, kind: 'legacy',
    createdAt: date ? `${date}T00:00:00.000Z` : modifiedAt && Number.isFinite(Date.parse(modifiedAt)) ? new Date(modifiedAt).toISOString() : new Date().toISOString(), files, objects, legacy: [], migrations: [], summary: { files: entries.length },
    originalName, originalZipSha256: sha256(fs.readFileSync(filename)) };
  checkRestorable(directory, value); return saveSnapshot(directory, value);
}

function artifact(file: StoredFile, name: string, bytes: Buffer): BackupArtifact {
  const hash = sha256(bytes);
  if (bytes.length !== file.size || (file.sha256 && file.sha256 !== hash)) throw new Error('Legacy Drive download does not match its inventory');
  return { name, size: bytes.length, sha256: hash, ...(file.id && { id: file.id }) };
}

/** Migration is automatic but deletion is postponed until the combined backup has been restored. */
function migrateLegacy(store: BackupStore, checkpoint: LocalCheckpoint, repository: string, existing: Migration[]): Migration[] {
  const migrations = [...existing], covered = new Set(existing.flatMap(m => [m.name, ...m.artifacts.map(a => a.name)]));
  const root = store.list('');
  const temporary = path.join(checkpoint.directory, '..', 'legacy-downloads'); fs.mkdirSync(temporary, { recursive: true });
  for (const file of root) {
    if (covered.has(file.name)) continue;
    if (!file.directory && /^(clemcast-(?:full-backup|recovery)-|whatsapp-backup-).+\.zip$/.test(file.name)) {
      console.log(`Migrating older full backup: ${file.name}`);
      const download = fs.mkdtempSync(path.join(temporary, 'zip-'));
      try {
        store.download([file.name], download); const filename = path.join(download, file.name), bytes = fs.readFileSync(filename);
        const ref = importLegacyZip(checkpoint.directory, filename, repository, file.name, file.modifiedAt);
        migrations.push({ name: file.name, artifacts: [artifact(file, file.name, bytes)], snapshots: [ref], containers: [] });
      } finally { fs.rmSync(download, { recursive: true, force: true }); }
    } else if (file.directory && /^Complete recovery \d{4}-\d{2}-\d{2}$/.test(file.name)) {
      const children = store.list(file.name), entry = children.find(child => child.name === 'manifest.json');
      if (!entry) throw new Error('Older recovery folder is missing its multipart inventory');
      const manifestBytes = store.read(`${file.name}/manifest.json`), manifest = JSON.parse(manifestBytes.toString('utf8'));
      if (manifest.format !== 'clemcast-recovery-parts' || manifest.version !== 1 || !Array.isArray(manifest.parts) || !manifest.archive) throw new Error('Invalid multipart recovery inventory');
      const download = fs.mkdtempSync(path.join(temporary, 'parts-'));
      try {
        const expected = ['manifest.json', ...manifest.parts.map((p: { name: string }) => safeRelative(p.name)), ...(manifest.helpers ?? []).map((p: { name: string }) => safeRelative(p.name))];
        if (children.length !== expected.length || children.some(child => child.directory || !expected.includes(child.name))) throw new Error('Multipart folder contains unknown files; migration stopped safely');
        store.download(expected.map(name => `${file.name}/${name}`), download);
        const artifacts: BackupArtifact[] = [], helperFiles: Record<string, string> = Object.create(null), helperObjects: Record<string, number> = {};
        const zipPath = path.join(download, 'assembled.zip'), fd = fs.openSync(zipPath, 'wx');
        try {
          for (const part of manifest.parts) {
            const bytes = fs.readFileSync(path.join(download, file.name, part.name));
            if (sha256(bytes) !== part.sha256 || bytes.length !== part.bytes) throw new Error('Damaged multipart recovery backup');
            fs.writeFileSync(fd, bytes);
          }
        } finally { fs.closeSync(fd); }
        const zipBytes = fs.readFileSync(zipPath);
        if (sha256(zipBytes) !== manifest.archive.sha256 || zipBytes.length !== manifest.archive.bytes) throw new Error('Reassembled recovery ZIP checksum mismatch');
        const ref = importLegacyZip(checkpoint.directory, zipPath, repository, manifest.archive.name);
        for (const child of children) {
          const relative = `${file.name}/${child.name}`, bytes = fs.readFileSync(path.join(download, relative));
          artifacts.push(artifact(child, relative, bytes));
          if (!manifest.parts.some((p: { name: string }) => p.name === child.name)) {
            const expectedHelper = manifest.helpers?.find((helper: { name: string }) => helper.name === child.name);
            if (expectedHelper && (sha256(bytes) !== expectedHelper.sha256 || bytes.length !== expectedHelper.bytes)) throw new Error('Damaged multipart recovery helper');
            const hash = addObject(checkpoint.directory, bytes); helperFiles[child.name] = hash; helperObjects[hash] = bytes.length;
          }
        }
        const helperRef = saveSnapshot(checkpoint.directory, { format: 'clemcast-incremental-snapshot', version: 1, repository, kind: 'legacy',
          createdAt: `${file.name.slice(-10)}T00:00:00.000Z`, files: helperFiles, objects: helperObjects, legacy: [], migrations: [], summary: { files: Object.keys(helperFiles).length }, originalName: `${file.name} transport instructions` });
        migrations.push({ name: file.name, artifacts, snapshots: [ref, helperRef], containers: [file.name] });
      } finally { fs.rmSync(download, { recursive: true, force: true }); }
    }
  }
  return migrations;
}

function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function dateLabel(date: string, timeZone: string): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(date));
}

/** Keep migrated history in the canonical archive too, so standalone recovery ZIPs stay complete. */
function retainLegacyFiles(checkpoint: LocalCheckpoint, refs: SnapshotRef[]): boolean {
  const immutable = new Map<string, string>();
  for (const [name, hash] of Object.entries(checkpoint.files)) if (/^sources\//.test(name)
    || (/^archive\//.test(name) && name !== 'archive/latest.json') || /^output\/[^/]+\/attachments\//.test(name)) immutable.set(hash, name);
  let changed = false;
  for (const ref of refs) {
    const snapshot = readSnapshot(checkpoint.directory, ref), locations: Record<string, string> = {};
    for (const hash of Object.values(snapshot.files)) {
      let name = immutable.get(hash);
      if (!name) {
        name = `archive/legacy-recovery/objects/${hash}`;
        const filename = path.join(checkpoint.workspace, name);
        if (!fs.existsSync(filename)) changed = true;
        writeImmutable(filename, readObject(checkpoint.directory, hash)); immutable.set(hash, name);
      }
      locations[hash] = name;
    }
    const filename = path.join(checkpoint.workspace, 'archive/legacy-recovery/snapshots', ref.name);
    // A durable mapping must not drift when another equivalent local path appears later.
    if (!fs.existsSync(filename)) {
      writeImmutable(filename, JSON.stringify({ format: 'clemcast-legacy-recovery', version: 1,
        originalName: snapshot.originalName, originalZipSha256: snapshot.originalZipSha256,
        files: snapshot.files, locations: sorted(locations) }, null, 2));
      changed = true;
    }
  }
  return changed;
}

export function publishIncrementalBackup(checkpoint: LocalCheckpoint, store: BackupStore, timeZone = 'Europe/Rome'): { snapshot: SnapshotRef; summary: Record<string, number>; newObjects: number; bytes: number } {
  const directory = checkpoint.directory;
  const contents = store.list(BACKUP_DATA);
  let repository: string;
  if (contents.some(file => file.name === 'repository.json')) {
    const markerBytes = store.read(MARKER), marker = JSON.parse(markerBytes.toString('utf8'));
    if (marker.format !== 'clemcast-incremental-repository' || marker.version !== 1 || typeof marker.id !== 'string') throw new Error('Invalid incremental repository marker');
    repository = marker.id;
    writeImmutable(path.join(directory, MARKER), markerBytes);
  } else {
    if (contents.length) throw new Error('Backup data folder has files but its repository marker is missing');
    const pendingMarker = path.join(directory, MARKER);
    const marker = fs.existsSync(pendingMarker) ? JSON.parse(fs.readFileSync(pendingMarker, 'utf8'))
      : { format: 'clemcast-incremental-repository', version: 1, id: crypto.randomUUID() };
    repository = marker.id; writeImmutable(pendingMarker, JSON.stringify(marker, null, 2)); store.upload(directory, [MARKER], true);
    if (!same(JSON.parse(store.read(MARKER).toString('utf8')), marker)) throw new Error('Repository initialization could not be verified');
  }
  const before = headBytes(store), previousHead = before ? parseHead(before, repository) : undefined;
  let interrupted: BackupSnapshot | undefined, interruptedRef: SnapshotRef | undefined;
  if (!before && (store.list(`${BACKUP_DATA}/snapshots`).length || store.list(`${BACKUP_DATA}/objects`).length)) {
    const pendingPath = path.join(directory, 'pending.json');
    if (!fs.existsSync(pendingPath) || JSON.parse(fs.readFileSync(pendingPath, 'utf8')).repository !== repository) {
      throw new Error('The repository has saved data but CURRENT.json is missing. Recover its current pointer before creating another backup.');
    }
    interruptedRef = JSON.parse(fs.readFileSync(pendingPath, 'utf8')).snapshot;
    interrupted = readSnapshot(directory, interruptedRef!);
    hydrateObjects(store, directory, interrupted.objects);
  }
  const previous = previousHead ? loadHistory(store, directory, previousHead.snapshot, repository) : undefined;
  if (previous) hydrateObjects(store, directory, previous.objects);
  const migrations = migrateLegacy(store, checkpoint, repository, previous?.migrations ?? interrupted?.migrations ?? []);
  const legacy = [...migrations.flatMap(m => m.snapshots), ...(interruptedRef ? [interruptedRef] : [])];
  if (retainLegacyFiles(checkpoint, migrations.flatMap(m => m.snapshots))) checkpoint = prepareIncrementalBackup(checkpoint.workspace);
  const objects = localObjects(directory);
  const value: BackupSnapshot = { format: 'clemcast-incremental-snapshot', version: 1, repository, kind: 'archive', createdAt: checkpoint.createdAt,
    files: checkpoint.files, objects, ...(previousHead && { previous: previousHead.snapshot }), legacy, migrations, summary: summary(checkpoint) };
  if (previous) assertBackupRetained(directory, previous, value);
  if (interrupted) assertBackupRetained(directory, interrupted, value);
  const unchanged = previous && same(previous.files, value.files) && same(previous.objects, value.objects) && same(previous.migrations, migrations);
  const ref = unchanged ? previousHead!.snapshot : saveSnapshot(directory, value);
  const snapshot = unchanged ? previous : value;
  // Persist the exact pending snapshot so interrupted first uploads are resumable.
  writeAtomic(path.join(directory, 'pending.json'), JSON.stringify({ repository, snapshot: ref }));
  const inventory = new Map(store.list(`${BACKUP_DATA}/objects`).map(file => [file.name, file]));
  const newHashes = Object.keys(objects).filter(hash => !inventory.has(hash));
  for (const [hash, size] of Object.entries(objects)) {
    const stored = inventory.get(hash);
    if (stored && (stored.directory || stored.size !== size || (stored.sha256 && stored.sha256 !== hash))) throw new Error(`Previously saved Drive object is damaged: ${hash}`);
  }
  console.log(`Incremental backup: uploading ${newHashes.length} new objects (${(newHashes.reduce((n, h) => n + objects[h]!, 0) / 1e6).toFixed(1)} MB).`);
  store.upload(directory, newHashes.map(objectName), true);
  const snapshotFiles = new Set<string>([refName(ref)]);
  for (const child of legacy) snapshotFiles.add(refName(child));
  store.upload(directory, [...snapshotFiles], true);
  if (sha256(store.read(refName(ref))) !== ref.sha256) throw new Error('Uploaded dated snapshot failed readback verification');
  // New bytes are actually downloaded; all retained objects are rechecked against provider checksums.
  const afterObjects = new Map(store.list(`${BACKUP_DATA}/objects`).map(file => [file.name, file]));
  const verifyNames: string[] = [];
  for (const [hash, size] of Object.entries(objects)) {
    const stored = afterObjects.get(hash);
    if (!stored || stored.directory || stored.size !== size || (stored.sha256 && stored.sha256 !== hash)) throw new Error(`Drive backup object failed verification: ${hash}`);
    if (newHashes.includes(hash) || !stored.sha256) verifyNames.push(objectName(hash));
  }
  const downloaded = fs.mkdtempSync(path.join(os.tmpdir(), 'clemcast-drive-proof-'));
  try {
    console.log(`Verifying ${verifyNames.length} objects by downloading their bytes...`);
    store.download(verifyNames, downloaded);
    for (const name of verifyNames) if (sha256(fs.readFileSync(path.join(downloaded, name))) !== path.posix.basename(name)) throw new Error('Downloaded Drive backup checksum mismatch');
  } finally { fs.rmSync(downloaded, { recursive: true, force: true }); }
  checkRestorable(directory, snapshot);
  for (const child of legacy) checkRestorable(directory, readSnapshot(directory, child));
  // A concurrent update is never silently accepted. Immutable snapshots remain recoverable.
  const now = headBytes(store);
  if (!same(before?.toString('utf8'), now?.toString('utf8'))) throw new Error('Another computer updated the backup during this run. No current backup was replaced; rerun.');
  const head: Head = { format: 'clemcast-incremental-head', version: 1, repository, snapshot: ref, verifiedAt: new Date().toISOString() };
  const headText = JSON.stringify(head, null, 2); writeAtomic(path.join(directory, HEAD), headText);
  store.upload(directory, [HEAD], false);
  if (store.read(HEAD).toString('utf8') !== headText) throw new Error('Current backup promotion could not be verified; dated snapshots remain intact');
  updateReports(store, directory, head, snapshot, timeZone);
  // Only generated containers are retired, after every payload and historical snapshot is verified.
  for (const migration of migrations) {
    const retire: string[] = [];
    for (const old of migration.artifacts) {
      const parent = path.posix.dirname(old.name) === '.' ? '' : path.posix.dirname(old.name);
      const current = store.list(parent).find(file => file.name === path.posix.basename(old.name));
      if (!current) continue;
      if (current.directory || current.size !== old.size || (old.id && current.id !== old.id)) throw new Error('Older backup changed before retirement; it has been kept');
      let contentHash = current.sha256;
      if (!contentHash) {
        const proof = fs.mkdtempSync(path.join(os.tmpdir(), 'clemcast-retirement-proof-'));
        try { store.download([old.name], proof); contentHash = sha256(fs.readFileSync(path.join(proof, old.name))); }
        finally { fs.rmSync(proof, { recursive: true, force: true }); }
      }
      if (contentHash !== old.sha256) throw new Error('Older backup changed before retirement; it has been kept');
      retire.push(old.name);
    }
    store.trash(retire); store.trash(migration.containers);
  }
  console.log(`Verified current backup: ${dateLabel(snapshot.createdAt, timeZone)} (${timeZone}). Previous data and dated recovery history retained.`);
  return { snapshot: ref, summary: snapshot.summary, newObjects: newHashes.length, bytes: Object.values(objects).reduce((n, size) => n + size, 0) };
}

function updateReports(store: BackupStore, directory: string, head: Head, snapshot: BackupSnapshot, timeZone: string): void {
  const latest = `Latest backup - ${dateLabel(snapshot.createdAt, timeZone).replace(':', '-')} - verified.txt`;
  const guide = 'START HERE - Clemcast backups.txt';
  const report = `CLEMCAST - VERIFIED BACKUP\n\nArchive date: ${dateLabel(snapshot.createdAt, timeZone)} (${timeZone})\nLast verified: ${dateLabel(head.verifiedAt, timeZone)} (${timeZone})\n\n${snapshot.summary.posts} posts\n${snapshot.summary.observations} preserved message observations\n${snapshot.summary.media} saved media files\n${snapshot.summary.originalExports} exact original WhatsApp exports\n\nThis is the current recovery point. Its complete contents are stored once in "${BACKUP_DATA}". Keep that folder.\nOlder messages, original exports and earlier backup history are retained there.\n\nTo recover on this computer into a NEW folder:\n  npm run recover-drive -- /path/to/new-clemcast-recovery\n\nTo see the dated recovery points:\n  npm run backup-history\n\nSnapshot: ${head.snapshot.name}\nSHA-256: ${head.snapshot.sha256}\n`;
  const instructions = `CLEMCAST BACKUPS - START HERE\n\nYour reading website: https://clemcast.pages.dev/clemcast/\n\nThis Google Drive folder protects the archive if the computer is lost or damaged.\n\nOPEN "Latest backup - DATE - verified.txt" to see the current date, counts and recovery instructions.\nKEEP "${BACKUP_DATA}". It contains shared file data and small dated snapshots. It is required for recovery.\n\nYOUR ROUTINE\n1. Export the WhatsApp chat WITH MEDIA into Downloads.\n2. Run npm run parse in the Clemcast project.\n\nThe command checks that earlier data survives, uploads only new file contents, verifies the Drive copy, and updates the website. The latest recovery point changes only after verification.\n\nSTORAGE\nEach unique saved file is uploaded once. Dated snapshots share those files. Exact original WhatsApp exports are retained and can overlap internally. Routine backups do not create another full recovery ZIP. Use npm run backup only when you want a standalone ZIP.\n\nOlder full backup ZIPs and multipart packages are migrated file for file, verified and moved to Drive Trash. Their contents remain recoverable through dated backup history. No command permanently empties Trash or removes unique backup data.\n\nRECOVER\nnpm run recover-drive -- /path/to/new-clemcast-recovery\nnpm run backup-history\n\nIf you download this ENTIRE Google Drive folder, keep its structure. Recover offline with:\n  npm run recover-incremental -- "/path/to/downloaded/Clemcast backups" /path/to/new-recovery\n\nThe code is also at https://github.com/grod220/whatsapp-local-backup . Install dependencies with npm ci; on a new computer connect Drive with npm run setup-drive. Google credentials are stored separately from archive data.\n`;
  writeAtomic(path.join(directory, latest), report); writeAtomic(path.join(directory, guide), instructions);
  store.upload(directory, [guide, latest], false);
  if (store.read(latest).toString('utf8') !== report || store.read(guide).toString('utf8') !== instructions) throw new Error('Backup instructions failed readback verification');
  const older = store.list('').filter(file => !file.directory && /^Latest backup - .+ - verified\.txt$/.test(file.name) && file.name !== latest);
  store.trash(older.map(file => file.name));
}

export function recoverIncrementalBackup(store: BackupStore, destination: string, requestedSnapshot?: string): BackupSnapshot {
  if (fs.existsSync(destination)) throw new Error('Recovery destination already exists; choose a new directory');
  const temporary = fs.mkdtempSync(path.join(path.dirname(destination), '.clemcast-recovery-'));
  try {
    const marker = JSON.parse(store.read(MARKER).toString('utf8'));
    const head = parseHead(store.read(HEAD), marker.id);
    const ref = requestedSnapshot ? { name: requestedSnapshot, sha256: requestedSnapshot.match(/--([a-f0-9]{64})\.json$/)?.[1] ?? '' } : head.snapshot;
    const snapshot = loadHistory(store, temporary, ref, marker.id);
    hydrateObjects(store, temporary, snapshot.objects); checkRestorable(temporary, snapshot);
    const restored = path.join(temporary, 'restored'); fs.mkdirSync(restored);
    for (const [name, hash] of Object.entries(snapshot.files)) {
      const target = path.join(restored, safeRelative(name)); fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(temporary, objectName(hash)), target);
    }
    if (snapshot.kind === 'archive') verifyRecoveryTree(restored);
    // Preserve the whole historical object store next to the recovered current files.
    const repository = path.join(restored, '.incremental-backup', 'repository'); fs.mkdirSync(repository, { recursive: true });
    fs.renameSync(path.join(temporary, BACKUP_DATA), path.join(repository, BACKUP_DATA));
    writeAtomic(path.join(repository, MARKER), JSON.stringify(marker, null, 2));
    writeAtomic(path.join(repository, HEAD), JSON.stringify({ ...head, snapshot: ref }, null, 2));
    publishNewDirectory(restored, destination); return snapshot;
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

export function recoverLocalCheckpoint(directory: string, destination: string): void {
  if (fs.existsSync(destination)) throw new Error('Recovery destination already exists; choose a new directory');
  const ref = JSON.parse(fs.readFileSync(path.join(directory, 'LOCAL.json'), 'utf8')) as SnapshotRef;
  const snapshot = readSnapshot(directory, ref); checkRestorable(directory, snapshot);
  const temporary = fs.mkdtempSync(path.join(path.dirname(destination), '.clemcast-local-recovery-'));
  try {
    for (const [name, hash] of Object.entries(snapshot.files)) {
      const target = path.join(temporary, safeRelative(name)); fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(directory, objectName(hash)), target);
    }
    verifyRecoveryTree(temporary);
    fs.cpSync(directory, path.join(temporary, '.incremental-backup', 'repository'), { recursive: true });
    publishNewDirectory(temporary, destination);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

export function backupHistory(store: BackupStore): Array<{ name: string; date: string; kind: string; originalName?: string }> {
  return store.list(`${BACKUP_DATA}/snapshots`).filter(file => !file.directory && /--[a-f0-9]{64}\.json$/.test(file.name))
    .map(file => {
      const ref = { name: file.name, sha256: file.name.match(/--([a-f0-9]{64})\.json$/)![1]! };
      const value = parseSnapshot(store.read(refName(ref)), ref);
      return { name: file.name, date: value.createdAt, kind: value.kind, ...(value.originalName && { originalName: value.originalName }) };
    }).sort((a, b) => b.date.localeCompare(a.date));
}

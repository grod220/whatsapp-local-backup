import fs from 'node:fs';
import path from 'node:path';
import { assertMessagesRetained, isSafeFilename, readMessages, sha256, writeAtomic, writeImmutable } from './storage.js';

export interface Snapshot {
  // v1 stored media objects too; v2 reuses the immutable media in output/.
  version: 1 | 2;
  files: Record<string, string>;
}

export function objectPath(archiveDir: string, hash: string): string {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid archive hash');
  return path.join(archiveDir, 'objects', hash);
}

export function readObject(archiveDir: string, hash: string): Buffer {
  const data = fs.readFileSync(objectPath(archiveDir, hash));
  if (sha256(data) !== hash) throw new Error(`Damaged archive object: ${hash}`);
  return data;
}

export function isMediaPath(relative: string): boolean {
  return relative.split('/').length === 3 && relative.split('/')[1] === 'attachments';
}

export function readSnapshot(archiveDir: string, hash: string): Snapshot {
  objectPath(archiveDir, hash); // Validate the hash before using it in a path.
  const data = fs.readFileSync(path.join(archiveDir, 'snapshots', `${hash}.json`));
  if (sha256(data) !== hash) throw new Error(`Damaged snapshot: ${hash}`);
  const snapshot = JSON.parse(data.toString('utf8')) as Snapshot;
  if (![1, 2].includes(snapshot.version) || !snapshot.files || typeof snapshot.files !== 'object' || Array.isArray(snapshot.files)) {
    throw new Error('Invalid archive snapshot');
  }
  for (const [relative, object] of Object.entries(snapshot.files)) {
    const parts = relative.split('/');
    if (!parts.every(isSafeFilename) || !(isMediaPath(relative)
      || (parts.length === 2 && ['data.json', 'manifest.json', 'group-info.json'].includes(parts[1]!)))) {
      throw new Error('Invalid snapshot path');
    }
    objectPath(archiveDir, object);
  }
  return snapshot;
}

export function latestSnapshotHash(archiveDir: string): string {
  const hash = JSON.parse(fs.readFileSync(path.join(archiveDir, 'latest.json'), 'utf8')).snapshot;
  objectPath(archiveDir, hash);
  return hash;
}

export function snapshotHashes(archiveDir: string): string[] {
  return fs.readdirSync(path.join(archiveDir, 'snapshots'))
    .filter(name => /^[a-f0-9]{64}\.json$/.test(name)).sort().map(name => name.slice(0, -5));
}

function readMedia(outputDir: string, relative: string, hash: string): Buffer {
  const filename = path.join(outputDir, relative);
  if (!fs.existsSync(filename)) {
    throw new Error(`Previously archived media is missing: ${filename}. Recover it from an unpacked full backup before importing.`);
  }
  if (!fs.lstatSync(filename).isFile()) throw new Error(`Expected regular media file: ${filename}`);
  const bytes = fs.readFileSync(filename);
  if (sha256(bytes) !== hash) throw new Error(`Previously archived media changed: ${filename}. Restore it from a full backup before importing.`);
  return bytes;
}

/** Refuse a fresh, smaller archive after output/ is accidentally removed or edited. */
export function verifyContinuity(outputDir: string, archiveDir: string): void {
  const latest = path.join(archiveDir, 'latest.json');
  if (!fs.existsSync(latest)) {
    const snapshots = path.join(archiveDir, 'snapshots');
    if (fs.existsSync(snapshots) && fs.readdirSync(snapshots).some(name => name.endsWith('.json'))) {
      throw new Error('Archive latest.json is missing. Restore a snapshot before importing.');
    }
    return;
  }
  const snapshot = readSnapshot(archiveDir, latestSnapshotHash(archiveDir));
  for (const [relative, hash] of Object.entries(snapshot.files)) {
    const filename = path.join(outputDir, relative);
    if (!fs.existsSync(filename)) throw new Error(`Previously archived file is missing: ${filename}. Restore from a full backup before importing.`);
    if (relative.endsWith('/data.json')) {
      const prior = JSON.parse(readObject(archiveDir, hash).toString('utf8'));
      assertMessagesRetained(prior, readMessages(filename));
    } else if (isMediaPath(relative)) readMedia(outputDir, relative, hash);
  }
}

export function canonicalFiles(outputDir: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(outputDir)) return files;
  for (const group of fs.readdirSync(outputDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (group.isSymbolicLink()) throw new Error(`Unexpected symbolic link: ${group.name}`);
    if (!group.isDirectory()) continue;
    const dir = path.join(outputDir, group.name);
    for (const name of ['data.json', 'group-info.json', 'manifest.json']) {
      const filename = path.join(dir, name);
      if (fs.existsSync(filename)) files.push(`${group.name}/${name}`);
    }
    const attachments = path.join(dir, 'attachments');
    if (fs.existsSync(attachments)) {
      for (const name of fs.readdirSync(attachments).sort()) files.push(`${group.name}/attachments/${name}`);
    }
  }
  return files;
}

/** Save small metadata versions plus media hashes. Media stays in output/ only. */
export function captureSnapshot(outputDir: string, archiveDir: string): string | undefined {
  verifyContinuity(outputDir, archiveDir);
  const files: Record<string, string> = {};
  for (const relative of canonicalFiles(outputDir)) {
    const filename = path.join(outputDir, relative);
    if (!fs.lstatSync(filename).isFile()) throw new Error(`Expected a regular archive file: ${filename}`);
    const bytes = fs.readFileSync(filename);
    const hash = sha256(bytes);
    if (!isMediaPath(relative)) writeImmutable(objectPath(archiveDir, hash), bytes);
    files[relative] = hash;
  }
  if (!Object.keys(files).length) return undefined;
  const bytes = JSON.stringify({ version: 2, files } satisfies Snapshot, null, 2);
  const hash = sha256(bytes);
  writeImmutable(path.join(archiveDir, 'snapshots', `${hash}.json`), bytes);
  writeAtomic(path.join(archiveDir, 'latest.json'), JSON.stringify({ snapshot: hash }, null, 2));
  return hash;
}

/** Audit every historical media reference, including files not used by current messages. */
export function auditArchive(outputDir: string, archiveDir: string): { metadataHashes: Set<string>; mediaHashes: Set<string>; snapshots: string[] } {
  verifyContinuity(outputDir, archiveDir);
  const metadataHashes = new Set<string>();
  const mediaHashes = new Set<string>();
  const checkedFiles = new Map<string, string>();
  const snapshots = snapshotHashes(archiveDir);
  if (!snapshots.includes(latestSnapshotHash(archiveDir))) throw new Error('Latest snapshot is absent from the archive');
  for (const id of snapshots) {
    for (const [relative, hash] of Object.entries(readSnapshot(archiveDir, id).files)) {
      if (isMediaPath(relative)) {
        if (checkedFiles.has(relative) && checkedFiles.get(relative) !== hash) throw new Error(`Historical media was overwritten: ${relative}`);
        if (!checkedFiles.has(relative)) readMedia(outputDir, relative, hash);
        checkedFiles.set(relative, hash);
        mediaHashes.add(hash);
      } else {
        if (!metadataHashes.has(hash)) readObject(archiveDir, hash);
        metadataHashes.add(hash);
      }
    }
  }
  return { metadataHashes, mediaHashes, snapshots };
}

export function sourcesDirectory(archiveDir: string): string {
  return path.join(path.dirname(path.resolve(archiveDir)), 'sources');
}

export function archiveSource(zipPath: string, archiveDir: string): { hash: string; filename: string } {
  const bytes = fs.readFileSync(zipPath);
  const hash = sha256(bytes);
  const legacy = path.join(archiveDir, 'sources', `${hash}.zip`);
  const filename = fs.existsSync(legacy) ? legacy : path.join(sourcesDirectory(archiveDir), `${hash}.zip`);
  writeImmutable(filename, bytes);
  const receipt = JSON.stringify({ sha256: hash, originalName: path.basename(zipPath) }, null, 2);
  writeImmutable(path.join(archiveDir, 'receipts', `${sha256(receipt)}.json`), receipt);
  return { hash, filename };
}

/** Original export ZIPs are separate from routine cumulative backups. */
export function sourceInventory(archiveDir: string): Array<{ sha256: string; originalNames: string[] }> {
  const receipts = path.join(archiveDir, 'receipts');
  const sources = new Map<string, Set<string>>();
  if (fs.existsSync(receipts)) {
    for (const name of fs.readdirSync(receipts).filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
      const bytes = fs.readFileSync(path.join(receipts, name));
      if (`${sha256(bytes)}.json` !== name) throw new Error(`Damaged source receipt: ${name}`);
      const receipt = JSON.parse(bytes.toString('utf8'));
      objectPath(archiveDir, receipt.sha256);
      if (typeof receipt.originalName !== 'string') throw new Error(`Invalid source receipt: ${name}`);
      if (!sources.has(receipt.sha256)) sources.set(receipt.sha256, new Set());
      sources.get(receipt.sha256)!.add(receipt.originalName);
    }
  }
  return [...sources].sort(([a], [b]) => a.localeCompare(b)).map(([hash, names]) => ({ sha256: hash, originalNames: [...names].sort() }));
}

/** Restore into a new directory. Media comes from a legacy object or a verified full backup's output/. */
export function restoreSnapshot(archiveDir: string, targetDir: string, snapshotHash?: string, mediaDir = path.join(path.dirname(path.resolve(archiveDir)), 'output')): void {
  if (fs.existsSync(targetDir)) throw new Error(`Restore destination already exists: ${targetDir}. Choose a new directory.`);
  const snapshot = readSnapshot(archiveDir, snapshotHash ?? latestSnapshotHash(archiveDir));
  const readFile = (relative: string, hash: string): Buffer => {
    // Existing v1 objects remain usable until deliberately compacted, including for media repair.
    if (!isMediaPath(relative) || fs.existsSync(objectPath(archiveDir, hash))) return readObject(archiveDir, hash);
    return readMedia(mediaDir, relative, hash);
  };
  // Verify every file before creating the destination.
  for (const [relative, hash] of Object.entries(snapshot.files)) readFile(relative, hash);
  fs.mkdirSync(targetDir, { recursive: true });
  for (const [relative, hash] of Object.entries(snapshot.files)) {
    writeImmutable(path.join(targetDir, relative), readFile(relative, hash));
  }
}

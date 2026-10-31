import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { checkDriveConnection, driveCredentialsPath, runRclone, type DriveBackupConfig } from './drive-backup.js';
import { isSafeFilename, writeAtomic, writeImmutable } from './storage.js';

export interface StoredFile { name: string; size: number; directory: boolean; id?: string; sha256?: string; modifiedAt?: string }
export interface BackupStore {
  list(directory: string): StoredFile[];
  read(filename: string): Buffer;
  download(filenames: string[], destination: string): void;
  upload(source: string, filenames: string[], immutable: boolean): void;
  trash(filenames: string[]): void;
}

export function safeRelative(name: string): string {
  if (!name || !name.split('/').every(isSafeFilename)) throw new Error(`Unsafe backup path: ${name}`);
  return name;
}

/** Also supports recovery from a complete folder downloaded through Google Drive. */
export class DirectoryBackupStore implements BackupStore {
  constructor(readonly directory: string) {}
  list(directory: string): StoredFile[] {
    const dir = path.join(this.directory, directory ? safeRelative(directory) : '');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).map(entry => {
      if (!entry.isDirectory() && !entry.isFile()) throw new Error('Backup repository contains a non-regular file');
      const stat = fs.statSync(path.join(dir, entry.name));
      return { name: entry.name, directory: entry.isDirectory(), size: stat.size, modifiedAt: stat.mtime.toISOString() };
    });
  }
  read(filename: string): Buffer { return fs.readFileSync(path.join(this.directory, safeRelative(filename))); }
  download(filenames: string[], destination: string): void {
    for (const name of filenames) writeImmutable(path.join(destination, safeRelative(name)), this.read(name));
  }
  upload(source: string, filenames: string[], immutable: boolean): void {
    for (const name of filenames) {
      const bytes = fs.readFileSync(path.join(source, safeRelative(name)));
      (immutable ? writeImmutable : writeAtomic)(path.join(this.directory, name), bytes);
    }
  }
  trash(filenames: string[]): void {
    for (const name of filenames) {
      const filename = path.join(this.directory, safeRelative(name));
      if (!fs.existsSync(filename)) continue;
      if (fs.statSync(filename).isDirectory() && fs.readdirSync(filename).length) throw new Error('Refusing to remove a nonempty backup folder');
      const target = path.join(this.directory, '.trash', `${crypto.randomUUID()}-${name}`);
      fs.mkdirSync(path.dirname(target), { recursive: true }); fs.renameSync(filename, target);
    }
  }
}

export class DriveBackupStore implements BackupStore {
  private directories = new Set(['']);
  constructor(readonly config: DriveBackupConfig) { checkDriveConnection(config); }
  private remote(name = ''): string { return `${this.config.remote}:${name ? safeRelative(name) : ''}`; }
  private flags(): string[] {
    return ['--config', driveCredentialsPath(), '--drive-root-folder-id', this.config.folderId,
      '--retries', '3', '--low-level-retries', '5', '--contimeout', '30s', '--timeout', '5m', '--tpslimit', '8'];
  }
  list(directory: string): StoredFile[] {
    if (directory && !this.directories.has(directory)) {
      const parent = path.posix.dirname(directory) === '.' ? '' : path.posix.dirname(directory);
      if (!this.list(parent).some(entry => entry.directory && entry.name === path.posix.basename(directory))) return [];
      this.directories.add(directory);
    }
    const entries = JSON.parse(runRclone(['lsjson', this.remote(directory), '--hash', '--hash-type', 'sha256', ...this.flags()]));
    if (!Array.isArray(entries)) throw new Error('Invalid Drive file inventory');
    const names = new Set<string>();
    return entries.map(entry => {
      if (!isSafeFilename(entry.Name) || names.has(entry.Name)) throw new Error(`Ambiguous or unsafe Drive filename: ${entry.Name}`);
      names.add(entry.Name);
      const hash = Object.entries(entry.Hashes ?? {}).find(([name]) => name.toLowerCase().replace('-', '') === 'sha256')?.[1];
      if (typeof entry.IsDir !== 'boolean' || !Number.isSafeInteger(entry.Size) || entry.Size < 0
        || (hash !== undefined && (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)))) throw new Error('Invalid Drive object metadata');
      return { name: entry.Name, size: entry.Size, directory: entry.IsDir, id: entry.ID,
        ...(entry.ModTime && { modifiedAt: entry.ModTime }),
        ...(typeof hash === 'string' && { sha256: hash }) };
    });
  }
  read(filename: string): Buffer { return Buffer.from(runRclone(['cat', this.remote(filename), ...this.flags()])); }
  private withList(names: string[], operation: (list: string) => void): void {
    if (!names.length) return;
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'clemcast-transfer-'));
    try {
      const filename = path.join(temporary, 'files.txt');
      if (names.some(name => /[\r\n]/.test(name))) throw new Error('Backup transfer filenames cannot contain newlines');
      fs.writeFileSync(filename, names.map(safeRelative).join('\n') + '\n'); operation(filename);
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  }
  download(filenames: string[], destination: string): void {
    this.withList(filenames, list => runRclone(['copy', this.remote(), destination, '--files-from-raw', list,
      '--checksum', '--immutable', '--transfers', '4', ...this.flags()], true));
  }
  upload(source: string, filenames: string[], immutable: boolean): void {
    this.withList(filenames, list => runRclone(['copy', source, this.remote(), '--files-from-raw', list,
      '--checksum', ...(immutable ? ['--immutable'] : []), '--transfers', '4', '--stats', '10s', '--stats-log-level', 'NOTICE', ...this.flags()], true));
    this.directories = new Set(['']);
  }
  trash(filenames: string[]): void {
    const files: string[] = [];
    for (const name of filenames) {
      const parent = path.posix.dirname(name) === '.' ? '' : path.posix.dirname(name);
      const entry = this.list(parent).find(entry => entry.name === path.posix.basename(name));
      if (!entry) continue;
      if (entry.directory) runRclone(['rmdir', this.remote(name), '--drive-use-trash=true', ...this.flags()], true);
      else files.push(name);
    }
    this.withList(files, list => runRclone(['delete', this.remote(), '--files-from-raw', list, '--drive-use-trash=true', ...this.flags()], true));
  }
}

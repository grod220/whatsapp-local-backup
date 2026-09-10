import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { MessageWithId } from './types.js';

export function sha256(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** Publish complete files only. An interrupted write cannot truncate the old file. */
export function writeAtomic(filename: string, data: Buffer | string): void {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
  try {
    writeNew(temporary, data);
    fs.renameSync(temporary, filename);
    syncDirectory(path.dirname(filename));
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function syncDirectory(directory: string): void {
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function writeNew(filename: string, data: Buffer | string): void {
  const fd = fs.openSync(filename, 'wx');
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

/** Never replace an existing archive object, even if it is damaged. */
export function writeImmutable(filename: string, data: Buffer | string): void {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  if (fs.existsSync(filename)) {
    if (!fs.readFileSync(filename).equals(Buffer.from(data))) {
      throw new Error(`Archive integrity check failed: ${filename}`);
    }
    return;
  }
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
  try {
    writeNew(temporary, data);
    // link, unlike rename, refuses to overwrite a destination created concurrently.
    fs.linkSync(temporary, filename);
    syncDirectory(path.dirname(filename));
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export function withBackupLock<T>(workspace: string, operation: () => T): T {
  const lock = path.join(workspace, '.backup-lock');
  try { fs.mkdirSync(lock); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    throw new Error('Another backup may be running (.backup-lock exists). If a previous process crashed, confirm it has stopped before removing the lock directory.');
  }
  try {
    fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }));
    return operation();
  } finally {
    fs.rmSync(lock, { recursive: true });
  }
}

export function isSafeFilename(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value !== '.' && value !== '..'
    && !/[\\/\0]/.test(value);
}

export function readMessages(filename: string): MessageWithId[] {
  const messages: unknown = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (!Array.isArray(messages) || messages.some(msg => !msg || typeof msg !== 'object'
    || typeof msg.id !== 'string' || typeof msg.date !== 'string' || !Number.isFinite(Date.parse(msg.date))
    || (msg.author !== null && typeof msg.author !== 'string') || typeof msg.message !== 'string'
    || (msg.attachment !== undefined && !isSafeFilename(msg.attachment)))) {
    throw new Error(`Invalid message history: ${filename}. Restore it before importing.`);
  }
  return messages as MessageWithId[];
}

/** Includes multiplicity: two identical historical records must both survive. */
export function assertMessagesRetained(previous: MessageWithId[], current: MessageWithId[]): void {
  const counts = new Map<string, number>();
  for (const msg of current) {
    const key = JSON.stringify(msg);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const msg of previous) {
    const key = JSON.stringify(msg);
    const count = counts.get(key) ?? 0;
    if (!count) throw new Error('Existing messages were removed or changed. Restore the archived history before importing.');
    counts.set(key, count - 1);
  }
}

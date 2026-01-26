import * as crypto from 'crypto';
import * as path from 'path';
import type { MessageWithId } from './types.js';

export function hashMessage(msg: Omit<MessageWithId, 'id'>): string {
  // Truncate to minute precision - WhatsApp exports can vary by seconds
  const dateToMinute = new Date(msg.date).toISOString().slice(0, 16);
  const hashData = { ...msg, date: dateToMinute };
  return crypto.createHash('sha256').update(JSON.stringify(hashData)).digest('hex');
}

export function extractGroupName(zipFilename: string): string {
  const match = zipFilename.match(/^WhatsApp Chat - (.+)\.zip$/);
  const rawName = match?.[1] ?? zipFilename.replace(/\.zip$/, '');
  // Sanitize for filesystem safety: remove path separators and special chars
  return rawName.replace(/[\/\\:*?"<>|]/g, '_').trim();
}

export function isMacOSArtifact(entryName: string): boolean {
  return entryName.startsWith('__MACOSX/') ||
         entryName.includes('/__MACOSX/') ||
         path.basename(entryName) === '.DS_Store';
}

export function isPathTraversal(entryName: string, outputDir: string): boolean {
  const resolvedPath = path.resolve(outputDir, entryName);
  const normalizedOutput = path.resolve(outputDir);
  return !resolvedPath.startsWith(normalizedOutput + path.sep) && resolvedPath !== normalizedOutput;
}

export function isSystemMessage(author: string | null, message: string): boolean {
  if (author === null) return true;

  const systemPatterns = [
    /^Messages and calls are end-to-end encrypted/,
    /created (this )?group/,
    /changed the group (description|name|icon)/,
    / added /,
    / removed /,
    / joined using /,
    / left$/,
    /^Missed (video|voice) call/,
    /^You're now an admin$/,
    /is no longer an admin$/,
    /turned on disappearing messages/,
    /changed the settings/,
    /can invite new members using a group link$/,
    /turned on admin approval to join this group$/,
  ];

  return systemPatterns.some(pattern => pattern.test(message));
}

// Clean Unicode artifacts: directional formatting chars and normalize non-breaking hyphens
export function cleanUnicode(str: string): string {
  return str
    .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '')  // LTR/RTL marks, embeddings, isolates
    .replace(/\u2011/g, '-');  // Non-breaking hyphen → regular hyphen
}

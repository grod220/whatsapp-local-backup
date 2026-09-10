import * as path from 'path';

export function extractGroupName(zipFilename: string): string {
  const match = zipFilename.match(/^WhatsApp Chat (?:with |[-–] )(.+)\.zip$/i);
  let rawName = match?.[1] ?? zipFilename.replace(/\.zip$/i, '');
  // Strip macOS duplicate suffixes like " (1)", " (2)", etc.
  rawName = rawName.replace(/ \(\d+\)$/, '');
  // The display name is also the chat identity; only slugify sanitizes paths.
  return rawName.trim();
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

// Detect parsing artifacts: lines that are just "Name:" with no actual content
export function isEmptyAuthorLine(author: string | null, message: string): boolean {
  if (author !== null) return false;
  // Pattern: message is just "Name:" or "Name: " (name followed by colon and optional whitespace)
  return /^[^:\n]+:\s*$/.test(message);
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
    /requested to add/,
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

// Convert a name to a URL-friendly slug
export function slugify(str: string): string {
  const result = str
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')  // Remove diacritics
    .replace(/[^\w\s-]/g, '')          // Remove non-word chars (emojis, symbols)
    .replace(/\s+/g, '-')              // Spaces to hyphens
    .replace(/-+/g, '-')               // Collapse multiple hyphens
    .replace(/^-|-$/g, '');            // Trim leading/trailing hyphens
  // Fallback for emoji-only or non-ASCII names that result in empty string
  return result || 'group';
}

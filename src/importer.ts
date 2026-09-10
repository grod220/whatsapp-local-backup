import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { parseString } from 'whatsapp-chat-parser';
import type { AttachmentManifest, MessageWithId } from './types.js';
import { archiveSource } from './archive.js';
import { mergeMessages } from './merge.js';
import { isSafeFilename, readMessages, sha256, writeAtomic, writeImmutable } from './storage.js';
import { cleanUnicode, extractGroupName, isMacOSArtifact, isPathTraversal, isSystemMessage, slugify } from './utils.js';

export function loadGroup(groupDir: string): { messages: MessageWithId[]; manifest: AttachmentManifest; name: string } {
  const messages = readMessages(path.join(groupDir, 'data.json'));
  const manifest = JSON.parse(fs.readFileSync(path.join(groupDir, 'manifest.json'), 'utf8')) as AttachmentManifest;
  const info = JSON.parse(fs.readFileSync(path.join(groupDir, 'group-info.json'), 'utf8'));
  if (typeof info.name !== 'string' || !info.name || !manifest.contentHashes
    || typeof manifest.contentHashes !== 'object' || Array.isArray(manifest.contentHashes)) {
    throw new Error(`Invalid group metadata: ${groupDir}`);
  }
  const filenames = new Set<string>();
  for (const [hash, filename] of Object.entries(manifest.contentHashes)) {
    if (!/^[a-f0-9]{64}$/.test(hash) || !isSafeFilename(filename)) throw new Error(`Invalid attachment manifest: ${groupDir}`);
    const bytes = fs.readFileSync(path.join(groupDir, 'attachments', filename));
    if (sha256(bytes) !== hash) throw new Error(`Media integrity check failed: ${path.join(groupDir, 'attachments', filename)}`);
    filenames.add(filename);
  }
  for (const msg of messages) {
    if (msg.attachment && !filenames.has(msg.attachment)) throw new Error(`Message attachment is absent from the manifest: ${msg.attachment}`);
  }
  return { messages, manifest, name: info.name };
}

export function validateOutput(outputDir: string): void {
  if (!fs.existsSync(outputDir)) return;
  for (const entry of fs.readdirSync(outputDir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error(`Unexpected symbolic link in output: ${entry.name}`);
    if (entry.isDirectory()) loadGroup(path.join(outputDir, entry.name));
  }
}

function resolveGroup(outputDir: string, name: string, explicitGroup?: string): string {
  if (explicitGroup !== undefined) {
    if (!isSafeFilename(explicitGroup) || slugify(explicitGroup) !== explicitGroup) throw new Error('--group must be a directory slug, such as clemcast');
    if (!fs.existsSync(path.join(outputDir, explicitGroup, 'data.json'))) throw new Error(`Unknown --group: ${explicitGroup}`);
    return explicitGroup;
  }
  const base = slugify(name);
  let slug = base;
  let suffix = 0;
  while (fs.existsSync(path.join(outputDir, slug))) {
    const info = JSON.parse(fs.readFileSync(path.join(outputDir, slug, 'group-info.json'), 'utf8'));
    if (info.name === name) return slug;
    slug = `${base}-${sha256(name).slice(0, 12)}${suffix ? `-${suffix}` : ''}`;
    suffix++;
  }
  return slug;
}

export interface ImportOptions {
  group?: string;
  daysFirst?: boolean;
}

export function importBackup(zipPath: string, outputDir: string, archiveDir: string, options: ImportOptions = {}): void {
  // Parse exactly the preserved bytes, even if the original download later changes.
  const source = archiveSource(zipPath, archiveDir);
  const groupName = extractGroupName(path.basename(zipPath));
  const slug = resolveGroup(outputDir, groupName, options.group);
  const groupDir = path.join(outputDir, slug);
  const attachmentsDir = path.join(groupDir, 'attachments');
  const exists = fs.existsSync(groupDir);
  const previous = exists ? loadGroup(groupDir) : { messages: [], manifest: { contentHashes: {} }, name: groupName };
  const contentHashes = new Map(Object.entries(previous.manifest.contentHashes));
  const entries = new AdmZip(source.filename).getEntries().filter(entry => !entry.isDirectory && !isMacOSArtifact(entry.entryName));
  for (const entry of entries) {
    if (isPathTraversal(entry.entryName, attachmentsDir) || entry.entryName.includes('\\')) {
      throw new Error(`Unsafe ZIP entry: ${entry.entryName}. Original ZIP preserved in sources/.`);
    }
  }
  let chats = entries.filter(entry => path.basename(entry.entryName) === '_chat.txt');
  if (!chats.length) chats = entries.filter(entry => /^WhatsApp Chat (?:with |[-–] ).+\.txt$/i.test(path.basename(entry.entryName)));
  if (!chats.length) chats = entries.filter(entry => entry.entryName.toLowerCase().endsWith('.txt'));
  if (chats.length !== 1) throw new Error(`Expected one chat transcript; found ${chats.length}. Original ZIP preserved in sources/.`);
  const chat = chats[0]!;
  const parsed = parseString(chat.getData().toString('utf8'), { parseAttachments: true, ...options });
  if (!parsed.length || parsed.some(msg => !Number.isFinite(msg.date.getTime()))) {
    throw new Error('No valid messages parsed. Original ZIP preserved; existing history was not replaced.');
  }

  const filenameMap = new Map<string, string>();
  const pendingFiles = new Map<string, Buffer>();
  const originalNames = new Set<string>();
  for (const entry of entries) {
    if (entry === chat) continue;
    const original = cleanUnicode(path.basename(entry.entryName));
    if (originalNames.has(original)) throw new Error(`Ambiguous attachment filename in ZIP: ${original}`);
    originalNames.add(original);
    const bytes = entry.getData(); // Any extraction/CRC error aborts the import.
    const hash = sha256(bytes);
    let filename = contentHashes.get(hash);
    if (!filename) {
      const ext = path.extname(original).toLowerCase();
      filename = `${hash}${/^[.][a-z0-9]{1,12}$/.test(ext) ? ext : ''}`;
      contentHashes.set(hash, filename);
      pendingFiles.set(filename, bytes);
    }
    filenameMap.set(original, filename);
  }

  let missingAttachments = 0;
  const incoming: Omit<MessageWithId, 'id'>[] = parsed.map(msg => {
    const text = cleanUnicode(msg.message);
    const author = msg.author === null ? null : cleanUnicode(msg.author);
    const marker = text.match(/<attached: (.+?)>/);
    const original = marker?.[1] ?? (msg.attachment ? cleanUnicode(msg.attachment.fileName) : undefined);
    const attachment = original ? filenameMap.get(original) : undefined;
    // Keep unresolved filenames and all text in the record. Never discard a message.
    let message = text;
    if (attachment && marker) message = text.replace(marker[0], '').trim();
    if (original && !attachment) missingAttachments++;
    return {
      date: msg.date, author, message,
      ...(attachment !== undefined && { attachment }),
      ...(original && !attachment && { missingAttachment: original }),
      ...(isSystemMessage(author, message) && { system: true as const }),
      source: source.hash,
    };
  });
  const messages = mergeMessages(previous.messages, incoming);
  // Initialize an empty group before media writes, so a failed first import is retryable.
  if (!exists) {
    fs.mkdirSync(attachmentsDir, { recursive: true });
    writeAtomic(path.join(groupDir, 'group-info.json'), JSON.stringify({ name: previous.name }, null, 2));
    writeAtomic(path.join(groupDir, 'manifest.json'), JSON.stringify({ contentHashes: {} }, null, 2));
    writeAtomic(path.join(groupDir, 'data.json'), '[]');
  }
  for (const [filename, bytes] of pendingFiles) writeImmutable(path.join(attachmentsDir, filename), bytes);
  // Manifest first: a crash can leave extra media, but cannot leave new dangling references.
  writeAtomic(path.join(groupDir, 'manifest.json'), JSON.stringify({ contentHashes: Object.fromEntries(contentHashes) }, null, 2));
  writeAtomic(path.join(groupDir, 'data.json'), JSON.stringify(messages, null, 2));
  console.log(`${previous.name}: ${previous.messages.length} existing + ${messages.length - previous.messages.length} new = ${messages.length} messages; ${pendingFiles.size} new media files.`);
  if (missingAttachments) console.warn(`  ${missingAttachments} attachment(s) were named but absent from this export. Their references and original ZIP are preserved.`);
}

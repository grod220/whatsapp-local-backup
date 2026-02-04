import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import AdmZip from 'adm-zip';
import { parseString } from 'whatsapp-chat-parser';

import type { MessageWithId, AttachmentManifest, ChunkManifest, ChunkInfo } from './types.js';
import {
  hashMessage,
  extractGroupName,
  isMacOSArtifact,
  isPathTraversal,
  isSystemMessage,
  isEmptyAuthorLine,
  cleanUnicode,
  slugify,
} from './utils.js';
import { generateHtml, generateIndex, type GroupInfo } from './html-generator.js';
import {
  discoverWhatsAppZips,
  getDownloadsPath,
  getDesktopPath,
  generateOutputZipPath,
} from './discovery.js';
import { createOutputZip, cleanupDirectory } from './zip-output.js';

/**
 * Groups messages by local day (YYYY-MM-DD) for chunked loading.
 * Uses local timezone to match how dates are displayed in the UI.
 * Returns a Map ordered from oldest to newest day.
 */
function groupMessagesByDay(messages: MessageWithId[]): Map<string, MessageWithId[]> {
  const byDay = new Map<string, MessageWithId[]>();

  for (const msg of messages) {
    const date = new Date(msg.date);
    // Skip invalid dates
    if (isNaN(date.getTime())) continue;
    // Use local date to match UI display (toDateString uses local timezone)
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const dayKey = `${year}-${month}-${day}`; // Local date "2024-01-15"

    if (!byDay.has(dayKey)) {
      byDay.set(dayKey, []);
    }
    byDay.get(dayKey)!.push(msg);
  }

  return byDay;
}

/**
 * Generates JSONP-style chunk files for lazy loading.
 * Returns the chunk manifest and the messages for the most recent day (for inline rendering).
 */
function generateChunks(
  messages: MessageWithId[],
  chunksDir: string
): { manifest: ChunkManifest; latestDayMessages: MessageWithId[] } {
  fs.mkdirSync(chunksDir, { recursive: true });

  // Filter out empty author lines (parsing artifacts) before chunking
  // This matches the filtering done in ChatViewer for inline messages
  const filteredMessages = messages.filter(
    msg => !isEmptyAuthorLine(msg.author, msg.message) || msg.attachment
  );

  const byDay = groupMessagesByDay(filteredMessages);
  const days = Array.from(byDay.keys()).sort(); // Oldest first

  const chunks: ChunkInfo[] = [];
  let latestDayMessages: MessageWithId[] = [];

  for (const day of days) {
    const dayMessages = byDay.get(day)!;
    if (dayMessages.length === 0) continue;

    const filename = `${day}.js`;

    // JSONP format: window.__loadChunk("2024-01-15", [...])
    const jsonpContent = `window.__loadChunk(${JSON.stringify(day)}, ${JSON.stringify(dayMessages)});`;
    fs.writeFileSync(path.join(chunksDir, filename), jsonpContent);

    const firstMsg = dayMessages[0]!;
    const lastMsg = dayMessages[dayMessages.length - 1]!;

    chunks.push({
      filename,
      date: day,
      messageCount: dayMessages.length,
      firstMessageId: firstMsg.id,
      lastMessageId: lastMsg.id,
    });

    // Track latest day for inline rendering
    latestDayMessages = dayMessages;
  }

  // Reverse to newest-first for the manifest (easier for client to load older chunks)
  chunks.reverse();

  const manifest: ChunkManifest = {
    totalMessages: messages.length,
    chunks,
  };

  // Write manifest
  fs.writeFileSync(path.join(chunksDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  return { manifest, latestDayMessages };
}

function messageKey(msg: Omit<MessageWithId, 'id'>): string {
  const dateToMinute = new Date(msg.date).toISOString().slice(0, 16);
  const author = msg.author ?? '';
  const attachment = msg.attachment ?? '';
  return `${dateToMinute}|${author}|${msg.message}|${attachment}`;
}

// Determine mode based on arguments
const providedPaths = process.argv.slice(2);
const isAutoMode = providedPaths.length === 0;

let zipPaths: string[];

if (isAutoMode) {
  // Auto mode: discover ZIPs in Downloads
  const downloadsPath = getDownloadsPath();
  zipPaths = discoverWhatsAppZips(downloadsPath);

  if (zipPaths.length === 0) {
    console.error('No WhatsApp backup ZIPs found in Downloads folder.');
    console.error(`\nExpected pattern: "WhatsApp Chat - <group name>.zip"`);
    console.error(`Searched in: ${downloadsPath}`);
    console.error(`\nTo manually specify files: npm run parse -- <file.zip> [file2.zip ...]`);
    process.exit(1);
  }

  console.log(`Auto mode: Found ${zipPaths.length} WhatsApp backup(s) in Downloads`);
} else {
  // Manual mode: use provided paths
  zipPaths = providedPaths;
}

const outputDir = './output';
fs.mkdirSync(outputDir, { recursive: true });

let processedCount = 0;
let failedCount = 0;

for (const zipPath of zipPaths) {
  if (!fs.existsSync(zipPath)) {
    console.error(`File not found: ${zipPath}`);
    failedCount++;
    continue;
  }

  const groupName = extractGroupName(path.basename(zipPath));
  const groupSlug = slugify(groupName);
  const groupDir = `${outputDir}/${groupSlug}`;
  const groupAttachmentsDir = `${groupDir}/attachments`;
  const manifestPath = `${groupDir}/manifest.json`;

  console.log(`\n── ${groupName} ──`);

  // Create group directory structure
  fs.mkdirSync(groupAttachmentsDir, { recursive: true });

  // Per-group state
  const messages: MessageWithId[] = [];
  const existingIds = new Set<string>();
  const existingByKey = new Map<string, MessageWithId>();
  const filenameMap = new Map<string, string>();
  const contentHashMap = new Map<string, string>();

  // Load existing messages for this group
  const existingDataPath = `${groupDir}/data.json`;
  let existingCount = 0;
  try {
    if (fs.existsSync(existingDataPath)) {
      const existing: MessageWithId[] = JSON.parse(fs.readFileSync(existingDataPath, 'utf-8'));
      for (const msg of existing) {
        const key = messageKey(msg);
        const prior = existingByKey.get(key);
        if (prior) {
          if (!prior.system && msg.system) {
            prior.system = true;
            const updatedId = hashMessage({
              date: prior.date,
              author: prior.author,
              message: prior.message,
              ...(prior.attachment !== undefined && { attachment: prior.attachment }),
              ...(prior.system && { system: true }),
            });
            if (updatedId !== prior.id) {
              existingIds.delete(prior.id);
              prior.id = updatedId;
              existingIds.add(updatedId);
            }
          }
          continue;
        }

        existingByKey.set(key, msg);
        existingIds.add(msg.id);
        messages.push(msg);
      }
      existingCount = messages.length;
      console.log(`  Loaded ${existingCount} existing messages`);
    }
  } catch (err) {
    console.error(`  Failed to load existing data.json: ${err instanceof Error ? err.message : err}`);
  }

  // Load attachment manifest (persisted hash→filename mapping)
  try {
    if (fs.existsSync(manifestPath)) {
      const manifest: AttachmentManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      for (const [hash, filename] of Object.entries(manifest.contentHashes)) {
        contentHashMap.set(hash, filename);
      }
      if (contentHashMap.size > 0) {
        console.log(`  Loaded ${contentHashMap.size} attachment hashes from manifest`);
      }
    }
  } catch (err) {
    console.error(`  Failed to load manifest.json: ${err instanceof Error ? err.message : err}`);
  }

  let zip: AdmZip;
  let entries: AdmZip.IZipEntry[];
  try {
    zip = new AdmZip(zipPath);
    entries = zip.getEntries();
  } catch (err) {
    console.error(`  Failed to open ZIP file: ${err instanceof Error ? err.message : err}`);
    failedCount++;
    continue;
  }

  const chatEntry = entries.find(e => e.entryName.endsWith('_chat.txt'));
  if (!chatEntry) {
    console.warn(`  No _chat.txt found, skipping`);
    failedCount++;
    continue;
  }

  // Extract attachments with descriptive filenames, handling collisions
  let newAttachments = 0;
  for (const entry of entries) {
    if (entry.entryName.endsWith('_chat.txt') || entry.isDirectory) {
      continue;
    }

    // Skip macOS artifacts
    if (isMacOSArtifact(entry.entryName)) {
      continue;
    }

    // Security: prevent path traversal attacks
    if (isPathTraversal(entry.entryName, groupAttachmentsDir)) {
      console.warn(`  Skipping suspicious path: ${entry.entryName}`);
      continue;
    }

    let buffer: Buffer;
    try {
      buffer = entry.getData();
    } catch (err) {
      console.warn(`  Failed to extract ${entry.entryName}: ${err instanceof Error ? err.message : err}`);
      continue;
    }

    const contentHash = crypto.createHash('sha256').update(buffer).digest('hex');
    const originalFilename = path.basename(entry.entryName);

    // Check if we've already processed identical content
    const existingFilename = contentHashMap.get(contentHash);
    if (existingFilename !== undefined) {
      filenameMap.set(originalFilename, existingFilename);
      continue;
    }

    const ext = path.extname(entry.entryName);
    const basename = path.basename(entry.entryName, ext);

    // Parse WhatsApp filename: 00000001-PHOTO-2024-01-15-12-30-45
    const match = basename.match(/^\d+-([A-Z]+)-([\d-]+)/);
    const baseName = match ? `${match[1]}-${match[2]}` : basename;

    // Find unique filename, adding suffix only on collision
    let newFilename = `${baseName}${ext}`;
    let suffix = 2;
    while (fs.existsSync(`${groupAttachmentsDir}/${newFilename}`)) {
      newFilename = `${baseName}-${suffix}${ext}`;
      suffix++;
    }

    filenameMap.set(originalFilename, newFilename);
    contentHashMap.set(contentHash, newFilename);
    fs.writeFileSync(`${groupAttachmentsDir}/${newFilename}`, buffer);
    newAttachments++;
  }
  if (newAttachments > 0) {
    console.log(`  Extracted ${newAttachments} new attachments`);
  }

  let chatContent: string;
  let parsedMessages: ReturnType<typeof parseString>;
  try {
    chatContent = chatEntry.getData().toString('utf-8');
    parsedMessages = parseString(chatContent);
  } catch (err) {
    console.error(`  Failed to parse chat content: ${err instanceof Error ? err.message : err}`);
    failedCount++;
    continue;
  }

  for (const msg of parsedMessages) {
    const cleanMessage = cleanUnicode(msg.message);
    const cleanAuthor = msg.author ? cleanUnicode(msg.author) : null;
    const attachmentMatch = cleanMessage.match(/<attached: (.+?)>/);

    const originalAttachment = attachmentMatch?.[1];
    const hashedAttachment = originalAttachment ? filenameMap.get(originalAttachment) : undefined;
    const messageText = cleanMessage.replace(/<attached: .+?>/g, '').trim();

    // Skip parsing artifacts: lines that are just "Name:" with no content
    if (isEmptyAuthorLine(cleanAuthor, messageText) && hashedAttachment === undefined) {
      continue;
    }

    const isSystem = isSystemMessage(cleanAuthor, messageText);

    const transformedMsg: Omit<MessageWithId, 'id'> = {
      date: msg.date,
      author: cleanAuthor,
      message: messageText,
      ...(hashedAttachment !== undefined && { attachment: hashedAttachment }),
      ...(isSystem && { system: true }),
    };

    const key = messageKey(transformedMsg);
    const existingMsg = existingByKey.get(key);
    if (existingMsg) {
      if (isSystem && !existingMsg.system) {
        existingMsg.system = true;
        const updatedId = hashMessage({
          date: existingMsg.date,
          author: existingMsg.author,
          message: existingMsg.message,
          ...(existingMsg.attachment !== undefined && { attachment: existingMsg.attachment }),
          ...(existingMsg.system && { system: true }),
        });
        if (updatedId !== existingMsg.id) {
          existingIds.delete(existingMsg.id);
          existingMsg.id = updatedId;
          existingIds.add(updatedId);
        }
      }
      continue;
    }

    const id = hashMessage(transformedMsg);
    if (existingIds.has(id)) {
      continue; // Skip duplicate message
    }

    existingIds.add(id);
    const newMsg = { id, ...transformedMsg };
    existingByKey.set(key, newMsg);
    messages.push(newMsg);

    // Log new message
    const dateStr = new Date(transformedMsg.date).toISOString().slice(0, 16).replace('T', ' ');
    const author = transformedMsg.author || 'System';
    const preview = transformedMsg.message.slice(0, 50) + (transformedMsg.message.length > 50 ? '...' : '');
    console.log(`    + [${dateStr}] ${author}: ${preview}`);
  }

  // Sort messages chronologically
  messages.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  const newCount = messages.length - existingCount;

  // Save data and manifest
  try {
    fs.writeFileSync(`${groupDir}/data.json`, JSON.stringify(messages, null, 2));

    // Save group metadata (display name, etc.)
    fs.writeFileSync(`${groupDir}/group-info.json`, JSON.stringify({ name: groupName }, null, 2));

    // Persist attachment hash mapping for fast subsequent runs
    const attachmentManifest: AttachmentManifest = {
      contentHashes: Object.fromEntries(contentHashMap),
    };
    fs.writeFileSync(manifestPath, JSON.stringify(attachmentManifest, null, 2));

    // Generate day-based chunks for lazy loading
    const chunksDir = `${groupDir}/chunks`;
    const { manifest: chunkManifest, latestDayMessages } = generateChunks(messages, chunksDir);
    console.log(`  Generated ${chunkManifest.chunks.length} day chunks`);

    // Generate HTML viewer with only latest chunk inline
    const lastMessage = messages[messages.length - 1];
    const lastUpdated = lastMessage ? new Date(lastMessage.date) : new Date();
    generateHtml(groupName, latestDayMessages, chunkManifest, messages.length, lastUpdated, `${groupDir}/index.html`);
    console.log(`  Generated index.html`);

    console.log(`  Result: ${existingCount} existing + ${newCount} new = ${messages.length} total`);
    processedCount++;
  } catch (err) {
    console.error(`  Failed to save output files: ${err instanceof Error ? err.message : err}`);
    failedCount++;
  }
}

// Regenerate HTML for all groups and build index
const groups: GroupInfo[] = [];
const groupDirs: {
  dir: string;
  messages: MessageWithId[];
  displayName: string;
  chunkManifest: ChunkManifest;
  latestDayMessages: MessageWithId[];
}[] = [];

try {
  const dirs = fs.readdirSync(outputDir, { withFileTypes: true });

  // First pass: collect all valid groups
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;

    const dataPath = `${outputDir}/${dir.name}/data.json`;
    if (!fs.existsSync(dataPath)) continue;

    try {
      const messages: MessageWithId[] = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
      const lastMessage = messages[messages.length - 1];

      // Read display name from group-info.json, fallback to directory name
      const groupInfoPath = `${outputDir}/${dir.name}/group-info.json`;
      let displayName = dir.name;
      if (fs.existsSync(groupInfoPath)) {
        const groupInfo = JSON.parse(fs.readFileSync(groupInfoPath, 'utf-8'));
        displayName = groupInfo.name || dir.name;
      }

      // Generate chunks once here and cache for reuse
      const chunksDir = `${outputDir}/${dir.name}/chunks`;
      const { manifest: chunkManifest, latestDayMessages } = generateChunks(messages, chunksDir);

      groups.push({
        name: displayName,
        slug: dir.name,
        messageCount: messages.length,
        lastMessageDate: lastMessage ? new Date(lastMessage.date) : undefined,
      });

      groupDirs.push({ dir: dir.name, messages, displayName, chunkManifest, latestDayMessages });
    } catch {
      // Skip groups with invalid data
    }
  }

  // Second pass: regenerate HTML now that we know total group count (reuse cached chunks)
  const showBackLink = groups.length > 1;
  for (const { dir, messages, displayName, chunkManifest, latestDayMessages } of groupDirs) {
    const lastMessage = messages[messages.length - 1];
    const lastUpdated = lastMessage ? new Date(lastMessage.date) : new Date();
    generateHtml(displayName, latestDayMessages, chunkManifest, messages.length, lastUpdated, `${outputDir}/${dir}/index.html`, showBackLink);
  }

  // Sort by last message date (most recent first)
  groups.sort((a, b) => {
    if (!a.lastMessageDate) return 1;
    if (!b.lastMessageDate) return -1;
    return b.lastMessageDate.getTime() - a.lastMessageDate.getTime();
  });

  generateIndex(groups, `${outputDir}/index.html`);
  console.log(`\nRegenerated HTML for ${groups.length} group(s)`);
} catch (err) {
  console.error(`Failed to generate root index: ${err instanceof Error ? err.message : err}`);
}

// Auto mode: create output ZIP and cleanup
if (isAutoMode && processedCount > 0) {
  const desktopPath = getDesktopPath();
  const outputZipPath = generateOutputZipPath(desktopPath);

  console.log(`\nCreating output ZIP...`);
  try {
    createOutputZip(outputDir, outputZipPath);
    console.log(`Created: ${outputZipPath}`);
  } catch (err) {
    console.error(`Failed to create output ZIP: ${err instanceof Error ? err.message : err}`);
  }
}

// Summary
if (failedCount > 0) {
  console.log(`\nCompleted with ${failedCount} failure(s)`);
}

console.log('Done!');

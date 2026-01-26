import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import AdmZip from 'adm-zip';
import { parseString } from 'whatsapp-chat-parser';

import type { MessageWithId, AttachmentManifest } from './types.js';
import {
  hashMessage,
  extractGroupName,
  isMacOSArtifact,
  isPathTraversal,
  isSystemMessage,
  isEmptyAuthorLine,
  cleanUnicode,
} from './utils.js';
import { generateHtml, generateIndex, type GroupInfo } from './html-generator.js';
import {
  discoverWhatsAppZips,
  getDownloadsPath,
  getDesktopPath,
  generateOutputZipPath,
} from './discovery.js';
import { createOutputZip, cleanupDirectory } from './zip-output.js';

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
  const groupDir = `${outputDir}/${groupName}`;
  const groupAttachmentsDir = `${groupDir}/attachments`;
  const manifestPath = `${groupDir}/manifest.json`;

  console.log(`\n── ${groupName} ──`);

  // Create group directory structure
  fs.mkdirSync(groupAttachmentsDir, { recursive: true });

  // Per-group state
  const messages: MessageWithId[] = [];
  const existingIds = new Set<string>();
  const filenameMap = new Map<string, string>();
  const contentHashMap = new Map<string, string>();

  // Load existing messages for this group
  const existingDataPath = `${groupDir}/data.json`;
  let existingCount = 0;
  try {
    if (fs.existsSync(existingDataPath)) {
      const existing: MessageWithId[] = JSON.parse(fs.readFileSync(existingDataPath, 'utf-8'));
      for (const msg of existing) {
        existingIds.add(msg.id);
        messages.push(msg);
      }
      existingCount = existing.length;
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

    const id = hashMessage(transformedMsg);
    if (existingIds.has(id)) {
      continue; // Skip duplicate message
    }

    existingIds.add(id);
    messages.push({ id, ...transformedMsg });

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

    // Persist attachment hash mapping for fast subsequent runs
    const manifest: AttachmentManifest = {
      contentHashes: Object.fromEntries(contentHashMap),
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    // Generate HTML viewer
    generateHtml(groupName, messages, `${groupDir}/index.html`);
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
try {
  const dirs = fs.readdirSync(outputDir, { withFileTypes: true });
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;

    const dataPath = `${outputDir}/${dir.name}/data.json`;
    if (!fs.existsSync(dataPath)) continue;

    try {
      const messages: MessageWithId[] = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
      const lastMessage = messages[messages.length - 1];
      groups.push({
        name: dir.name,
        messageCount: messages.length,
        lastMessageDate: lastMessage ? new Date(lastMessage.date) : undefined,
      });

      // Regenerate HTML for this group
      generateHtml(dir.name, messages, `${outputDir}/${dir.name}/index.html`);
    } catch {
      // Skip groups with invalid data
    }
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

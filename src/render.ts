import fs from 'node:fs';
import path from 'node:path';
import type { MessageWithId, ChunkManifest, ChunkInfo } from './types.js';
import { writeAtomic } from './storage.js';
import { loadGroup } from './importer.js';
import { generateHtml, generateIndex, type GroupInfo } from './html-generator.js';
import { isSystemMessage } from './utils.js';

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
export function generateChunks(
  messages: MessageWithId[],
  chunksDir: string
): { manifest: ChunkManifest; latestDayMessages: MessageWithId[] } {
  fs.mkdirSync(chunksDir, { recursive: true });

  const byDay = groupMessagesByDay(messages);
  const days = Array.from(byDay.keys()).sort(); // Oldest first

  const chunks: ChunkInfo[] = [];
  let latestDayMessages: MessageWithId[] = [];

  for (const day of days) {
    const dayMessages = byDay.get(day)!;
    if (dayMessages.length === 0) continue;

    const filename = `${day}.js`;

    // JSONP format: window.__loadChunk("2024-01-15", [...])
    const jsonpContent = `window.__loadChunk(${JSON.stringify(day)}, ${JSON.stringify(dayMessages)});`;
    writeAtomic(path.join(chunksDir, filename), jsonpContent);

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
  writeAtomic(path.join(chunksDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  return { manifest, latestDayMessages };
}

export function renderOutput(outputDir: string): void {
  const groups: GroupInfo[] = [];
  const dirs = fs.readdirSync(outputDir, { withFileTypes: true }).filter(dir => dir.isDirectory());
  for (const dir of dirs) {
    const groupDir = path.join(outputDir, dir.name);
    const { messages, name } = loadGroup(groupDir);
    const knownAuthors = [...new Set(messages.flatMap(msg => msg.author === null ? [] : [msg.author]))];
    // Reclassify display copies so old false-positive flags do not survive a
    // rebuild. Canonical records and historical snapshots remain untouched.
    const displayMessages = messages.map(({ system, ...msg }) => ({
      ...msg,
      ...(isSystemMessage(msg.author, msg.message, knownAuthors) && { system: true as const }),
    }));
    const { manifest, latestDayMessages } = generateChunks(displayMessages, path.join(groupDir, 'chunks'));
    const lastMessage = messages[messages.length - 1];
    const lastUpdated = lastMessage ? new Date(lastMessage.date) : new Date();
    generateHtml(name, latestDayMessages, manifest, messages.length, lastUpdated, path.join(groupDir, 'index.html'), dirs.length > 1);
    groups.push({ name, slug: dir.name, messageCount: messages.length, lastMessageDate: lastMessage ? lastUpdated : undefined });
  }
  groups.sort((a, b) => (b.lastMessageDate?.getTime() ?? 0) - (a.lastMessageDate?.getTime() ?? 0));
  generateIndex(groups, path.join(outputDir, 'index.html'));
  console.log(`Generated viewers for ${groups.length} group(s).`);
}

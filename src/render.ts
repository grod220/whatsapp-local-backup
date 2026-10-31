import fs from 'node:fs';
import path from 'node:path';
import type { MessageWithId, ChunkManifest, ChunkInfo } from './types.js';
import { sha256, writeAtomic } from './storage.js';
import { loadGroup } from './importer.js';
import { generateHtml, generateIndex, type GroupInfo } from './html-generator.js';
import { isSystemMessage } from './utils.js';
import { allObservations, reconcileMessages, validateReconciliation } from './reconciliation.js';
import { generateProvenance } from './provenance.js';
import { DISPLAY_TIME_ZONE, VIEW_VERSION } from './settings.js';
import { generateBackupClientPages } from './backup-client.js';
import { findAlbums, type ReaderAssets } from './albums.js';
import { videoPreviews } from './media-previews.js';

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
    const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: DISPLAY_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);

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
  chunksDir: string,
  assets: ReaderAssets = {},
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
    ...assets,
    totalMessages: messages.length,
    timeZone: DISPLAY_TIME_ZONE,
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
    const { messages, manifest: attachments, name, evidence, decisions, reconciliation: previous } = loadGroup(groupDir);
    const knownAuthors = [...new Set(messages.flatMap(msg => msg.author === null ? [] : [msg.author]))];
    // Reclassify display copies so old false-positive flags do not survive a
    // rebuild. Canonical records and historical snapshots remain untouched.
    const observations = allObservations(messages, evidence);
    const reconciled = reconcileMessages(messages, attachments, evidence, decisions, previous);
    const revision = sha256(JSON.stringify([VIEW_VERSION, reconciled.algorithm, reconciled.inputHash]));
    validateReconciliation(reconciled, observations);
    writeAtomic(path.join(groupDir, 'reconciliation.json'), JSON.stringify(reconciled, null, 2));
    const displayMessages = reconciled.posts.filter(post => post.category === 'post');
    const rawMessages = observations.map(({ system, ...msg }) => ({
      ...msg,
      ...(isSystemMessage(msg.author, msg.message, knownAuthors) && { system: true as const }),
    }));
    const previews = videoPreviews(groupDir, displayMessages, attachments);
    const { manifest, latestDayMessages } = generateChunks(displayMessages, path.join(groupDir, 'chunks'),
      { albums: findAlbums(reconciled.posts, DISPLAY_TIME_ZONE), previews });
    const lastMessage = messages[messages.length - 1];
    const lastUpdated = lastMessage ? new Date(lastMessage.date) : new Date();
    generateHtml(name, latestDayMessages, manifest, displayMessages.length, lastUpdated, path.join(groupDir, 'index.html'), dirs.length > 1,
      { mode: 'reading', rawCount: observations.length, revision });
    for (const [mode, filename, records] of [
      ['records', 'records.html', rawMessages],
      ['activity', 'activity.html', reconciled.posts.filter(post => post.category !== 'post')],
      ['unresolved', 'unresolved.html', reconciled.posts.filter(post => post.unresolvedMedia)],
    ] as const) {
      const base = `${mode}-chunks/`;
      const chunks = generateChunks([...records].sort((a, b) => +new Date(a.date) - +new Date(b.date)), path.join(groupDir, base), { previews });
      chunks.manifest.chunkBase = base;
      generateHtml(name, chunks.latestDayMessages, chunks.manifest, records.length, lastUpdated, path.join(groupDir, filename), dirs.length > 1,
        { mode, rawCount: observations.length, revision });
    }
    generateProvenance(groupDir, name, reconciled, observations);
    console.log(`${name}: ${displayMessages.length} posts, ${observations.length} preserved observations, ${reconciled.posts.filter(p => p.unresolvedMedia).length} unresolved media entries.`);
    groups.push({ name, slug: dir.name, messageCount: displayMessages.length, lastMessageDate: lastMessage ? lastUpdated : undefined });
  }
  groups.sort((a, b) => (b.lastMessageDate?.getTime() ?? 0) - (a.lastMessageDate?.getTime() ?? 0));
  generateIndex(groups, path.join(outputDir, 'index.html'));
  generateBackupClientPages(outputDir);
  console.log(`Generated viewers for ${groups.length} group(s).`);
}

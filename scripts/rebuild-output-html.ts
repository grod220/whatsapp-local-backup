import fs from 'node:fs';
import path from 'node:path';
import { generateHtml, generateIndex } from '../src/html-generator.js';
import type { MessageWithId, ChunkManifest } from '../src/types.js';

interface GroupInfoFile {
  name?: string;
  lastUpdated?: string;
}

function groupMessagesByDay(messages: MessageWithId[]): Map<string, MessageWithId[]> {
  const byDay = new Map<string, MessageWithId[]>();

  for (const msg of messages) {
    const date = new Date(msg.date);
    if (Number.isNaN(date.getTime())) continue;

    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const dayKey = `${year}-${month}-${day}`;

    if (!byDay.has(dayKey)) {
      byDay.set(dayKey, []);
    }
    byDay.get(dayKey)!.push(msg);
  }

  return byDay;
}

function getLatestDayMessages(messages: MessageWithId[]): MessageWithId[] {
  const byDay = groupMessagesByDay(messages);
  const days = Array.from(byDay.keys()).sort();
  const latestDay = days[days.length - 1];
  return latestDay ? byDay.get(latestDay)! : [];
}

function rebuildOutputHtml(outputDir: string): void {
  if (!fs.existsSync(outputDir)) {
    throw new Error(`Output directory not found: ${outputDir}`);
  }

  const allDirs = fs.readdirSync(outputDir, { withFileTypes: true }).filter(entry => entry.isDirectory());
  const validGroupDirs = allDirs.filter(entry => {
    const base = path.join(outputDir, entry.name);
    return fs.existsSync(path.join(base, 'data.json'))
      && fs.existsSync(path.join(base, 'group-info.json'))
      && fs.existsSync(path.join(base, 'chunks', 'manifest.json'));
  });

  const groups: Array<{
    name: string;
    slug: string;
    messageCount: number;
    lastMessageDate: Date | undefined;
  }> = [];

  for (const entry of validGroupDirs) {
    const slug = entry.name;
    const groupDir = path.join(outputDir, slug);
    const messages = JSON.parse(
      fs.readFileSync(path.join(groupDir, 'data.json'), 'utf-8')
    ) as MessageWithId[];
    const groupInfo = JSON.parse(
      fs.readFileSync(path.join(groupDir, 'group-info.json'), 'utf-8')
    ) as GroupInfoFile;
    const manifest = JSON.parse(
      fs.readFileSync(path.join(groupDir, 'chunks', 'manifest.json'), 'utf-8')
    ) as ChunkManifest;

    const latestDayMessages = getLatestDayMessages(messages);
    const groupName = groupInfo.name ?? slug;
    const lastUpdated = groupInfo.lastUpdated
      ? new Date(groupInfo.lastUpdated)
      : (messages.length > 0 ? new Date(messages[messages.length - 1]!.date) : new Date());

    generateHtml(
      groupName,
      latestDayMessages,
      manifest,
      messages.length,
      lastUpdated,
      path.join(groupDir, 'index.html'),
      validGroupDirs.length > 1
    );

    groups.push({
      name: groupName,
      slug,
      messageCount: messages.length,
      lastMessageDate: messages.length > 0 ? new Date(messages[messages.length - 1]!.date) : undefined,
    });
  }

  groups.sort((a, b) => {
    const aTime = a.lastMessageDate?.getTime() ?? 0;
    const bTime = b.lastMessageDate?.getTime() ?? 0;
    return bTime - aTime;
  });

  generateIndex(groups, path.join(outputDir, 'index.html'));
  console.log(`Rebuilt HTML for ${groups.length} group(s) in ${outputDir}`);
}

rebuildOutputHtml(path.resolve(process.cwd(), 'output'));

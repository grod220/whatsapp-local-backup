import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { extractGroupName } from './utils.js';

const WHATSAPP_ZIP_PATTERN = /^WhatsApp Chat - .+\.zip$/;

export function getDownloadsPath(): string {
  return path.join(os.homedir(), 'Downloads');
}

export function getDesktopPath(): string {
  return path.join(os.homedir(), 'Desktop');
}

export function discoverWhatsAppZips(directory: string): string[] {
  if (!fs.existsSync(directory)) {
    return [];
  }

  const entries = fs.readdirSync(directory, { withFileTypes: true });

  // Collect all matching ZIPs with their metadata
  const zipInfos: { path: string; groupName: string; mtime: number }[] = [];
  for (const entry of entries) {
    if (entry.isFile() && WHATSAPP_ZIP_PATTERN.test(entry.name)) {
      const fullPath = path.join(directory, entry.name);
      const stat = fs.statSync(fullPath);
      zipInfos.push({
        path: fullPath,
        groupName: extractGroupName(entry.name),
        mtime: stat.mtimeMs,
      });
    }
  }

  // Deduplicate by group name, keeping the newest (highest mtime)
  const newestByGroup = new Map<string, { path: string; mtime: number }>();
  for (const info of zipInfos) {
    const existing = newestByGroup.get(info.groupName);
    if (!existing || info.mtime > existing.mtime) {
      newestByGroup.set(info.groupName, { path: info.path, mtime: info.mtime });
    }
  }

  // Return deduplicated paths, sorted for consistent ordering
  return Array.from(newestByGroup.values())
    .map(v => v.path)
    .sort();
}

export function generateOutputZipPath(desktopPath: string): string {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const baseName = `whatsapp-backup-${date}`;

  let outputPath = path.join(desktopPath, `${baseName}.zip`);
  let suffix = 2;

  while (fs.existsSync(outputPath)) {
    outputPath = path.join(desktopPath, `${baseName}-${suffix}.zip`);
    suffix++;
  }

  return outputPath;
}

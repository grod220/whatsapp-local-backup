import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const WHATSAPP_ZIP_PATTERN = /^WhatsApp Chat (?:with |[-–] ).+\.zip$/i;

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

  // Every export may contain history/media missing from a newer phone's export.
  return entries
    .filter(entry => entry.isFile() && WHATSAPP_ZIP_PATTERN.test(entry.name))
    .map(entry => ({ filename: path.join(directory, entry.name), mtime: fs.statSync(path.join(directory, entry.name)).mtimeMs }))
    .sort((a, b) => a.mtime - b.mtime || a.filename.localeCompare(b.filename))
    .map(entry => entry.filename);
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

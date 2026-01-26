import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';

export function createOutputZip(sourceDir: string, outputPath: string): void {
  const zip = new AdmZip();
  addDirectoryToZip(zip, sourceDir, '');
  zip.writeZip(outputPath);
}

function addDirectoryToZip(zip: AdmZip, dirPath: string, zipPath: string): void {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    const entryZipPath = zipPath ? `${zipPath}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      addDirectoryToZip(zip, fullPath, entryZipPath);
    } else {
      zip.addLocalFile(fullPath, zipPath || undefined);
    }
  }
}

export function cleanupDirectory(dirPath: string): void {
  if (fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
}

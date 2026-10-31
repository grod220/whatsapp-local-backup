import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { sha256 } from './storage.js';

export function listFiles(directory: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.DS_Store' || /\.[a-f0-9-]{36}\.tmp$/.test(entry.name)) continue;
      const filename = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(filename);
      else if (entry.isFile()) files.push(path.relative(directory, filename));
      else throw new Error(`Unexpected non-regular file: ${filename}`);
    }
  };
  walk(directory);
  return files.sort();
}

export function inventoryDigest(files: Array<{ name: string; filename: string }>): string {
  const hash = crypto.createHash('sha256');
  for (const file of files.sort((a, b) => a.name.localeCompare(b.name))) {
    hash.update(file.name); hash.update('\0');
    hash.update(sha256(fs.readFileSync(file.filename))); hash.update('\0');
  }
  return hash.digest('hex');
}

import fs from 'node:fs';
import path from 'node:path';
import { DriveBackupStore } from '../src/backup-store.js';
import { parseDriveConfig } from '../src/drive-backup.js';
import { recoverDriveZip } from '../src/zip-backup.js';

try {
  const [destination, ...rest] = process.argv.slice(2);
  if (!destination || rest.length) throw new Error('Usage: npm run recover-drive -- NEW_DIRECTORY');
  const config = JSON.parse(fs.readFileSync('clemcast.config.json', 'utf8'));
  recoverDriveZip(new DriveBackupStore(parseDriveConfig(config.driveBackup)), path.resolve(destination));
} catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }

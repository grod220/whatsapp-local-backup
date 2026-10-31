import fs from 'node:fs';
import { DriveBackupStore } from '../src/backup-store.js';
import { parseDriveConfig } from '../src/drive-backup.js';
import { backupHistory } from '../src/incremental.js';

try {
  const config = JSON.parse(fs.readFileSync('clemcast.config.json', 'utf8'));
  console.log(JSON.stringify(backupHistory(new DriveBackupStore(parseDriveConfig(config.driveBackup))), null, 2));
} catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }

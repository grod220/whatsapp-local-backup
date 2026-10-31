import fs from 'node:fs';
import path from 'node:path';
import { DriveBackupStore } from '../src/backup-store.js';
import { parseDriveConfig } from '../src/drive-backup.js';
import { recoverIncrementalBackup } from '../src/incremental.js';

try {
  const [destination, flag, snapshot] = process.argv.slice(2);
  if (!destination || (flag && (flag !== '--snapshot' || !snapshot))) throw new Error('Usage: npm run recover-drive -- NEW_DIRECTORY [--snapshot DATED_SNAPSHOT_NAME]');
  const config = JSON.parse(fs.readFileSync('clemcast.config.json', 'utf8'));
  const result = recoverIncrementalBackup(new DriveBackupStore(parseDriveConfig(config.driveBackup)), path.resolve(destination), snapshot);
  console.log(`Verified and recovered ${result.kind} snapshot from ${result.createdAt} into ${path.resolve(destination)}`);
} catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }

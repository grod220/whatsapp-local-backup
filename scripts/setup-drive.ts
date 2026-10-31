import fs from 'node:fs';
import { connectDrive, parseDriveConfig } from '../src/drive-backup.js';

try {
  const config = JSON.parse(fs.readFileSync('clemcast.config.json', 'utf8'));
  if (process.argv.length > 3) throw new Error('Usage: npm run setup-drive -- [/path/to/desktop-client.json]');
  connectDrive(parseDriveConfig(config.driveBackup), process.argv[2]);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

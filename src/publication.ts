import fs from 'node:fs';
import path from 'node:path';
import { prepareIncrementalBackup, publishIncrementalBackup } from './incremental.js';
import { DriveBackupStore, type BackupStore } from './backup-store.js';
import { parseDriveConfig } from './drive-backup.js';
import { createRecoveryZip, verifyPortableBackup } from './zip-output.js';
import { deployOutput } from './deploy.js';
import { writeAtomic } from './storage.js';

/** Caller holds the archive lock through import, verification, promotion and publication. */
export function backupAndPublish(workspace: string, driveConfig: unknown, options: {
  localOnly?: boolean; fullZipPath?: string; timeZone?: string;
  store?: BackupStore; deploy?: (workspace: string) => void;
} = {}): void {
  const checkpoint = prepareIncrementalBackup(workspace);
  if (options.fullZipPath) {
    const destination = path.resolve(options.fullZipPath), output = path.join(workspace, 'output'), archive = path.join(workspace, 'archive');
    if (fs.existsSync(destination)) { verifyPortableBackup(destination, output, archive); console.log(`Reusing verified recovery backup: ${destination}`); }
    else createRecoveryZip(output, destination, archive);
  }
  if (options.localOnly) { console.log('Local incremental backup complete. Upload and website update skipped (--local-only).'); return; }
  try {
    const config = parseDriveConfig(driveConfig);
    const result = publishIncrementalBackup(checkpoint, options.store ?? new DriveBackupStore(config), options.timeZone);
    (options.deploy ?? deployOutput)(workspace);
    writeAtomic(path.join(workspace, '.incremental-backup', 'last-run.json'), JSON.stringify({ ...result,
      folderId: config.folderId, verifiedAt: new Date().toISOString(), published: true }, null, 2));
    console.log(`Done: incremental Drive backup verified and website up to date.\nDrive folder: https://drive.google.com/drive/folders/${config.folderId}`);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : error}\nLocal incremental checkpoint is safe: ${checkpoint.directory}\nRun npm run parse again to retry.`, { cause: error });
  }
}

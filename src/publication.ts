import fs from 'node:fs';
import path from 'node:path';
import { prepareZipBackup, publishZipBackup } from './zip-backup.js';
import { DriveBackupStore, type BackupStore } from './backup-store.js';
import { parseDriveConfig } from './drive-backup.js';
import { deployOutput } from './deploy.js';
import { writeAtomic } from './storage.js';
import { verifyPortableBackup } from './zip-output.js';

/** Caller holds the archive lock through import, verification, replacement and publication. */
export function backupAndPublish(workspace: string, driveConfig: unknown, options: {
  localOnly?: boolean; fullZipPath?: string; timeZone?: string;
  store?: BackupStore; deploy?: (workspace: string) => void;
} = {}): void {
  const checkpoint = prepareZipBackup(workspace);
  try {
    if (options.localOnly) {
      if (options.fullZipPath) copyZip(checkpoint.filename, options.fullZipPath, workspace);
      console.log('Local recovery ZIP complete. Upload and website update skipped (--local-only).'); return;
    }
    const config = parseDriveConfig(driveConfig);
    const result = publishZipBackup(workspace, checkpoint, options.store ?? new DriveBackupStore(config), options.timeZone);
    if (options.fullZipPath) copyZip(result.localZip, options.fullZipPath, workspace);
    (options.deploy ?? deployOutput)(workspace);
    writeAtomic(path.join(workspace, 'backups/automatic/publication.json'), JSON.stringify({ ...result,
      folderId: config.folderId, verifiedAt: new Date().toISOString(), published: true }, null, 2));
    console.log(`Done: Drive recovery ZIP verified and website up to date.\nDrive folder: https://drive.google.com/drive/folders/${config.folderId}`);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : error}\nLocal recovery ZIP is safe in: ${path.dirname(checkpoint.filename)}\nRun npm run parse again to retry.`, { cause: error });
  }
}
function copyZip(source: string, destination: string, workspace: string): void {
  const target = path.resolve(destination);
  if (fs.existsSync(target)) {
    verifyPortableBackup(target, path.join(workspace, 'output'), path.join(workspace, 'archive'));
    console.log(`Reusing verified recovery backup: ${target}`); return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  console.log(`Saved extra recovery ZIP: ${target}`);
}

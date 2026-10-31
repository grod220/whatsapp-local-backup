import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export interface DriveBackupConfig { remote: string; folderId: string }
export type RcloneRunner = (args: string[], progress?: boolean) => string;

export function parseDriveConfig(value: unknown): DriveBackupConfig {
  const config = value as Partial<DriveBackupConfig> | null;
  if (!config || typeof config.remote !== 'string' || !/^[a-zA-Z][\w-]*$/.test(config.remote)
    || typeof config.folderId !== 'string' || !/^[\w-]+$/.test(config.folderId)) {
    throw new Error('Configure driveBackup.remote and driveBackup.folderId in clemcast.config.json, then run npm run setup-drive.');
  }
  return { remote: config.remote, folderId: config.folderId };
}

// OAuth credentials stay outside the repository and recovery packages.
export function driveCredentialsPath(): string {
  return path.join(os.homedir(), '.config', 'clemcast', 'rclone.conf');
}

export const runRclone: RcloneRunner = (args, progress = false) => {
  const result = spawnSync('rclone', args, {
    encoding: 'utf8', stdio: progress ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'],
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('Install rclone (on macOS: brew install rclone), then run npm run setup-drive.');
    throw result.error;
  }
  if (result.status !== 0) throw new Error(`Google Drive command failed (exit ${result.status}). ${result.stderr?.trim() ?? ''} Run npm run setup-drive if login is required.`);
  return result.stdout ?? '';
};

function flags(config: DriveBackupConfig, credentials: string): string[] {
  return ['--config', credentials, '--drive-root-folder-id', config.folderId,
    '--retries', '3', '--low-level-retries', '5', '--contimeout', '30s', '--timeout', '5m'];
}

export function checkDriveConnection(config: DriveBackupConfig, run = runRclone, credentials = driveCredentialsPath()): void {
  const root = JSON.parse(run(['lsjson', `${config.remote}:`, '--stat', ...flags(config, credentials)]));
  // rclone synthesizes root stat entries without an ID. Every operation forces
  // the exact folder ID through --drive-root-folder-id, including this listing.
  if (root.IsDir !== true || (root.ID !== undefined && root.ID !== config.folderId)) throw new Error('Drive backup destination does not match the configured Clemcast folder. Website publication stopped.');
}

/** Copy a single immutable ZIP, then read its bytes back from Drive and hash them. */
export function uploadRecoveryBackup(filename: string, sha256: string, config: DriveBackupConfig, run = runRclone): string {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Invalid backup SHA-256');
  checkDriveConnection(config, run);
  const remotePath = `${config.remote}:clemcast-recovery-${sha256}.zip`;
  const args = flags(config, driveCredentialsPath());
  console.log('Copying the complete recovery ZIP to Google Drive...');
  run(['copyto', filename, remotePath, '--immutable', '--checksum', '--stats', '10s', ...args], true);
  const remote = JSON.parse(run(['lsjson', remotePath, '--stat', '--hash', ...args]));
  if (remote.IsDir || remote.Size !== fs.statSync(filename).size || typeof remote.ID !== 'string') throw new Error('Drive backup size or file identity could not be verified. Website publication stopped.');
  console.log('Reading the Drive backup back to verify every byte...');
  const lines = run(['hashsum', 'sha256', remotePath, '--download', ...args]).trim().split(/\r?\n/);
  if (lines.length !== 1 || lines[0]!.split(/\s+/)[0] !== sha256) throw new Error('Drive download checksum does not match the local recovery ZIP. Website publication stopped.');
  console.log(`Google Drive backup verified: ${remote.ID}`);
  return remote.ID;
}

/** Replace working credentials only after the new browser login is validated. */
export function connectDrive(config: DriveBackupConfig, clientFile = path.join(path.dirname(driveCredentialsPath()), 'oauth-client.json')): void {
  if (!fs.existsSync(clientFile)) throw new Error('A dedicated Google Desktop OAuth client is required. Download its JSON from Google Cloud, then run npm run setup-drive -- /path/to/client.json. See README.md.');
  const clientBytes = fs.readFileSync(clientFile);
  const client = JSON.parse(clientBytes.toString('utf8')).installed;
  if (!client || typeof client.client_id !== 'string' || !client.client_id.endsWith('.apps.googleusercontent.com')
    || typeof client.client_secret !== 'string' || !client.client_secret) throw new Error('Expected a Google Desktop app OAuth client JSON.');
  const destination = driveCredentialsPath();
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = fs.mkdtempSync(path.join(path.dirname(destination), '.connect-'));
  const credentials = path.join(temporary, 'rclone.conf');
  try {
    console.log('Sign in to Google in the browser and approve Clemcast for Drive backups.');
    runRclone(['config', 'create', config.remote, 'drive', 'scope', 'drive', 'root_folder_id', config.folderId,
      'client_id', client.client_id, 'client_secret', client.client_secret,
      'config_is_local', 'true', 'config_change_team_drive', 'false', '--config', credentials, '--no-output'], true);
    checkDriveConnection(config, runRclone, credentials);
    fs.chmodSync(credentials, 0o600);
    fs.renameSync(credentials, destination);
    fs.writeFileSync(path.join(path.dirname(destination), 'oauth-client.json'), clientBytes, { mode: 0o600 });
    console.log('Google Drive connected. Future backups need only npm run parse.');
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inventoryDigest, listFiles } from './file-inventory.js';
import { createRecoveryZip, RECOVERY_TOOLING_PATHS, verifyPortableBackup } from './zip-output.js';
import { generateOutputZipPath, getDesktopPath } from './discovery.js';
import { writeAtomic } from './storage.js';
import { parseDriveConfig, uploadRecoveryBackup, type DriveBackupConfig } from './drive-backup.js';
import { deployOutput } from './deploy.js';

interface PublicationState {
  version: 1;
  fingerprint: string;
  backupPath: string;
  sha256: string;
  drive?: { fileId: string; folderId: string; verifiedAt: string };
  publishedAt?: string;
}

/** Include archive, reader, originals and exact tooling, so retries cannot reuse a stale backup. */
function backupFingerprint(workspace: string): string {
  const files = new Map<string, string>();
  const add = (base: string, relative: string) => {
    const filename = path.join(base, relative);
    if (!fs.existsSync(filename)) return;
    if (fs.lstatSync(filename).isDirectory()) {
      for (const child of listFiles(filename)) files.set(`${relative}/${child}`, path.join(filename, child));
    } else files.set(relative, filename);
  };
  for (const dir of ['output', 'archive', 'sources']) add(workspace, dir);
  const project = fileURLToPath(new URL('..', import.meta.url));
  for (const relative of RECOVERY_TOOLING_PATHS) add(project, relative);
  // Recovery packages use the importing workspace's settings when supplied.
  add(workspace, 'clemcast.config.json');
  return inventoryDigest([...files].map(([name, filename]) => ({ name, filename })));
}

function statePath(workspace: string): string { return path.join(workspace, '.publish-state.json'); }

function readState(workspace: string): PublicationState | undefined {
  const filename = statePath(workspace);
  if (!fs.existsSync(filename)) return;
  const state = JSON.parse(fs.readFileSync(filename, 'utf8')) as PublicationState;
  if (state.version !== 1 || !/^[a-f0-9]{64}$/.test(state.fingerprint) || !/^[a-f0-9]{64}$/.test(state.sha256)
    || typeof state.backupPath !== 'string' || !path.isAbsolute(state.backupPath)) {
    throw new Error('Invalid .publish-state.json. Keep its backup and rename the state file before retrying.');
  }
  return state;
}

export function prepareRecoveryBackup(workspace: string, requestedPath?: string, desktop = getDesktopPath()): PublicationState {
  const fingerprint = backupFingerprint(workspace);
  const previous = readState(workspace);
  if (previous?.fingerprint === fingerprint && fs.existsSync(previous.backupPath)
    && (!requestedPath || path.resolve(requestedPath) === previous.backupPath)) {
    const verified = verifyPortableBackup(previous.backupPath, path.join(workspace, 'output'), path.join(workspace, 'archive'));
    if (verified.sha256 !== previous.sha256) throw new Error('The saved recovery ZIP changed. Recover it before retrying.');
    console.log(`Reusing verified recovery backup: ${previous.backupPath}`);
    return previous;
  }
  const backupPath = requestedPath ? path.resolve(requestedPath) : generateOutputZipPath(desktop);
  createRecoveryZip(path.join(workspace, 'output'), backupPath, path.join(workspace, 'archive'));
  const verified = verifyPortableBackup(backupPath, path.join(workspace, 'output'), path.join(workspace, 'archive'));
  const state: PublicationState = { version: 1, fingerprint, backupPath, sha256: verified.sha256 };
  writeAtomic(statePath(workspace), JSON.stringify(state, null, 2));
  console.log(`Verified complete recovery backup: ${backupPath}`);
  return state;
}

export function finishPublication(workspace: string, state: PublicationState, driveConfig: unknown, actions: {
  upload?: (filename: string, hash: string, config: DriveBackupConfig) => string;
  deploy?: (workspace: string) => void;
} = {}): void {
  try {
    const config = parseDriveConfig(driveConfig);
    const fileId = (actions.upload ?? uploadRecoveryBackup)(state.backupPath, state.sha256, config);
    state.drive = { fileId, folderId: config.folderId, verifiedAt: new Date().toISOString() };
    writeAtomic(statePath(workspace), JSON.stringify(state, null, 2));
    (actions.deploy ?? deployOutput)(workspace);
    state.publishedAt = new Date().toISOString();
    writeAtomic(statePath(workspace), JSON.stringify(state, null, 2));
    console.log(`Done: archive saved, Google Drive backup verified, and website up to date.\nLocal backup: ${state.backupPath}`);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : error}\nLocal recovery backup is safe: ${state.backupPath}\nRun npm run parse again to retry.`, { cause: error });
  }
}

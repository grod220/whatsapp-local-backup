import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import AdmZip from 'adm-zip';
import { captureSnapshot } from '../src/archive.js';
import { importBackup, loadGroup } from '../src/importer.js';
import { renderOutput } from '../src/render.js';
import { finishPublication, prepareRecoveryBackup } from '../src/publication.js';
import { checkDriveConnection, uploadRecoveryBackup, type RcloneRunner } from '../src/drive-backup.js';
import { sha256 } from '../src/storage.js';
import { deployOutput } from '../src/deploy.js';

const drive = { remote: 'clemcast', folderId: 'the-existing-clemcast-folder' };

function fixture(t: { after: (f: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clemcast-publication-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const original = path.join(dir, 'WhatsApp Chat - Family.zip');
  const zip = new AdmZip();
  zip.addFile('_chat.txt', Buffer.from('[20/01/2026, 12:00:00] Alex: A family update'));
  zip.writeZip(original);
  const output = path.join(dir, 'output'), archive = path.join(dir, 'archive');
  importBackup(original, output, archive, { timeZone: 'Europe/Rome', daysFirst: true });
  renderOutput(output); captureSnapshot(output, archive);
  return { dir, original, output, archive };
}

test('failed uploads preserve the recovery ZIP and block publishing; retries reuse that exact ZIP', t => {
  const f = fixture(t), backup = prepareRecoveryBackup(f.dir, undefined, f.dir);
  const bytes = fs.readFileSync(backup.backupPath), history = fs.readFileSync(path.join(f.output, 'family/evidence.json'));
  const calls: string[] = [];
  assert.throws(() => finishPublication(f.dir, backup, drive, {
    upload: () => { calls.push('upload'); throw new Error('Network interrupted'); },
    deploy: () => calls.push('deploy'),
  }), /Network interrupted[\s\S]*Local recovery backup is safe/);
  assert.deepEqual(calls, ['upload']);
  const retry = prepareRecoveryBackup(f.dir, undefined, f.dir);
  assert.equal(retry.backupPath, backup.backupPath);
  finishPublication(f.dir, retry, drive, {
    upload: (filename, hash) => { assert.equal(filename, backup.backupPath); assert.equal(hash, sha256(bytes)); calls.push('verified upload'); return 'file-id'; },
    deploy: () => calls.push('deploy'),
  });
  assert.deepEqual(calls, ['upload', 'verified upload', 'deploy']);
  assert.deepEqual(fs.readFileSync(backup.backupPath), bytes);
  assert.deepEqual(fs.readFileSync(path.join(f.output, 'family/evidence.json')), history);
  const receipt = JSON.parse(fs.readFileSync(path.join(f.dir, '.publish-state.json'), 'utf8'));
  assert.equal(receipt.drive.fileId, 'file-id');
  assert.ok(receipt.publishedAt);
  assert.equal(fs.readdirSync(f.dir).filter(name => name.startsWith('whatsapp-backup-')).length, 1);
});

test('deployment failures retain the verified Drive receipt and remain retryable', t => {
  const f = fixture(t), backup = prepareRecoveryBackup(f.dir, undefined, f.dir);
  assert.throws(() => finishPublication(f.dir, backup, drive, {
    upload: () => 'verified-file', deploy: () => { throw new Error('Cloudflare unavailable'); },
  }), /Cloudflare unavailable/);
  const state = JSON.parse(fs.readFileSync(path.join(f.dir, '.publish-state.json'), 'utf8'));
  assert.equal(state.drive.fileId, 'verified-file');
  assert.equal(state.publishedAt, undefined);
  assert.equal(prepareRecoveryBackup(f.dir, undefined, f.dir).backupPath, backup.backupPath);
});

test('website deployment records success only after publishing and detects project changes', t => {
  const f = fixture(t), cache = path.join(f.dir, '.deploy-hash');
  assert.throws(() => deployOutput(f.dir, () => { throw new Error('Cloudflare offline'); }), /Cloudflare offline/);
  assert.ok(!fs.existsSync(cache));
  let calls = 0;
  const publish = () => { calls++; };
  deployOutput(f.dir, publish); deployOutput(f.dir, publish);
  assert.equal(calls, 1);
  const previousProject = process.env.DEPLOY_PROJECT;
  try {
    process.env.DEPLOY_PROJECT = 'another-clemcast-project';
    deployOutput(f.dir, publish);
    assert.equal(calls, 2, 'a hash recorded for another project cannot skip publishing');
  } finally {
    if (previousProject === undefined) delete process.env.DEPLOY_PROJECT;
    else process.env.DEPLOY_PROJECT = previousProject;
  }
  fs.writeFileSync(path.join(f.output, 'family/index.html'), 'an interrupted rebuild');
  assert.throws(() => deployOutput(f.dir, publish), /Incomplete viewer rebuild/);
  assert.equal(calls, 2);
});

test('changed archive/configuration creates a new backup and leaves older backup bytes intact', t => {
  const f = fixture(t), first = prepareRecoveryBackup(f.dir, undefined, f.dir);
  const bytes = fs.readFileSync(first.backupPath);
  fs.writeFileSync(path.join(f.dir, 'clemcast.config.json'), JSON.stringify({ timeZone: 'Europe/Rome', driveBackup: drive }));
  const second = prepareRecoveryBackup(f.dir, undefined, f.dir);
  assert.notEqual(second.backupPath, first.backupPath);
  assert.deepEqual(fs.readFileSync(first.backupPath), bytes);
  assert.deepEqual(JSON.parse(new AdmZip(second.backupPath).readAsText('clemcast.config.json')).driveBackup, drive);
});

test('damaged saved backups are refused without overwriting them or publishing', t => {
  const f = fixture(t), first = prepareRecoveryBackup(f.dir, undefined, f.dir);
  fs.writeFileSync(first.backupPath, 'damaged backup');
  assert.throws(() => prepareRecoveryBackup(f.dir, undefined, f.dir));
  assert.equal(fs.readFileSync(first.backupPath, 'utf8'), 'damaged backup');
});

function fakeDrive(filename: string, overrides: { folder?: string; size?: number; hash?: string; failCopy?: boolean } = {}) {
  const calls: string[][] = [], hash = sha256(fs.readFileSync(filename));
  const run: RcloneRunner = args => {
    calls.push(args);
    if (args[0] === 'lsjson' && args[1] === `${drive.remote}:`) return JSON.stringify({ IsDir: true, ID: overrides.folder ?? drive.folderId });
    if (args[0] === 'copyto') { if (overrides.failCopy) throw new Error('Transfer interrupted'); return ''; }
    if (args[0] === 'lsjson') return JSON.stringify({ IsDir: false, ID: 'drive-file-id', Size: overrides.size ?? fs.statSync(filename).size });
    if (args[0] === 'hashsum') return `${overrides.hash ?? hash}  backup.zip\n`;
    throw new Error(`Unexpected command: ${args[0]}`);
  };
  return { run, calls, hash };
}

test('Drive transfer is confined to the verified folder, immutable, and verified by downloading its bytes', t => {
  const f = fixture(t), fake = fakeDrive(f.original);
  assert.equal(uploadRecoveryBackup(f.original, fake.hash, drive, fake.run), 'drive-file-id');
  assert.deepEqual(fake.calls.map(c => c[0]), ['lsjson', 'copyto', 'lsjson', 'hashsum']);
  assert.ok(fake.calls[1]!.includes('--immutable'));
  assert.ok(fake.calls[1]!.includes('--checksum'));
  assert.ok(fake.calls[3]!.includes('--download'));
  for (const call of fake.calls) assert.equal(call[call.indexOf('--drive-root-folder-id') + 1], drive.folderId);
  assert.equal(fake.calls[1]![2], `clemcast:clemcast-recovery-${fake.hash}.zip`);
});

test('rclone synthetic root stats omit IDs; the exact destination is still passed on every command', () => {
  checkDriveConnection(drive, args => {
    assert.equal(args[args.indexOf('--drive-root-folder-id') + 1], drive.folderId);
    return JSON.stringify({ Name: '', Path: '', IsDir: true, Size: -1 });
  });
});

test('wrong Drive folders, failed transfers, wrong sizes and damaged remote bytes stop publication', t => {
  const f = fixture(t);
  for (const overrides of [{ folder: 'wrong-folder' }, { failCopy: true }, { size: 1 }, { hash: 'f'.repeat(64) }]) {
    const fake = fakeDrive(f.original, overrides);
    assert.throws(() => uploadRecoveryBackup(f.original, fake.hash, drive, fake.run));
    if ('folder' in overrides) assert.equal(fake.calls.length, 1, 'wrong destination is rejected before any upload');
    if ('failCopy' in overrides) assert.equal(fake.calls.length, 2, 'failed upload is never marked verified');
  }
});

test('parse CLI retains imports/local backup when Drive is unconfigured and safely reruns without duplicate observations', t => {
  const f = fixture(t), project = fileURLToPath(new URL('..', import.meta.url));
  fs.writeFileSync(path.join(f.dir, 'clemcast.config.json'), JSON.stringify({ timeZone: 'Europe/Rome' }));
  const backupPath = path.join(f.dir, 'cli-recovery.zip');
  const invoke = (localOnly = false) => spawnSync(process.execPath, ['--import', path.join(project, 'node_modules/tsx/dist/loader.mjs'),
    path.join(project, 'src/index.ts'), '--backup-to', backupPath, ...(localOnly ? ['--local-only'] : []), f.original],
  { cwd: f.dir, encoding: 'utf8', env: { ...process.env, TSX_TSCONFIG_PATH: path.join(project, 'tsconfig.json') } });
  const initial = loadGroup(path.join(f.output, 'family'));
  const failed = invoke();
  assert.equal(failed.status, 1, failed.stdout);
  assert.match(failed.stderr, /npm run setup-drive[\s\S]*Local recovery backup is safe/);
  assert.ok(fs.existsSync(backupPath));
  assert.ok(!fs.existsSync(path.join(f.dir, '.backup-lock')));
  const bytes = fs.readFileSync(backupPath), retried = invoke(true);
  assert.equal(retried.status, 0, retried.stderr);
  assert.match(retried.stdout, /Reusing verified recovery backup/);
  assert.deepEqual(fs.readFileSync(backupPath), bytes);
  assert.deepEqual(loadGroup(path.join(f.output, 'family')), initial);
});

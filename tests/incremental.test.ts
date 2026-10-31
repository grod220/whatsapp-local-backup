import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import AdmZip from 'adm-zip';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { captureSnapshot } from '../src/archive.js';
import { importBackup, loadGroup } from '../src/importer.js';
import { renderOutput } from '../src/render.js';
import { sha256 } from '../src/storage.js';
import { DirectoryBackupStore } from '../src/backup-store.js';
import { BACKUP_DATA, backupHistory, prepareIncrementalBackup, publishIncrementalBackup, recoverIncrementalBackup, recoverLocalCheckpoint } from '../src/incremental.js';
import { backupAndPublish } from '../src/publication.js';
import { deployOutput } from '../src/deploy.js';
import { createRecoveryZip, verifyPortableBackup } from '../src/zip-output.js';

const HEAD = `${BACKUP_DATA}/CURRENT.json`;
const initialText = '[20/01/2026, 12:00:00] Alex: A family update\n[20/01/2026, 12:00:01] Alex: <attached: photo.jpg>';
function fixture(t: { after: (f: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clemcast-incremental-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const workspace = path.join(dir, 'workspace'), remote = path.join(dir, 'drive'); fs.mkdirSync(workspace); fs.mkdirSync(remote);
  const output = path.join(workspace, 'output'), archive = path.join(workspace, 'archive');
  const add = (text = initialText, suffix = '') => {
    const zip = new AdmZip(); zip.addFile('_chat.txt', Buffer.from(text)); zip.addFile('photo.jpg', Buffer.from('saved family photo'));
    const filename = path.join(dir, `WhatsApp Chat - Family${suffix}.zip`); zip.writeZip(filename);
    importBackup(filename, output, archive, { timeZone: 'Europe/Rome', daysFirst: true }); renderOutput(output); captureSnapshot(output, archive);
    return filename;
  };
  const source = add(), store = new DirectoryBackupStore(remote);
  const checkpoint = () => prepareIncrementalBackup(workspace);
  const publish = () => publishIncrementalBackup(checkpoint(), store);
  return { dir, workspace, remote, output, archive, add, source, store, checkpoint, publish };
}

test('incremental publication stores shared data once, dates snapshots and safely reuses unchanged backups', t => {
  const f = fixture(t), first = f.publish();
  assert.ok(first.newObjects > 0);
  const head = JSON.parse(f.store.read(HEAD).toString('utf8'));
  const current = f.store.read(`${BACKUP_DATA}/snapshots/${head.snapshot.name}`);
  const second = f.publish();
  assert.equal(second.newObjects, 0);
  assert.deepEqual(second.snapshot, first.snapshot);
  assert.deepEqual(f.store.read(`${BACKUP_DATA}/snapshots/${head.snapshot.name}`), current);
  assert.equal(f.store.list(`${BACKUP_DATA}/snapshots`).length, 1);
  assert.equal(f.store.list('').filter(file => /^Latest backup - .+ - verified\.txt$/.test(file.name)).length, 1);
  assert.match(head.snapshot.name, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(f.store.list('').some(file => file.name === 'START HERE - Clemcast backups.txt'));
  assert.ok(!fs.readdirSync(f.workspace).some(name => name.endsWith('.zip')), 'routine publication creates no complete ZIP');
});

test('overlapping new exports upload only new objects and current and historical snapshots both recover', t => {
  const f = fixture(t), first = f.publish();
  const original = loadGroup(path.join(f.output, 'family'));
  f.add(initialText + '\n[21/01/2026, 12:00:00] Alex: Another update', ' (1)');
  const expected = loadGroup(path.join(f.output, 'family')), second = f.publish();
  assert.ok(second.newObjects > 0 && second.newObjects < f.store.list(`${BACKUP_DATA}/objects`).length);
  assert.notEqual(second.snapshot.sha256, first.snapshot.sha256);
  const restored = path.join(f.dir, 'restored'); recoverIncrementalBackup(f.store, restored);
  assert.deepEqual(loadGroup(path.join(restored, 'output/family')), expected);
  const historical = path.join(f.dir, 'historical'); recoverIncrementalBackup(f.store, historical, first.snapshot.name);
  assert.deepEqual(loadGroup(path.join(historical, 'output/family')), original);
  assert.throws(() => recoverIncrementalBackup(f.store, restored), /already exists/);
});

test('cloud continuity rejects an older but internally valid local archive', t => {
  const f = fixture(t); f.publish();
  const old = path.join(f.dir, 'old-workspace'); fs.cpSync(f.workspace, old, { recursive: true });
  fs.rmSync(path.join(old, '.incremental-backup'), { recursive: true });
  f.add(initialText + '\n[21/01/2026, 12:00:00] Alex: New history', ' (1)'); f.publish();
  const current = f.store.read(HEAD);
  assert.throws(() => publishIncrementalBackup(prepareIncrementalBackup(old), f.store), /removed|changed|lost|missing/i);
  assert.deepEqual(f.store.read(HEAD), current);
});

test('failed uploads do not advance current or publish the website, and interrupted initialization retries safely', t => {
  const f = fixture(t);
  class FailingStore extends DirectoryBackupStore {
    fail = true;
    override upload(source: string, names: string[], immutable: boolean) {
      if (this.fail && names.some(name => name.endsWith('.zip'))) { super.upload(source, names.slice(0, 1), immutable); throw new Error('Upload interrupted'); }
      super.upload(source, names, immutable);
    }
  }
  const store = new FailingStore(f.remote); let publications = 0;
  const options = { store, deploy: () => { publications++; } }, config = { remote: 'clemcast', folderId: 'existing-folder' };
  assert.throws(() => backupAndPublish(f.workspace, config, options), /Upload interrupted[\s\S]*Local recovery ZIP is safe/);
  assert.ok(!fs.existsSync(path.join(f.remote, HEAD))); assert.equal(publications, 0);
  store.fail = false; backupAndPublish(f.workspace, config, options); assert.equal(publications, 1);
});

test('corrupt remote bytes and failed readback preserve the previous current backup', t => {
  const f = fixture(t); f.publish(); const current = f.store.read(HEAD);
  const name = f.store.list(`${BACKUP_DATA}/objects`)[0]!.name, file = path.join(f.remote, BACKUP_DATA, 'objects', name);
  const bytes = fs.readFileSync(file); bytes[0] = bytes[0]! ^ 1; fs.writeFileSync(file, bytes);
  assert.throws(() => f.publish(), /checksum|damaged|verification/i);
  assert.deepEqual(f.store.read(HEAD), current);
  assert.throws(() => recoverIncrementalBackup(f.store, path.join(f.dir, 'bad-restore')), /damaged|checksum/i);
  assert.ok(!fs.existsSync(path.join(f.dir, 'bad-restore')));
});

test('observed concurrent cloud updates abort promotion', t => {
  const f = fixture(t); f.publish();
  f.add(initialText + '\n[21/01/2026, 12:00:00] Alex: New history', ' (1)');
  class ConcurrentStore extends DirectoryBackupStore {
    heads = 0;
    override read(name: string): Buffer {
      if (name === HEAD && ++this.heads === 2) {
        const value = JSON.parse(super.read(name).toString('utf8')); value.verifiedAt = '2026-01-01T00:00:00.000Z';
        fs.writeFileSync(path.join(this.directory, name), JSON.stringify(value));
      }
      return super.read(name);
    }
  }
  assert.throws(() => publishIncrementalBackup(f.checkpoint(), new ConcurrentStore(f.remote)), /Another computer updated/);
});

test('a repository with lost CURRENT cannot be silently reinitialized by a new checkout', t => {
  const f = fixture(t); f.publish(); f.store.trash([HEAD]);
  fs.rmSync(path.join(f.workspace, '.incremental-backup'), { recursive: true });
  assert.throws(() => f.publish(), /CURRENT.json is missing/);
  assert.ok(!fs.existsSync(path.join(f.remote, HEAD)));
});

test('old full ZIP contents are recovered file for file before containers move to recoverable Trash', t => {
  const f = fixture(t), zip = new AdmZip();
  zip.addFile('old-only-record.txt', Buffer.from('a record absent from the current workspace'));
  zip.addFile('saved-photo.jpg', Buffer.from('saved family photo'));
  const name = 'clemcast-full-backup-2026-10-08.zip'; zip.writeZip(path.join(f.remote, name));
  f.publish(); assert.ok(!fs.existsSync(path.join(f.remote, name)));
  assert.ok(fs.readdirSync(path.join(f.remote, '.trash')).some(file => file.endsWith(name)));
  const history = backupHistory(f.store), legacy = history.find(snapshot => snapshot.kind === 'legacy')!;
  const destination = path.join(f.dir, 'legacy'); recoverIncrementalBackup(f.store, destination, legacy.name);
  assert.equal(fs.readFileSync(path.join(destination, 'old-only-record.txt'), 'utf8'), 'a record absent from the current workspace');
  assert.equal(fs.readFileSync(path.join(destination, 'saved-photo.jpg'), 'utf8'), 'saved family photo');
  assert.equal(f.publish().newObjects, 0);
});

function multipart(f: ReturnType<typeof fixture>, damaged = false) {
  const zip = new AdmZip(); zip.addFile('historical-message.txt', Buffer.from('irreplaceable history'));
  const bytes = zip.toBuffer(), middle = Math.floor(bytes.length / 2), folder = 'Complete recovery 2026-10-31';
  const dir = path.join(f.remote, folder); fs.mkdirSync(dir);
  const parts = [bytes.subarray(0, middle), bytes.subarray(middle)].map((part, i) => {
    const name = `backup.zip.part-00${i + 1}`; fs.writeFileSync(path.join(dir, name), part); return { name, bytes: part.length, sha256: sha256(part) };
  });
  const helper = Buffer.from('recovery instructions'); fs.writeFileSync(path.join(dir, 'README.txt'), helper);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ format: 'clemcast-recovery-parts', version: 1,
    archive: { name: 'clemcast-recovery-2026-10-31.zip', bytes: bytes.length, sha256: damaged ? '0'.repeat(64) : sha256(bytes) }, parts,
    helpers: [{ name: 'README.txt', bytes: helper.length, sha256: sha256(helper) }] }));
  return dir;
}

test('multipart transport is reassembled, validated and its payload and helper files retained before retirement', t => {
  const f = fixture(t), folder = multipart(f); f.publish();
  assert.ok(!fs.existsSync(folder));
  const history = backupHistory(f.store), legacy = history.find(snapshot => snapshot.originalName === 'clemcast-recovery-2026-10-31.zip')!;
  const target = path.join(f.dir, 'old-parts'); recoverIncrementalBackup(f.store, target, legacy.name);
  assert.equal(fs.readFileSync(path.join(target, 'historical-message.txt'), 'utf8'), 'irreplaceable history');
  assert.ok(history.some(snapshot => snapshot.originalName?.endsWith('transport instructions')));
});

test('damaged multipart inventories are never retired or promoted', t => {
  const f = fixture(t), folder = multipart(f, true);
  assert.throws(() => f.publish(), /checksum/); assert.ok(fs.existsSync(folder));
  assert.ok(!fs.existsSync(path.join(f.remote, HEAD)));
});

test('standalone recovery ZIPs retain migrated old-only files and reject omission of their referenced bytes', t => {
  const f = fixture(t), zip = new AdmZip(); zip.addFile('old-only.txt', Buffer.from('older unique data'));
  zip.writeZip(path.join(f.remote, 'whatsapp-backup-2026-09-10.zip')); f.publish();
  const backup = path.join(f.dir, 'complete.zip'); createRecoveryZip(f.output, backup, f.archive); verifyPortableBackup(backup);
  const archive = new AdmZip(backup), manifest = JSON.parse(archive.readAsText('backup.json'));
  const legacyName = Object.keys(manifest.files).find(name => name.startsWith('archive/legacy-recovery/snapshots/'))!;
  const legacy = JSON.parse(archive.readAsText(legacyName)), location = legacy.locations[legacy.files['old-only.txt']];
  assert.equal(archive.readAsText(location), 'older unique data');
  const recovered = path.join(f.dir, 'portable'); archive.extractAllTo(recovered);
  const result = spawnSync(process.execPath, ['--import', fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url)),
    fileURLToPath(new URL('../scripts/recover-legacy.ts', import.meta.url)), recovered, path.basename(legacyName), path.join(f.dir, 'legacy-files')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(f.dir, 'legacy-files/old-only.txt'), 'utf8'), 'older unique data');
  delete manifest.files[location]; archive.deleteFile(location); archive.updateFile('backup.json', Buffer.from(JSON.stringify(manifest)));
  const bad = path.join(f.dir, 'bad.zip'); archive.writeZip(bad);
  assert.throws(() => verifyPortableBackup(bad), /recovery file is missing/i);
});

test('a failed current-pointer upload leaves earlier recovery data and old containers untouched', t => {
  const f = fixture(t); f.publish(); const before = f.store.read(HEAD);
  const zip = new AdmZip(); zip.addFile('old-record.txt', Buffer.from('retained data'));
  const name = 'clemcast-full-backup-2026-10-08.zip'; zip.writeZip(path.join(f.remote, name));
  class FailedPromotion extends DirectoryBackupStore {
    override upload(source: string, names: string[], immutable: boolean) {
      if (names.includes(HEAD)) throw new Error('Pointer upload failed');
      super.upload(source, names, immutable);
    }
  }
  assert.throws(() => publishIncrementalBackup(f.checkpoint(), new FailedPromotion(f.remote)), /Pointer upload failed/);
  assert.deepEqual(f.store.read(HEAD), before); assert.ok(fs.existsSync(path.join(f.remote, name)));
});

test('local incremental checkpoints recover offline and no credentials are captured', t => {
  const f = fixture(t), checkpoint = f.checkpoint(), target = path.join(f.dir, 'offline');
  recoverLocalCheckpoint(checkpoint.directory, target);
  assert.deepEqual(loadGroup(path.join(target, 'output/family')), loadGroup(path.join(f.output, 'family')));
  assert.ok(!Object.keys(checkpoint.files).some(name => /rclone.conf|oauth-client.json/.test(name)));
  fs.rmSync(path.join(checkpoint.directory, BACKUP_DATA, 'objects', Object.values(checkpoint.files)[0]!));
  assert.throws(() => recoverLocalCheckpoint(checkpoint.directory, path.join(f.dir, 'damaged')));
});

test('website deployment records success only after publishing and detects project changes', t => {
  const f = fixture(t), cache = path.join(f.workspace, '.deploy-hash');
  assert.throws(() => deployOutput(f.workspace, () => { throw new Error('Cloudflare offline'); }), /Cloudflare offline/);
  assert.ok(!fs.existsSync(cache)); let calls = 0; const publish = () => { calls++; };
  deployOutput(f.workspace, publish); deployOutput(f.workspace, publish); assert.equal(calls, 1);
  const previous = process.env.DEPLOY_PROJECT;
  try { process.env.DEPLOY_PROJECT = 'another-clemcast-project'; deployOutput(f.workspace, publish); assert.equal(calls, 2); }
  finally { if (previous === undefined) delete process.env.DEPLOY_PROJECT; else process.env.DEPLOY_PROJECT = previous; }
  fs.writeFileSync(path.join(f.output, 'family/index.html'), 'an interrupted rebuild');
  assert.throws(() => deployOutput(f.workspace, publish), /Incomplete viewer rebuild/); assert.equal(calls, 2);
});

test('parse CLI keeps an offline checkpoint when Drive is unavailable and safely replays imports', t => {
  const f = fixture(t), project = fileURLToPath(new URL('..', import.meta.url));
  fs.writeFileSync(path.join(f.workspace, 'clemcast.config.json'), JSON.stringify({ timeZone: 'Europe/Rome' }));
  const run = (local = false) => spawnSync(process.execPath, ['--import', path.join(project, 'node_modules/tsx/dist/loader.mjs'),
    path.join(project, 'src/index.ts'), ...(local ? ['--local-only'] : []), f.source],
  { cwd: f.workspace, encoding: 'utf8', env: { ...process.env, TSX_TSCONFIG_PATH: path.join(project, 'tsconfig.json') } });
  const before = loadGroup(path.join(f.output, 'family')), failed = run(); assert.equal(failed.status, 1);
  assert.match(failed.stderr, /npm run setup-drive[\s\S]*Local recovery ZIP is safe/);
  assert.ok(!fs.existsSync(path.join(f.workspace, '.backup-lock')));
  assert.equal(run(true).status, 0); assert.deepEqual(loadGroup(path.join(f.output, 'family')), before);
});

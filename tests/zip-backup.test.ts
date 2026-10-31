import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import AdmZip from 'adm-zip';
import { importBackup, loadGroup } from '../src/importer.js';
import { renderOutput } from '../src/render.js';
import { captureSnapshot } from '../src/archive.js';
import { DirectoryBackupStore } from '../src/backup-store.js';
import { prepareZipBackup, publishZipBackup, recoverDriveZip } from '../src/zip-backup.js';
import { prepareIncrementalBackup, publishIncrementalBackup, BACKUP_DATA } from '../src/incremental.js';
import { verifyPortableBackup } from '../src/zip-output.js';
import { sha256 } from '../src/storage.js';

const text = '[20/01/2026, 12:00:00] Alex: Family update\n[20/01/2026, 12:00:01] Alex: <attached: photo.jpg>';
function fixture(t: { after: (f: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clemcast-zip-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const workspace = path.join(dir, 'project'), remote = path.join(dir, 'drive'); fs.mkdirSync(workspace); fs.mkdirSync(remote);
  const output = path.join(workspace, 'output'), archive = path.join(workspace, 'archive');
  const add = (body = text) => {
    const zip = new AdmZip(); zip.addFile('_chat.txt', Buffer.from(body)); zip.addFile('photo.jpg', Buffer.from('family photo'));
    const filename = path.join(dir, 'WhatsApp Chat - Family.zip'); zip.writeZip(filename);
    importBackup(filename, output, archive, { timeZone: 'Europe/Rome', daysFirst: true }); renderOutput(output); captureSnapshot(output, archive);
  };
  add(); const store = new DirectoryBackupStore(remote);
  const publish = (target = store) => publishZipBackup(workspace, prepareZipBackup(workspace), target);
  const names = () => store.list('').filter(file => file.name !== '.trash').map(file => file.name);
  return { dir, workspace, remote, output, archive, add, store, publish, names };
}

test('one dated ordinary ZIP directly contains the site and unchanged runs upload nothing', t => {
  const f = fixture(t), first = f.publish(); assert.equal(first.uploaded, true);
  assert.match(first.name, /^\d{4}-\d{2}-\d{2} - Clemcast\.zip$/); assert.deepEqual(f.names(), [first.name]);
  const zip = new AdmZip(path.join(f.remote, first.name));
  assert.ok(zip.getEntry('output/family/index.html')); assert.ok(zip.getEntries().some(entry => entry.entryName.startsWith('output/family/attachments/')));
  assert.ok(zip.getEntries().some(entry => /^sources\/.+\.zip$/.test(entry.entryName)));
  const second = f.publish(); assert.equal(second.uploaded, false); assert.equal(second.sha256, first.sha256);
  assert.ok(!fs.existsSync(path.join(f.remote, '.trash')));
  const recovered = path.join(f.dir, 'recovered'); recoverDriveZip(f.store, recovered);
  assert.deepEqual(loadGroup(path.join(recovered, 'output/family')), loadGroup(path.join(f.output, 'family')));
  assert.throws(() => recoverDriveZip(f.store, recovered), /already exists/);
});

test('same-day replacement preserves every earlier file payload without nesting whole generated ZIPs', t => {
  const f = fixture(t), first = f.publish(), oldBytes = fs.readFileSync(path.join(f.remote, first.name));
  const old = new AdmZip(oldBytes).getEntries().filter(entry => !entry.isDirectory).map(entry => sha256(entry.getData()));
  f.add(text + '\n[21/01/2026, 12:00:00] Alex: A new memory');
  const second = f.publish(); assert.deepEqual(f.names(), [second.name]); assert.notEqual(second.sha256, first.sha256);
  const values = new Set(new AdmZip(path.join(f.remote, second.name)).getEntries().filter(entry => !entry.isDirectory).map(entry => sha256(entry.getData())));
  for (const hash of old) assert.ok(values.has(hash)); assert.ok(!values.has(sha256(oldBytes)), 'no full generated ZIP nested');
  assert.equal(f.publish().uploaded, false, 'no recursive history growth on replay');
  assert.equal(fs.readdirSync(path.join(f.workspace, 'backups/automatic')).filter(name => name.endsWith('.zip')).length, 1);
});

test('an older internally valid workspace cannot replace the newer Drive archive', t => {
  const f = fixture(t); f.publish(); const old = path.join(f.dir, 'old'); fs.cpSync(f.workspace, old, { recursive: true });
  f.add(text + '\n[21/01/2026, 12:00:00] Alex: Do not lose this'); const latest = f.publish();
  assert.throws(() => publishZipBackup(old, prepareZipBackup(old), f.store), /removed|changed|lost|missing/i);
  assert.equal(sha256(fs.readFileSync(path.join(f.remote, latest.name))), latest.sha256);
});

test('failed candidate readback and promotion retain recoverable prior copies and block cleanup', t => {
  const f = fixture(t), first = f.publish(); f.add(text + '\n[21/01/2026, 12:00:00] Alex: Another memory');
  class BadReadback extends DirectoryBackupStore {
    override download(names: string[], destination: string) {
      super.download(names, destination);
      if (names.some(name => name.startsWith('.Clemcast-upload-'))) fs.writeFileSync(path.join(destination, names[0]!), 'damaged');
    }
  }
  assert.throws(() => f.publish(new BadReadback(f.remote)));
  assert.equal(sha256(fs.readFileSync(path.join(f.remote, first.name))), first.sha256);
  class BadPromotion extends DirectoryBackupStore {
    override move(source: string, destination: string) { if (source.startsWith('.Clemcast-upload-')) throw new Error('Promotion interrupted'); super.move(source, destination); }
  }
  assert.throws(() => f.publish(new BadPromotion(f.remote)), /Promotion interrupted/);
  assert.ok(f.names().some(name => name.includes(' - previous-')));
  for (const name of f.names()) verifyPortableBackup(path.join(f.remote, name));
  const retried = f.publish(); assert.deepEqual(f.names(), [retried.name]);
});

test('the former Drive object folder is preserved file for file inside the ZIP before retirement', t => {
  const f = fixture(t); publishIncrementalBackup(prepareIncrementalBackup(f.workspace), f.store);
  const before = new Map<string, string>();
  const walk = (dir = '') => { for (const file of f.store.list(dir)) { if (file.name === '.trash') continue; const name = dir ? dir + '/' + file.name : file.name; if (file.directory) walk(name); else before.set(name, sha256(f.store.read(name))); } }; walk();
  const result = f.publish(); assert.deepEqual(f.names(), [result.name]); assert.ok(!fs.existsSync(path.join(f.remote, BACKUP_DATA)));
  const zip = new AdmZip(path.join(f.remote, result.name));
  const manifests = zip.getEntries().filter(entry => /^archive\/legacy-recovery\/snapshots\/drive-/.test(entry.entryName));
  assert.equal(manifests.length, 1); const manifest = JSON.parse(manifests[0]!.getData().toString());
  for (const [name, hash] of before) {
    assert.equal(manifest.files[name], hash); assert.equal(sha256(zip.getEntry(manifest.locations[hash])!.getData()), hash);
  }
  assert.equal(f.publish().uploaded, false);
});

test('unknown Drive files and concurrent changes prevent replacement and are never trashed', t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.remote, 'personal.txt'), 'unrelated');
  assert.throws(() => f.publish(), /Unrecognized/); assert.equal(f.store.read('personal.txt').toString(), 'unrelated');
  fs.unlinkSync(path.join(f.remote, 'personal.txt')); f.publish(); f.add(text + '\n[21/01/2026, 12:00:00] Alex: New');
  class Concurrent extends DirectoryBackupStore {
    override upload(source: string, names: string[], immutable: boolean) { super.upload(source, names, immutable); fs.writeFileSync(path.join(this.directory, 'concurrent.txt'), 'keep me'); }
  }
  assert.throws(() => f.publish(new Concurrent(f.remote)), /changed during/); assert.equal(f.store.read('concurrent.txt').toString(), 'keep me');
  assert.ok(!fs.existsSync(path.join(f.remote, '.trash')));
});

test('cleanup interrupted after promotion safely resumes even when the old CURRENT file is already trashed', t => {
  const f = fixture(t); publishIncrementalBackup(prepareIncrementalBackup(f.workspace), f.store);
  class InterruptedTrash extends DirectoryBackupStore {
    override trash(names: string[]) {
      if (names.includes(`${BACKUP_DATA}/CURRENT.json`)) { super.trash([`${BACKUP_DATA}/CURRENT.json`]); throw new Error('Trash interrupted'); }
      super.trash(names);
    }
  }
  assert.throws(() => f.publish(new InterruptedTrash(f.remote)), /Trash interrupted/);
  assert.ok(f.names().some(name => name.endsWith(' - Clemcast.zip')));
  const result = f.publish(); assert.deepEqual(f.names(), [result.name]); verifyPortableBackup(path.join(f.remote, result.name));
});

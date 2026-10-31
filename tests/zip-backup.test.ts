import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import AdmZip from 'adm-zip';
import { randomBytes } from 'node:crypto';
import { recoverHistoricalFiles } from '../src/backup-containers.js';
import { verifyRecoveryTree } from '../src/zip-output.js';
import { importBackup, loadGroup } from '../src/importer.js';
import { renderOutput } from '../src/render.js';
import { captureSnapshot } from '../src/archive.js';
import { DirectoryBackupStore } from '../src/backup-store.js';
import { prepareZipBackup, publishZipBackup, recoverDriveZip } from '../src/zip-backup.js';
import { prepareIncrementalBackup, publishIncrementalBackup, BACKUP_DATA } from '../src/incremental.js';
import { verifyPortableBackup } from '../src/zip-output.js';
import { sha256 } from '../src/storage.js';

const text = '[20/01/2026, 12:00:00] Alex: Family update\n[20/01/2026, 12:00:01] Alex: <attached: photo.jpg>';
function fixture(t: { after: (f: () => void) => void }, media = Buffer.from('family photo')) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clemcast-zip-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const workspace = path.join(dir, 'project'), remote = path.join(dir, 'drive'); fs.mkdirSync(workspace); fs.mkdirSync(remote);
  const output = path.join(workspace, 'output'), archive = path.join(workspace, 'archive');
  const add = (body = text) => {
    const zip = new AdmZip(); zip.addFile('_chat.txt', Buffer.from(body)); zip.addFile('photo.jpg', media);
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

test('nested generated backups are flattened on the real parse publication path, preserving unique files and posts', t => {
  const f = fixture(t, randomBytes(512 * 1024));
  fs.writeFileSync(path.join(f.output, 'older-note.txt'), 'Unique file from an older backup');
  const old = prepareZipBackup(f.workspace), nestedBytes = fs.readFileSync(old.filename), nestedHash = sha256(nestedBytes);
  fs.unlinkSync(path.join(f.output, 'older-note.txt'));
  f.add(text + '\n[21/01/2026, 12:00:00] Alex: Latest post');
  const object = `archive/legacy-recovery/objects/${nestedHash}`;
  fs.mkdirSync(path.dirname(path.join(f.workspace, object)), { recursive: true });
  fs.writeFileSync(path.join(f.workspace, object), nestedBytes);
  const snapshots = path.join(f.archive, 'legacy-recovery/snapshots'); fs.mkdirSync(snapshots, { recursive: true });
  fs.writeFileSync(path.join(snapshots, 'old-package.json'), JSON.stringify({ format: 'clemcast-legacy-recovery', version: 1,
    originalName: 'Older full backup', files: { 'cumulative-backup.zip': nestedHash }, locations: { [nestedHash]: object } }));
  const result = f.publish(), zip = new AdmZip(path.join(f.remote, result.name));
  assert.equal(zip.getEntry(object), null, 'must not preserve a full generated ZIP as an opaque object');
  assert.ok(result.bytes < nestedBytes.length * 2, 'shared media must not be duplicated through a generated container');
  const original = new AdmZip(nestedBytes).getEntries().find(entry => entry.entryName.startsWith('sources/'))!;
  assert.deepEqual(zip.getEntry(original.entryName)!.getData(), original.getData(), 'original WhatsApp ZIP stays byte-exact');
  assert.ok(zip.getEntries().some(entry => sha256(entry.getData()) === sha256('Unique file from an older backup')), 'unique historical file retained');
  assert.deepEqual(zip.getEntry('output/family/data.json')!.getData(), fs.readFileSync(path.join(f.output, 'family/data.json')));
  verifyPortableBackup(path.join(f.remote, result.name));
  const restored = path.join(f.dir, 'compacted'); recoverDriveZip(f.store, restored);
  verifyRecoveryTree(restored);
  const manifest = JSON.parse(fs.readFileSync(path.join(restored, 'archive/legacy-recovery/snapshots/old-package.json'), 'utf8'));
  const historical = path.join(f.dir, 'historical'); fs.mkdirSync(historical);
  recoverHistoricalFiles(restored, manifest.files, manifest.locations, historical);
  assert.equal(fs.readFileSync(path.join(historical, 'cumulative-backup.zip.contents/output/older-note.txt'), 'utf8'), 'Unique file from an older backup');
  for (const entry of new AdmZip(nestedBytes).getEntries()) if (!entry.isDirectory) assert.deepEqual(fs.readFileSync(path.join(historical, 'cumulative-backup.zip.contents', entry.entryName)), entry.getData());
  const damaged = new AdmZip(path.join(f.remote, result.name)), inventory = JSON.parse(damaged.getEntry('backup.json')!.getData().toString());
  const unique = damaged.getEntries().find(entry => sha256(entry.getData()) === sha256('Unique file from an older backup'))!.entryName;
  damaged.deleteFile(unique); delete inventory.files[unique]; damaged.updateFile('backup.json', Buffer.from(JSON.stringify(inventory)));
  const bad = path.join(f.dir, 'missing-historical-file.zip'); damaged.writeZip(bad);
  assert.throws(() => verifyPortableBackup(bad), /missing/);
  assert.throws(() => recoverHistoricalFiles(restored, { '../escape': '0'.repeat(64) }, { ['0'.repeat(64)]: object }, historical), /Unsafe/);
  assert.deepEqual(loadGroup(path.join(restored, 'output/family')), loadGroup(path.join(f.output, 'family')));
  assert.equal(f.publish().uploaded, false, 'unchanged replay cannot grow nested backups again');
});

test('a previously uploaded large ZIP is replaced only after all its unique contents survive compaction', t => {
  const f = fixture(t, randomBytes(256 * 1024));
  fs.writeFileSync(path.join(f.output, 'previous-note.txt'), 'Historical unique note');
  const nested = fs.readFileSync(prepareZipBackup(f.workspace).filename), hash = sha256(nested);
  fs.unlinkSync(path.join(f.output, 'previous-note.txt')); f.add(text + '\n[21/01/2026, 12:00:00] Alex: Current post');
  const base = prepareZipBackup(f.workspace), large = new AdmZip(base.filename), object = `archive/legacy-recovery/objects/${hash}`;
  const snapshot = 'archive/legacy-recovery/snapshots/older-nested.json';
  const mapping = Buffer.from(JSON.stringify({ format: 'clemcast-legacy-recovery', version: 1, originalName: 'Older backup', files: { 'cumulative-backup.zip': hash }, locations: { [hash]: object } }));
  large.addFile(object, nested); large.addFile(snapshot, mapping);
  const manifest = JSON.parse(large.getEntry('backup.json')!.getData().toString()); manifest.files[object] = hash; manifest.files[snapshot] = sha256(mapping);
  large.updateFile('backup.json', Buffer.from(JSON.stringify(manifest)));
  const name = '2026-10-30 - Clemcast.zip'; large.writeZip(path.join(f.remote, name)); verifyPortableBackup(path.join(f.remote, name));
  fs.mkdirSync(path.dirname(path.join(f.workspace, object)), { recursive: true }); fs.writeFileSync(path.join(f.workspace, object), nested);
  fs.mkdirSync(path.dirname(path.join(f.workspace, snapshot)), { recursive: true }); fs.writeFileSync(path.join(f.workspace, snapshot), mapping);
  const before = fs.statSync(path.join(f.remote, name)).size, result = f.publish();
  assert.ok(result.bytes < before, 'cloud replacement must actually be smaller');
  assert.deepEqual(f.names(), [result.name]);
  const small = new AdmZip(path.join(f.remote, result.name));
  const hashes = new Set(small.getEntries().filter(entry => !entry.isDirectory).map(entry => sha256(entry.getData())));
  for (const entry of large.getEntries()) if (!entry.isDirectory && entry.entryName !== object) assert.ok(hashes.has(sha256(entry.getData())), entry.entryName);
  for (const entry of new AdmZip(nested).getEntries()) if (!entry.isDirectory) assert.ok(hashes.has(sha256(entry.getData())), entry.entryName);
  const descriptor = path.join(f.workspace, JSON.parse(small.getEntry('backup.json')!.getData().toString()).expandedContainers[hash]);
  const good = fs.readFileSync(descriptor), bad = JSON.parse(good.toString()); delete bad.files['output/previous-note.txt']; fs.writeFileSync(descriptor, JSON.stringify(bad));
  assert.throws(() => f.publish(), /lose or change/);
  assert.equal(sha256(fs.readFileSync(path.join(f.remote, result.name))), result.sha256);
  fs.writeFileSync(descriptor, good); assert.equal(f.publish().uploaded, false);
});

test('original WhatsApp exports and authentic posted ZIP attachments are never expanded', t => {
  const first = fixture(t), generated = fs.readFileSync(prepareZipBackup(first.workspace).filename);
  const second = fixture(t, generated), result = second.publish(), zip = new AdmZip(path.join(second.remote, result.name));
  const media = zip.getEntries().find(entry => entry.entryName.startsWith('output/family/attachments/'))!;
  assert.deepEqual(media.getData(), generated);
  const manifest = JSON.parse(zip.getEntry('backup.json')!.getData().toString()); assert.equal(manifest.expandedContainers, undefined);
});

test('an accidentally copied generated backup in site output blocks publication instead of being nested', t => {
  const f = fixture(t), generated = prepareZipBackup(f.workspace);
  fs.copyFileSync(generated.filename, path.join(f.output, 'accidental-backup.zip'));
  assert.throws(() => f.publish(), /Generated backup found outside recovery history/); assert.deepEqual(f.names(), []);
});

test('multiple generated backup layers expand recursively and restore every nested file', t => {
  const f = fixture(t), inner = fs.readFileSync(prepareZipBackup(f.workspace).filename), outer = new AdmZip(inner);
  outer.addFile('nested-backup.zip', inner);
  const manifest = JSON.parse(outer.getEntry('backup.json')!.getData().toString()); manifest.files['nested-backup.zip'] = sha256(inner);
  outer.updateFile('backup.json', Buffer.from(JSON.stringify(manifest)));
  const data = outer.toBuffer(), hash = sha256(data), object = `archive/legacy-recovery/objects/${hash}`;
  fs.mkdirSync(path.dirname(path.join(f.workspace, object)), { recursive: true }); fs.writeFileSync(path.join(f.workspace, object), data);
  const snapshots = path.join(f.archive, 'legacy-recovery/snapshots'); fs.mkdirSync(snapshots, { recursive: true });
  const mapping = { format: 'clemcast-legacy-recovery', version: 1, files: { 'outer.zip': hash }, locations: { [hash]: object } };
  fs.writeFileSync(path.join(snapshots, 'layers.json'), JSON.stringify(mapping));
  const result = f.publish(), zip = new AdmZip(path.join(f.remote, result.name));
  assert.equal(zip.getEntry(object), null); assert.equal(zip.getEntry(`archive/legacy-recovery/objects/${sha256(inner)}`), null);
  const recovered = path.join(f.dir, 'layers'); recoverDriveZip(f.store, recovered);
  const oldFiles = path.join(f.dir, 'old-layers'); fs.mkdirSync(oldFiles);
  recoverHistoricalFiles(recovered, mapping.files, mapping.locations, oldFiles);
  assert.deepEqual(fs.readFileSync(path.join(oldFiles, 'outer.zip.contents/nested-backup.zip.contents/output/family/data.json')), fs.readFileSync(path.join(f.output, 'family/data.json')));
});

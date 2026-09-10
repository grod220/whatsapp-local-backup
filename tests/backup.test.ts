import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import AdmZip from 'adm-zip';
import { captureSnapshot, restoreSnapshot, verifyContinuity, sourcesDirectory, latestSnapshotHash, readSnapshot, objectPath } from '../src/archive.js';
import { discoverWhatsAppZips } from '../src/discovery.js';
import { importBackup, loadGroup, validateOutput } from '../src/importer.js';
import { mergeMessages } from '../src/merge.js';
import { renderOutput } from '../src/render.js';
import { sha256, withBackupLock, writeAtomic, writeImmutable } from '../src/storage.js';
import { createOutputZip, compactArchive, verifyPortableBackup } from '../src/zip-output.js';
import type { MessageWithId } from '../src/types.js';

const projectDir = fileURLToPath(new URL('..', import.meta.url));
const cli = path.join(projectDir, 'src/index.ts');
const tsx = path.join(projectDir, 'node_modules/tsx/dist/loader.mjs');
const cliEnv = { ...process.env, TSX_TSCONFIG_PATH: path.join(projectDir, 'tsconfig.json') };

function fixture(t: { after: (fn: () => void) => void }) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'clemcast-test-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const output = path.join(workspace, 'output');
  const archive = path.join(workspace, 'archive');
  function zip(name: string, chat: string, media: Record<string, string> = {}, chatName = '_chat.txt'): string {
    const filename = path.join(workspace, name);
    const zip = new AdmZip();
    zip.addFile(chatName, Buffer.from(chat));
    for (const [name, content] of Object.entries(media)) zip.addFile(name, Buffer.from(content));
    zip.writeZip(filename);
    return filename;
  }
  function run(filename: string, group?: string): void {
    validateOutput(output);
    captureSnapshot(output, archive);
    importBackup(filename, output, archive, { daysFirst: true, ...(group && { group }) });
    captureSnapshot(output, archive);
  }
  const read = (group = 'family') => loadGroup(path.join(output, group));
  return { workspace, output, archive, zip, run, read };
}

const line = (day: number, second: number, message: string) => `[${day}/01/2026, 12:00:${String(second).padStart(2, '0')}] Alex: ${message}`;

test('older and newer phones form a cumulative union; replay and shorter exports do not remove records or media', t => {
  const f = fixture(t);
  const old = f.zip('WhatsApp Chat - Family.zip', [line(20, 1, 'Old phone'), line(21, 2, '<attached: photo.jpg>')].join('\n'), { 'photo.jpg': 'old photo' });
  f.run(old);
  const previous = f.read();
  const newer = f.zip('WhatsApp Chat - Family (1).zip', [line(21, 2, '<attached: renamed.jpg>'), line(22, 3, 'New phone')].join('\n'), { 'renamed.jpg': 'old photo' });
  f.run(newer);
  const merged = f.read();
  assert.equal(merged.messages.length, 3);
  assert.equal(Object.keys(merged.manifest.contentHashes).length, 1);
  for (const message of previous.messages) assert.deepEqual(merged.messages.find(m => m.id === message.id), message);
  f.run(newer);
  f.run(old);
  assert.deepEqual(f.read(), merged);
  assert.equal(fs.readdirSync(sourcesDirectory(f.archive)).length, 2);
  assert.deepEqual(fs.readFileSync(path.join(sourcesDirectory(f.archive), `${sha256(fs.readFileSync(old))}.zip`)), fs.readFileSync(old));
});

test('discovery retains every export, including multiple exports of one chat and Android filenames', t => {
  const f = fixture(t);
  const old = f.zip('WhatsApp Chat - Family.zip', line(20, 1, 'Old'));
  const recent = f.zip('WhatsApp Chat - Family (1).zip', line(22, 1, 'New'));
  const android = f.zip('WhatsApp Chat with Work.zip', line(23, 1, 'Work'));
  f.zip('unrelated.zip', 'not a chat');
  assert.deepEqual(new Set(discoverWhatsAppZips(f.workspace)), new Set([old, recent, android]));
});

test('distinct seconds and repeated identical messages survive, with stable legacy IDs', t => {
  const f = fixture(t);
  const repeated = f.zip('WhatsApp Chat - Family.zip', [line(20, 1, 'Yes'), line(20, 20, 'Yes'), line(20, 20, 'Yes')].join('\n'));
  f.run(repeated);
  const messages = f.read().messages;
  assert.equal(messages.length, 3);
  assert.equal(new Set(messages.map(m => m.id)).size, 3);
  f.run(repeated);
  assert.deepEqual(f.read().messages, messages);
  const legacy: MessageWithId[] = [{ ...messages[0]!, id: 'legacy' }, { ...messages[0]!, id: 'legacy-2' }];
  assert.deepEqual(mergeMessages(legacy, [messages[0]!]), legacy);
});

test('reused attachment filename with different bytes retains both attachments', t => {
  const f = fixture(t);
  f.run(f.zip('WhatsApp Chat - Family.zip', line(20, 1, '<attached: photo.jpg>'), { 'photo.jpg': 'photo one' }));
  const original = f.read().messages[0]!;
  f.run(f.zip('WhatsApp Chat - Family (1).zip', line(21, 1, '<attached: photo.jpg>'), { 'photo.jpg': 'photo two' }));
  assert.equal(f.read().messages.length, 2);
  assert.equal(Object.keys(f.read().manifest.contentHashes).length, 2);
  assert.equal(fs.readFileSync(path.join(f.output, 'family/attachments', original.attachment!), 'utf8'), 'photo one');
});

test('unresolved media references, captions, empty-author-looking lines and Android attachments are retained', t => {
  const f = fixture(t);
  f.run(f.zip('WhatsApp Chat - Family.zip', [line(20, 1, '<attached: missing.mov> caption'), '[20/01/2026, 12:01:00] Person:'].join('\n')));
  assert.equal(f.read().messages[0]!.missingAttachment, 'missing.mov');
  assert.equal(f.read().messages[0]!.message, '<attached: missing.mov> caption');
  assert.equal(f.read().messages.length, 2);
  renderOutput(f.output);
  const chunk = fs.readFileSync(path.join(f.output, 'family/chunks/2026-01-20.js'), 'utf8');
  assert.match(chunk, /Person:/);
  f.run(f.zip('WhatsApp Chat with Android.zip', '21/01/2026, 12:00 - Alex: IMG-20260121.jpg (file attached)\nA caption', { 'IMG-20260121.jpg': 'image' }, 'WhatsApp Chat with Android.txt'));
  assert.ok(f.read('android').messages[0]!.attachment);
  assert.match(f.read('android').messages[0]!.message, /A caption/);
});

test('different names with the same slug stay separate; renamed chat can target an existing group', t => {
  const f = fixture(t);
  f.run(f.zip('WhatsApp Chat - Family!.zip', line(20, 1, 'One')));
  f.run(f.zip('WhatsApp Chat - Family?.zip', line(21, 1, 'Two')));
  f.run(f.zip('WhatsApp Chat - Family*.zip', line(21, 2, 'Also separate')));
  const groups = fs.readdirSync(f.output);
  assert.equal(groups.length, 3);
  assert.equal(f.read().messages.length, 1);
  f.run(f.zip('WhatsApp Chat - Renamed.zip', line(22, 1, 'Three')), 'family');
  assert.equal(f.read().messages.length, 2);
  assert.equal(f.read().name, 'Family!');
});

test('corrupt JSON fails without replacing it; missing or modified media fails integrity checks', t => {
  const f = fixture(t);
  const source = f.zip('WhatsApp Chat - Family.zip', line(20, 1, '<attached: image.jpg>'), { 'image.jpg': 'original' });
  f.run(source);
  const group = path.join(f.output, 'family');
  const dataPath = path.join(group, 'data.json');
  const valid = fs.readFileSync(dataPath);
  fs.writeFileSync(dataPath, '{truncated');
  assert.throws(() => f.run(source));
  assert.equal(fs.readFileSync(dataPath, 'utf8'), '{truncated');
  fs.writeFileSync(dataPath, valid);
  const mediaPath = path.join(group, 'attachments', f.read().messages[0]!.attachment!);
  fs.writeFileSync(mediaPath, 'damaged');
  assert.throws(() => f.run(source), /integrity/);
  fs.unlinkSync(mediaPath);
  assert.throws(() => f.run(source), /ENOENT/);
});

test('valid but shortened history, deleted groups and lost output are blocked by the retained snapshot', t => {
  const f = fixture(t);
  const source = f.zip('WhatsApp Chat - Family.zip', [line(20, 1, 'Old'), line(21, 1, 'New')].join('\n'));
  f.run(source);
  const dataPath = path.join(f.output, 'family/data.json');
  fs.writeFileSync(dataPath, '[]');
  assert.throws(() => f.run(source), /removed or changed/);
  fs.rmSync(f.output, { recursive: true });
  assert.throws(() => f.run(source), /missing/);
  assert.equal(fs.existsSync(f.output), false);
});

test('missing or malformed media manifest stops import without replacing history', t => {
  const f = fixture(t);
  const source = f.zip('WhatsApp Chat - Family.zip', line(20, 1, 'Existing'));
  f.run(source);
  const data = fs.readFileSync(path.join(f.output, 'family/data.json'));
  fs.writeFileSync(path.join(f.output, 'family/manifest.json'), '{"contentHashes":[]}');
  assert.throws(() => f.run(source), /metadata/);
  assert.deepEqual(fs.readFileSync(path.join(f.output, 'family/data.json')), data);
});

test('unsupported and corrupt exports retain original bytes and fail without changing existing history', t => {
  const f = fixture(t);
  f.run(f.zip('WhatsApp Chat - Family.zip', line(20, 1, 'Existing')));
  const previous = f.read();
  const invalid = f.zip('WhatsApp Chat - Family (1).zip', 'unsupported transcript');
  assert.throws(() => f.run(invalid), /No valid messages/);
  const corrupt = path.join(f.workspace, 'WhatsApp Chat - Family (2).zip');
  fs.writeFileSync(corrupt, 'broken ZIP');
  assert.throws(() => f.run(corrupt));
  assert.deepEqual(f.read(), previous);
  assert.equal(fs.readdirSync(sourcesDirectory(f.archive)).length, 3);
});

test('portable backup restores all records and bytes, and refuses to overwrite an older backup or destination', t => {
  const f = fixture(t);
  f.run(f.zip('WhatsApp Chat - Family.zip', line(20, 1, '<attached: movie.mp4>'), { 'movie.mp4': 'video bytes' }));
  f.run(f.zip('WhatsApp Chat - Family (1).zip', line(21, 1, 'New phone')));
  renderOutput(f.output);
  const backup = path.join(f.workspace, 'cumulative.zip');
  createOutputZip(f.output, backup, f.archive);
  const zip = new AdmZip(backup);
  assert.equal(zip.test(), true);
  assert.ok(zip.getEntry('output/index.html'));
  assert.ok(zip.getEntry('archive/latest.json'));
  assert.equal(zip.getEntries().filter(entry => entry.entryName.startsWith('archive/sources/') || entry.entryName.startsWith('sources/')).length, 0);
  assert.equal(JSON.parse(zip.readAsText('backup.json')).separateSources.length, 2);
  const unpacked = path.join(f.workspace, 'unpacked');
  zip.extractAllTo(unpacked);
  const recovered = path.join(f.workspace, 'recovered');
  restoreSnapshot(path.join(unpacked, 'archive'), recovered);
  assert.deepEqual(loadGroup(path.join(recovered, 'family')), f.read());
  verifyContinuity(recovered, f.archive);
  assert.throws(() => createOutputZip(f.output, backup, f.archive), /already exists/);
  assert.throws(() => restoreSnapshot(f.archive, f.output), /already exists/);
});

test('damaged recovery objects are detected before restore and are never overwritten', t => {
  const f = fixture(t);
  f.run(f.zip('WhatsApp Chat - Family.zip', line(20, 1, 'Existing')));
  const object = path.join(f.archive, 'objects', fs.readdirSync(path.join(f.archive, 'objects'))[0]!);
  fs.writeFileSync(object, 'damaged');
  const destination = path.join(f.workspace, 'restore');
  assert.throws(() => restoreSnapshot(f.archive, destination), /Damaged/);
  assert.equal(fs.existsSync(destination), false);
  assert.throws(() => writeImmutable(object, 'replacement'), /integrity/);
  assert.equal(fs.readFileSync(object, 'utf8'), 'damaged');
});

test('concurrent imports are refused and interrupted writes leave prior history intact', t => {
  const f = fixture(t);
  withBackupLock(f.workspace, () => assert.throws(() => withBackupLock(f.workspace, () => {}), /Another backup/));
  assert.equal(fs.existsSync(path.join(f.workspace, '.backup-lock')), false);
  const destination = path.join(f.workspace, 'history.json');
  fs.writeFileSync(destination, 'original');
  const originalRename = fs.renameSync;
  fs.renameSync = () => { throw new Error('simulated interrupted write'); };
  try { assert.throws(() => writeAtomic(destination, 'replacement'), /interrupted/); }
  finally { fs.renameSync = originalRename; }
  assert.equal(fs.readFileSync(destination, 'utf8'), 'original');
});

test('CLI failures return nonzero and never fall through to publishing', t => {
  const f = fixture(t);
  const invalid = f.zip('WhatsApp Chat - Family.zip', 'not parseable');
  const result = spawnSync(process.execPath, ['--import', tsx, cli, invalid], { cwd: f.workspace, encoding: 'utf8', env: cliEnv });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /1 import\(s\) failed/);
  assert.equal(fs.existsSync(path.join(f.workspace, '.backup-lock')), false);
  assert.equal(fs.readdirSync(sourcesDirectory(f.archive)).length, 1);
});

test('CLI uses explicit ZIP arguments, creates a cumulative portable backup and preserves the prior backup', t => {
  const f = fixture(t);
  const first = f.zip('WhatsApp Chat - Family.zip', line(20, 1, 'Old phone'));
  const second = f.zip('WhatsApp Chat - Family (1).zip', line(21, 1, 'New phone'));
  const backup = path.join(f.workspace, 'portable.zip');
  const args = ['--import', tsx, cli, '--days-first', '--backup-to', backup, first, second];
  const result = spawnSync(process.execPath, args, { cwd: f.workspace, encoding: 'utf8', env: cliEnv });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.read().messages.length, 2);
  const backupBytes = fs.readFileSync(backup);
  const replay = spawnSync(process.execPath, args, { cwd: f.workspace, encoding: 'utf8', env: cliEnv });
  assert.equal(replay.status, 1);
  assert.match(replay.stderr, /already exists/);
  assert.equal(f.read().messages.length, 2);
  assert.deepEqual(fs.readFileSync(backup), backupBytes);
});

// Simulate the full-object v1 archive already present before this migration.
function addLegacySnapshot(output: string, archive: string): string {
  const latest = readSnapshot(archive, latestSnapshotHash(archive));
  for (const [relative, hash] of Object.entries(latest.files)) {
    writeImmutable(objectPath(archive, hash), fs.readFileSync(path.join(output, relative)));
  }
  const bytes = JSON.stringify({ version: 1, files: latest.files }, null, 2);
  const hash = sha256(bytes);
  writeImmutable(path.join(archive, 'snapshots', `${hash}.json`), bytes);
  writeAtomic(path.join(archive, 'latest.json'), JSON.stringify({ snapshot: hash }, null, 2));
  return hash;
}

test('new snapshots store metadata only and retain all media including unreferenced attachments', t => {
  const f = fixture(t);
  f.run(f.zip('WhatsApp Chat - Family.zip', line(20, 1, 'Hello'), { 'extra.mov': 'unreferenced video' }));
  const snapshot = readSnapshot(f.archive, latestSnapshotHash(f.archive));
  assert.equal(snapshot.version, 2);
  const hashes = Object.entries(snapshot.files).filter(([relative]) => relative.includes('/attachments/')).map(([, hash]) => hash);
  assert.equal(hashes.length, 1);
  for (const hash of hashes) assert.equal(fs.existsSync(objectPath(f.archive, hash)), false);
  assert.equal(fs.readdirSync(path.join(f.archive, 'objects')).length, 3);
});

test('legacy and lean snapshots restore from the smaller ZIP without the original local archive', t => {
  const f = fixture(t);
  f.run(f.zip('WhatsApp Chat - Family.zip', line(20, 1, '<attached: first.jpg>'), { 'first.jpg': 'first image', 'extra.mov': 'old unused video' }));
  const older = f.read();
  const oldSnapshot = addLegacySnapshot(f.output, f.archive);
  f.run(f.zip('WhatsApp Chat - Family (1).zip', line(21, 1, '<attached: second.jpg>'), { 'second.jpg': 'second image' }));
  const latest = f.read();
  renderOutput(f.output);
  const backup = path.join(f.workspace, 'lean.zip');
  createOutputZip(f.output, backup, f.archive);
  const zip = new AdmZip(backup);
  for (const hash of Object.keys(latest.manifest.contentHashes)) assert.equal(zip.getEntry(`archive/objects/${hash}`), null);
  assert.ok(zip.getEntry('output/index.html'));
  assert.ok(zip.getEntry('README.txt'));
  verifyPortableBackup(backup, f.output, f.archive);
  const unpacked = path.join(f.workspace, 'unpacked');
  zip.extractAllTo(unpacked);
  fs.rmSync(f.output, { recursive: true });
  fs.rmSync(f.archive, { recursive: true });
  fs.rmSync(sourcesDirectory(f.archive), { recursive: true });
  const recovered = path.join(f.workspace, 'recovered');
  const recoveredOld = path.join(f.workspace, 'recovered-old');
  restoreSnapshot(path.join(unpacked, 'archive'), recovered);
  restoreSnapshot(path.join(unpacked, 'archive'), recoveredOld, oldSnapshot);
  assert.deepEqual(loadGroup(path.join(recovered, 'family')), latest);
  assert.deepEqual(loadGroup(path.join(recoveredOld, 'family')), older);
});

test('legacy full-object archive restores without output and before any migration', t => {
  const f = fixture(t);
  f.run(f.zip('WhatsApp Chat - Family.zip', line(20, 1, '<attached: first.jpg>'), { 'first.jpg': 'first image' }));
  const previous = f.read();
  addLegacySnapshot(f.output, f.archive);
  fs.rmSync(f.output, { recursive: true });
  const recovered = path.join(f.workspace, 'recovered');
  restoreSnapshot(f.archive, recovered);
  assert.deepEqual(loadGroup(path.join(recovered, 'family')), previous);
});

test('compaction removes only verified duplicate media and preserves sources, snapshots and unknown objects', t => {
  const f = fixture(t);
  const original = f.zip('WhatsApp Chat - Family.zip', line(20, 1, '<attached: first.jpg>'), { 'first.jpg': 'first image' });
  f.run(original);
  const previous = f.read();
  const oldSnapshot = addLegacySnapshot(f.output, f.archive);
  const unknownBytes = Buffer.from('unknown retained object');
  const unknown = objectPath(f.archive, sha256(unknownBytes));
  writeImmutable(unknown, unknownBytes);
  captureSnapshot(f.output, f.archive);
  renderOutput(f.output);
  const backup = path.join(f.workspace, 'downloaded.zip');
  createOutputZip(f.output, backup, f.archive);
  const result = compactArchive(f.output, f.archive, backup);
  assert.equal(result.removedFiles, 1);
  assert.equal(result.removedBytes, Buffer.byteLength('first image'));
  assert.deepEqual(f.read(), previous);
  assert.deepEqual(fs.readFileSync(unknown), unknownBytes);
  assert.ok(fs.existsSync(path.join(sourcesDirectory(f.archive), `${sha256(fs.readFileSync(original))}.zip`)));
  assert.ok(fs.existsSync(path.join(f.archive, 'snapshots', `${oldSnapshot}.json`)));
  const recovered = path.join(f.workspace, 'recovered');
  restoreSnapshot(f.archive, recovered, oldSnapshot);
  assert.deepEqual(loadGroup(path.join(recovered, 'family')), previous);
  assert.equal(compactArchive(f.output, f.archive, backup).removedFiles, 0);
  f.run(original);
  assert.deepEqual(f.read(), previous);
  for (const hash of Object.keys(previous.manifest.contentHashes)) assert.equal(fs.existsSync(objectPath(f.archive, hash)), false);
});

test('incomplete, tampered or stale portable backups cannot authorize compaction', t => {
  const f = fixture(t);
  f.run(f.zip('WhatsApp Chat - Family.zip', line(20, 1, '<attached: first.jpg>'), { 'first.jpg': 'first image' }));
  addLegacySnapshot(f.output, f.archive);
  captureSnapshot(f.output, f.archive);
  renderOutput(f.output);
  const backup = path.join(f.workspace, 'backup.zip');
  createOutputZip(f.output, backup, f.archive);
  const objects = fs.readdirSync(path.join(f.archive, 'objects'));
  const tampered = new AdmZip(backup);
  tampered.updateFile('output/family/data.json', Buffer.from('[]'));
  const broken = path.join(f.workspace, 'broken.zip');
  tampered.writeZip(broken);
  assert.throws(() => compactArchive(f.output, f.archive, broken), /checksum mismatch/);
  const incomplete = new AdmZip(backup);
  const media = incomplete.getEntries().find(entry => entry.entryName.includes('/attachments/'))!;
  incomplete.deleteFile(media.entryName);
  incomplete.writeZip(broken);
  assert.throws(() => compactArchive(f.output, f.archive, broken), /inventory mismatch/);
  assert.deepEqual(fs.readdirSync(path.join(f.archive, 'objects')), objects);
  f.run(f.zip('WhatsApp Chat - Family (1).zip', line(21, 1, 'New message')));
  assert.throws(() => compactArchive(f.output, f.archive, backup), /does not cover/);
  for (const name of objects) assert.ok(fs.existsSync(path.join(f.archive, 'objects', name)));
});

test('missing media from any historical snapshot blocks packaging, even if the current manifest no longer refers to it', t => {
  const f = fixture(t);
  f.run(f.zip('WhatsApp Chat - Family.zip', line(20, 1, 'Hi'), { 'extra.jpg': 'unreferenced image' }));
  const initial = f.read();
  const attachment = Object.values(initial.manifest.contentHashes)[0]!;
  const metadataOnly = readSnapshot(f.archive, latestSnapshotHash(f.archive));
  for (const relative of Object.keys(metadataOnly.files)) {
    if (relative.includes('/attachments/')) delete metadataOnly.files[relative];
  }
  const bytes = JSON.stringify(metadataOnly, null, 2);
  writeImmutable(path.join(f.archive, 'snapshots', `${sha256(bytes)}.json`), bytes);
  writeAtomic(path.join(f.archive, 'latest.json'), JSON.stringify({ snapshot: sha256(bytes) }));
  fs.unlinkSync(path.join(f.output, 'family/attachments', attachment));
  assert.throws(() => createOutputZip(f.output, path.join(f.workspace, 'backup.zip'), f.archive), /media is missing/);
});

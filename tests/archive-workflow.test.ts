import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import AdmZip from 'adm-zip';
import { importBackup, loadGroup } from '../src/importer.js';
import { captureSnapshot, verifyContinuity, auditSources, auditArchive, restoreSnapshot, archiveSource } from '../src/archive.js';
import { renderOutput } from '../src/render.js';
import { createRecoveryZip, verifyPortableBackup } from '../src/zip-output.js';
import { sha256 } from '../src/storage.js';
import { verifyViews } from '../src/verify-views.js';

function workspace(t: { after: (f: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clemcast-workflow-'));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  const output = path.join(dir, 'output'), archive = path.join(dir, 'archive');
  const makeZip = (name: string, text: string) => {
    const z = new AdmZip(); z.addFile('_chat.txt', Buffer.from(text)); z.addFile('photo.jpg', Buffer.from('a family photo'));
    const filename = path.join(dir, `WhatsApp Chat - Family${name}.zip`); z.writeZip(filename); return filename;
  };
  return { dir, output, archive, makeZip, read: () => loadGroup(path.join(output, 'family')) };
}

test('import, reconcile, complete backup, recover and reimport preserve source evidence and stable posts', t => {
  const f = workspace(t);
  const text = '[20/01/2026, 12:00:00] Alex: A family update\n[20/01/2026, 12:00:01] Alex: <attached: photo.jpg>\n[20/01/2026, 12:00:02] Alex: <attached: photo.jpg>';
  const first = f.makeZip('', text);
  importBackup(first, f.output, f.archive, { timeZone: 'Europe/Rome', daysFirst: true });
  renderOutput(f.output); captureSnapshot(f.output, f.archive);
  const initial = f.read();
  assert.equal(initial.reconciliation!.posts.length, 3, 'a deliberate repeated photo remains two posts');
  const originalBytes = fs.readFileSync(first);
  const second = f.makeZip(' (1)', text.replace('A family update', 'A family update').replaceAll('12:00:', '20:00:'));
  importBackup(second, f.output, f.archive, { timeZone: 'Asia/Tokyo', daysFirst: true });
  renderOutput(f.output); captureSnapshot(f.output, f.archive);
  const reconciled = f.read();
  assert.equal(reconciled.messages.length, 3, 'different source zones resolve to the same instants');
  assert.equal(reconciled.evidence!.imports.length, 2, 'both exports retain their own observations');
  assert.equal(reconciled.reconciliation!.posts.length, 3);
  assert.deepEqual(reconciled.reconciliation!.posts.map(p => p.id), initial.reconciliation!.posts.map(p => p.id));
  importBackup(first, f.output, f.archive, { defaultTimeZone: 'America/Los_Angeles' });
  assert.deepEqual(f.read(), reconciled, 'replays use the recorded source timezone rather than a changed machine/default zone');
  const backup = path.join(f.dir, 'complete.zip');
  createRecoveryZip(f.output, backup, f.archive);
  verifyPortableBackup(backup, f.output, f.archive);
  const z = new AdmZip(backup);
  assert.equal(JSON.parse(z.readAsText('backup.json')).version, 3);
  assert.deepEqual(z.readFile(`sources/${sha256(originalBytes)}.zip`), originalBytes);
  const recovered = path.join(f.dir, 'recovered'); z.extractAllTo(recovered);
  assert.equal(auditSources(path.join(recovered, 'archive')).missing.length, 0);
  auditArchive(path.join(recovered, 'output'), path.join(recovered, 'archive'));
  const restored = path.join(f.dir, 'historical-restore');
  restoreSnapshot(path.join(recovered, 'archive'), restored);
  assert.deepEqual(loadGroup(path.join(restored, 'family')), reconciled);
  const before = fs.readFileSync(path.join(recovered, 'output/family/reconciliation.json'));
  renderOutput(path.join(recovered, 'output'));
  assert.deepEqual(fs.readFileSync(path.join(recovered, 'output/family/reconciliation.json')), before, 'rebuilding keeps decisions and post IDs byte-stable');
});

test('snapshot continuity blocks lost or changed source evidence and decision history', t => {
  const f = workspace(t);
  importBackup(f.makeZip('', '[20/01/2026, 12:00:00] Alex: Hello'), f.output, f.archive, { timeZone: 'UTC', daysFirst: true });
  captureSnapshot(f.output, f.archive);
  const filename = path.join(f.output, 'family/evidence.json');
  const bytes = fs.readFileSync(filename);
  fs.writeFileSync(filename, JSON.stringify({ version: 1, imports: [] }));
  assert.throws(() => verifyContinuity(f.output, f.archive), /observations were removed/);
  fs.writeFileSync(filename, bytes);
  fs.writeFileSync(path.join(f.output, 'family/decisions.json'), JSON.stringify([{ id: 'review', action: 'link', left: 'a', right: 'b', reason: 'example' }]));
  captureSnapshot(f.output, f.archive);
  fs.writeFileSync(path.join(f.output, 'family/decisions.json'), '[]');
  assert.throws(() => verifyContinuity(f.output, f.archive), /decision history/);
});

test('complete recovery verification rejects a checksum-consistent archive missing an original export', t => {
  const f = workspace(t);
  importBackup(f.makeZip('', '[20/01/2026, 12:00:00] Alex: Hello'), f.output, f.archive, { timeZone: 'UTC', daysFirst: true });
  renderOutput(f.output);
  const backup = path.join(f.dir, 'complete.zip'); createRecoveryZip(f.output, backup, f.archive);
  const z = new AdmZip(backup), manifest = JSON.parse(z.readAsText('backup.json'));
  const source = Object.keys(manifest.files).find(name => name.startsWith('sources/'))!;
  delete manifest.files[source]; z.deleteFile(source);
  z.updateFile('backup.json', Buffer.from(JSON.stringify(manifest)));
  const damaged = path.join(f.dir, 'incomplete.zip'); z.writeZip(damaged);
  assert.throws(() => verifyPortableBackup(damaged), /missing|checksum/i);
});

test('missing source timezone fails safely after retaining the original ZIP', t => {
  const f = workspace(t);
  assert.throws(() => importBackup(f.makeZip('', '[20/01/2026, 12:00:00] Alex: Hello'), f.output, f.archive), /timezone/);
  assert.equal(auditSources(f.archive).missing.length, 0);
  assert.equal(auditSources(f.archive).sources.length, 1);
});

test('an original already placed in content-addressed storage is registered before first import', t => {
  const f = workspace(t);
  const bytes = fs.readFileSync(f.makeZip('', '[20/01/2026, 12:00:00] Alex: Hello'));
  const hash = sha256(bytes), source = path.join(f.dir, 'sources', `${hash}.zip`);
  fs.mkdirSync(path.dirname(source), { recursive: true }); fs.writeFileSync(source, bytes);
  archiveSource(source, f.archive);
  assert.equal(auditSources(f.archive).sources[0]!.sha256, hash);
  assert.equal(auditSources(f.archive).missing.length, 0);
});

test('publishing validation detects interrupted rebuilding and missing day records', t => {
  const f = workspace(t);
  importBackup(f.makeZip('', '[20/01/2026, 12:00:00] Alex: Hello'), f.output, f.archive, { timeZone: 'UTC', daysFirst: true });
  renderOutput(f.output); verifyViews(f.output);
  const html = path.join(f.output, 'family/index.html');
  fs.writeFileSync(html, fs.readFileSync(html, 'utf8').replace('name="archive-revision"', 'name="old-revision"'));
  assert.throws(() => verifyViews(f.output), /Incomplete viewer rebuild/);
  renderOutput(f.output);
  const day = path.join(f.output, 'family/chunks/2026-01-20.js');
  fs.writeFileSync(day, 'window.__loadChunk("2026-01-20", []);');
  assert.throws(() => verifyViews(f.output), /count mismatch/);
});

test('review CLI can split and relink a persisted group whose anchor is in its second child', t => {
  const f = workspace(t), group = path.join(f.output, 'family');
  fs.mkdirSync(path.join(group, 'attachments'), { recursive: true });
  const legacy = ['z', 'a'].map(id => ({ id, date: '2026-01-20T12:00:00.000Z', author: 'Alex', message: 'Hello' }));
  fs.writeFileSync(path.join(group, 'data.json'), JSON.stringify(legacy));
  fs.writeFileSync(path.join(group, 'manifest.json'), JSON.stringify({ contentHashes: {} }));
  fs.writeFileSync(path.join(group, 'group-info.json'), JSON.stringify({ name: 'Family' }));
  captureSnapshot(f.output, f.archive);
  const original = fs.readFileSync(path.join(group, 'data.json'));
  const project = fileURLToPath(new URL('..', import.meta.url));
  const run = (action: string) => {
    const result = spawnSync(process.execPath, ['--import', path.join(project, 'node_modules/tsx/dist/loader.mjs'),
      path.join(project, 'scripts/reconcile.ts'), 'family', action, 'z', 'a', '--reason', 'Verified review command regression'],
    { cwd: f.dir, encoding: 'utf8', env: { ...process.env, TSX_TSCONFIG_PATH: path.join(project, 'tsconfig.json') } });
    assert.equal(result.status, 0, result.stderr);
    return f.read();
  };
  assert.equal(run('--link').reconciliation!.posts.length, 1);
  const split = run('--separate');
  assert.equal(split.reconciliation!.posts.length, 2);
  assert.equal(new Set(split.reconciliation!.posts.map(p => p.id)).size, 2);
  const restored = run('--link');
  assert.equal(restored.reconciliation!.posts.length, 1);
  assert.equal(restored.reconciliation!.observationCount, 2);
  assert.deepEqual(restored.decisions!.map(d => d.action), ['link', 'separate', 'link']);
  assert.deepEqual(fs.readFileSync(path.join(group, 'data.json')), original);
});

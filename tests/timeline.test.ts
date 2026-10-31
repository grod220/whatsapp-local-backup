import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import AdmZip from 'adm-zip';
import { createTimelineLoader, timelineMonths, monthStartIndex } from '../src/timeline-runtime.js';
import { renderReaderDay } from '../src/reader-runtime.js';
import { generateChunks, renderOutput } from '../src/render.js';
import { importBackup, loadGroup } from '../src/importer.js';
import { verifyViews } from '../src/verify-views.js';
import type { MessageWithId } from '../src/types.js';

function fixture(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clemcast-dates-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const messages = ['2024-12-31T23:30:00Z', '2025-01-15T12:00:00Z', '2026-02-12T12:00:00Z', '2026-02-28T12:00:00Z', '2026-10-31T12:00:00Z']
    .map((date, index): MessageWithId => ({ id: 'p' + index, date: new Date(date), author: 'Alex', message: 'Post ' + index }));
  const { manifest } = generateChunks(messages, dir);
  const read = (date: string) => JSON.parse(fs.readFileSync(path.join(dir, date + '.js'), 'utf8').match(/, (\[[\s\S]*\])\);$/)![1]!);
  return { dir, messages, manifest, read };
}

test('month/year index uses display dates, skips empty months and jumps to the first day without fetching intervening days', async t => {
  const f = fixture(t), months = timelineMonths(f.manifest), requests: string[] = [];
  assert.deepEqual(months, ['2026-10', '2026-02', '2025-01']); // midnight Rome is January, not December
  assert.equal(monthStartIndex(f.manifest, '2025-12'), -1); assert.equal(monthStartIndex(f.manifest, 'bad'), -1);
  const load = createTimelineLoader(f.manifest, messages => renderReaderDay(messages, f.manifest), async (date, filename) => { requests.push(filename); return f.read(date); });
  const index = monthStartIndex(f.manifest, '2025-01');
  const result = await load(index);
  assert.match(result, /Post 0/); assert.deepEqual(requests, ['chunks/2025-01-01.js']);
  assert.equal(await load(index), result); assert.equal(requests.length, 1, 'revisiting a date reuses verified data');
  const february = monthStartIndex(f.manifest, '2026-02');
  assert.equal(f.manifest.chunks[february]!.date, '2026-02-12');
  await Promise.all([load(february), load(february)]); assert.equal(requests.length, 2, 'concurrent requests share one script');
  // Both directions remain addressable after a jump, and the newest day is never discarded from the archive.
  await load(february - 1); await load(february + 1); await load(0);
  assert.deepEqual(f.messages.map(m => m.id), ['p0','p1','p2','p3','p4']);
});

for (const failure of ['network', 'empty response', 'missing callback', 'timeout']) {
  test(`a ${failure} leaves the date retryable, cleans its script and never skips a day`, async t => {
    const f = fixture(t), scripts: any[] = [], timers: Array<() => void> = [];
    const compiled = ts.transpileModule(fs.readFileSync('src/timeline-runtime.ts', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replace(/^export /gm, '');
    const context = vm.createContext({ setTimeout: (fn: () => void) => { timers.push(fn); return timers.length; }, clearTimeout() {} });
    vm.runInContext(compiled, context);
    const host: any = {}, doc: any = { createElement: () => ({ removed: false, remove() { this.removed = true; } }), head: { appendChild: (script: any) => scripts.push(script) } };
    const transport = context.createTimelineTransport(host, doc);
    const load = createTimelineLoader(f.manifest, messages => renderReaderDay(messages, f.manifest), transport);
    const first = load(1); await Promise.resolve();
    if (failure === 'network') scripts[0].onerror();
    else if (failure === 'empty response') host.__loadChunk(f.manifest.chunks[1]!.date, []);
    else if (failure === 'missing callback') scripts[0].onload();
    else timers[0]!();
    await assert.rejects(first); assert.ok(scripts[0].removed);
    const second = load(1); await Promise.resolve();
    assert.equal(scripts[1].src, scripts[0].src);
    scripts[0].onerror(); // Late events from a retired request cannot cancel a retry.
    host.__loadChunk(f.manifest.chunks[1]!.date, f.read(f.manifest.chunks[1]!.date));
    scripts[1].onload(); assert.match(await second, /Post 3/); assert.ok(scripts[1].removed);
    assert.equal(scripts.length, 2);
  });
}

test('wrong dates, IDs, duplicate records and renderer failures cannot enter the day cache', async t => {
  const f = fixture(t), date = f.manifest.chunks[1]!.date, original = f.read(date);
  for (const bad of [null, [], [{ ...original[0], id: 'wrong' }], [{ ...original[0], date: '2026-03-01T12:00:00Z' }], [original[0], original[0]]]) {
    let data = bad;
    const load = createTimelineLoader(f.manifest, items => renderReaderDay(items, f.manifest), async () => data);
    await assert.rejects(load(1)); data = original; assert.match(await load(1), /Post 3/);
  }
  let broken = true;
  const load = createTimelineLoader(f.manifest, () => { if (broken) throw new Error('Album membership mismatch'); return 'complete'; }, async () => original);
  await assert.rejects(load(1), /membership/); broken = false; assert.equal(await load(1), 'complete');
  await assert.rejects(load(999), /outside/);
});

test('generated offline readers expose every indexed year; publication rejects damaged date indexes', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clemcast-date-view-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const zip = new AdmZip(); zip.addFile('_chat.txt', Buffer.from('[01/01/2025, 12:00:00] Alex: First year\n[31/10/2026, 12:00:00] Alex: Latest year'));
  const filename = path.join(dir, 'WhatsApp Chat - Family.zip'); zip.writeZip(filename);
  const output = path.join(dir, 'output'); importBackup(filename, output, path.join(dir, 'archive'), { timeZone:'Europe/Rome', daysFirst:true });
  const before = loadGroup(path.join(output, 'family')); renderOutput(output); verifyViews(output);
  assert.deepEqual(loadGroup(path.join(output, 'family')).messages, before.messages);
  const html = fs.readFileSync(path.join(output, 'family/index.html'), 'utf8');
  assert.match(html, /<option value="2026">2026<\/option><option value="2025">2025<\/option>/);
  assert.match(html, /id="date-navigation"/); assert.match(html, /createTimelineTransport/); assert.ok(!html.includes('fetch('), 'offline JSONP navigation needs no server');
  const manifestPath = path.join(output, 'family/chunks/manifest.json'), manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.chunks.reverse(); fs.writeFileSync(manifestPath, JSON.stringify(manifest)); assert.throws(() => verifyViews(output), /invalid day index/);
});

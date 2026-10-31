import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reconcileMessages } from '../src/reconciliation.js';
import { parseTranscript } from '../src/evidence.js';
import type { Evidence, Observation } from '../src/evidence.js';
import type { MessageWithId } from '../src/types.js';

const manifest = { contentHashes: { ['a'.repeat(64)]: 'photo.jpg' } };
const message = (id: string, seconds: number, text: string, attachment?: string): MessageWithId => ({
  id, date: new Date(Date.UTC(2026, 0, 20, 12, 0, seconds)), author: 'Alex', message: text,
  ...(attachment && { attachment }),
});
const evidence = (batches: MessageWithId[][]): Evidence => ({ version: 1, imports: batches.map((messages, i) => ({
  id: String(i).repeat(64), source: String(i + 1).repeat(64), transcript: '_chat.txt', parser: 'test', timeZone: 'UTC', daysFirst: true,
  observations: messages as Observation[],
})) });

test('several independent anchors reconcile legacy clock shifts without removing observations', () => {
  const originals = [0, 60, 120].map((n, i) => message(`old-${i}`, n, `A distinct family update number ${i} with enough text to anchor the match.`));
  const shifted = originals.map((m, i) => ({ ...m, id: `shift-${i}`, date: new Date(+m.date + 9 * 3600000) }));
  const result = reconcileMessages([...originals, ...shifted], manifest);
  assert.equal(result.posts.length, 3);
  assert.equal(result.posts.flatMap(p => p.observationIds).length, 6);
  assert.ok(result.posts.every(p => p.links.some(l => l.rule === 'supported-clock-shift')));
  assert.equal(reconcileMessages([originals[0]!, shifted[0]!], manifest).posts.length, 2, 'one coincidence cannot establish a clock shift');
});

test('repeated identical messages and photos within an export remain distinct across overlapping exports', () => {
  const first = [message('a1', 0, 'Yes'), message('a2', 0, 'Yes'), message('a3', 30, '', 'photo.jpg'), message('a4', 31, '', 'photo.jpg')];
  const second = first.map(m => ({ ...m, id: `b-${m.id}` }));
  const result = reconcileMessages([], manifest, evidence([first, second]));
  assert.equal(result.posts.length, 4);
  assert.ok(result.posts.every(p => p.observationIds.length === 2));
});

test('unrelated resends and uncertain one-second matches are preserved', () => {
  const first = message('a', 0, '', 'photo.jpg');
  assert.equal(reconcileMessages([first, message('b', 1, '', 'photo.jpg')], manifest).posts.length, 2);
  assert.equal(reconcileMessages([], manifest, evidence([[first], [message('b', 1, '', 'photo.jpg')]])).posts.length, 2);
});

test('short repeated text is never fuzzily grouped using unrelated anchors', () => {
  const anchors = [0, 60, 120].map((n, i) => message(`a${i}`, n, `A unique long update ${i} with sufficient content for an independent anchor.`));
  const first = [...anchors, message('yes-a', 200, 'Yes')];
  const second = [...anchors.map(m => ({ ...m, id: `copy-${m.id}` })), message('yes-b', 201, 'Yes')];
  const result = reconcileMessages([], manifest, evidence([first, second]));
  assert.equal(result.posts.length, 5);
});

test('missing video in a partial album stays unresolved even with a nearby saved video', () => {
  const files = [message('v1', 0, '', 'video.mp4')];
  const source = [message('m1', 0, 'video omitted'), message('m2', 5, 'video omitted')];
  const result = reconcileMessages(files, manifest, evidence([source]));
  assert.equal(result.posts.filter(p => p.unresolvedMedia).length, 2, 'partial ambiguous sequences are retained for review');
  assert.equal(result.posts.filter(p => p.attachment).length, 1);
});

test('complete matching album sequences resolve placeholders; ambiguous or missing media stays visible', () => {
  const photos = [message('a1', 0, '', 'photo.jpg'), message('a2', 2, '', 'other.jpg')];
  const placeholders = [message('b1', 5, 'image omitted'), message('b2', 6, 'image omitted'), message('b3', 500, 'video omitted')];
  const result = reconcileMessages(photos, manifest, evidence([placeholders]));
  assert.equal(result.posts.length, 3);
  assert.equal(result.posts.filter(p => p.unresolvedMedia).length, 1);
  assert.ok(result.posts.filter(p => p.attachment).every(p => p.observationIds.length === 2));
  const ambiguous = reconcileMessages(photos, manifest, evidence([[placeholders[0]!]]));
  assert.equal(ambiguous.posts.length, 3);
  assert.equal(ambiguous.posts.filter(p => p.unresolvedMedia).length, 1);
});

test('manual separation is durable, reversible and keeps stable IDs for unaffected posts', () => {
  const a = message('a', 0, 'Hello'); const b = message('b', 0, 'Hello'); const other = message('other', 100, 'Different');
  const input = evidence([[a, other], [b]]);
  const original = reconcileMessages([], manifest, input);
  const separated = reconcileMessages([], manifest, input, [{ id: 'decision', action: 'separate', left: 'a', right: 'b', reason: 'These were separate messages' }], original);
  assert.equal(separated.posts.length, 3);
  assert.equal(separated.posts.find(p => p.observationIds.includes('other'))!.id, original.posts.find(p => p.observationIds.includes('other'))!.id);
  const linked = reconcileMessages([], manifest, input, [
    { id: 'decision', action: 'separate', left: 'a', right: 'b', reason: 'These were separate messages' },
    { id: 'undo', action: 'link', left: 'a', right: 'b', reason: 'Reviewed the originals' },
  ], separated);
  assert.equal(linked.posts.length, 2);
});

test('splitting a persisted group assigns distinct IDs when its original anchor belongs to the second result', () => {
  const input = evidence([[message('z', 0, 'Hello')], [message('a', 0, 'Hello')]]);
  const original = reconcileMessages([], manifest, input);
  assert.equal(original.posts.length, 1);
  const split = reconcileMessages([], manifest, input, [
    { id: 'split', action: 'separate', left: 'z', right: 'a', reason: 'Two distinct messages' },
  ], JSON.parse(JSON.stringify(original)));
  assert.equal(split.posts.length, 2);
  assert.equal(new Set(split.posts.map(p => p.id)).size, 2);
});

test('a split group can reuse its prior ID without retaining a conflicting redirect', () => {
  const input = evidence([[message('z', 0, 'Hello'), message('other', 100, 'Different')], [message('a', 0, 'Hello')]]);
  const original = reconcileMessages([], manifest, input);
  for (const post of original.posts) post.id = post.observationIds.includes('other') ? 'a-other' : 'z-parent';
  const result = reconcileMessages([], manifest, input, [
    { id: 'split', action: 'separate', left: 'z', right: 'a', reason: 'Separate occurrences' },
    { id: 'link', action: 'link', left: 'z', right: 'other', reason: 'Reviewed corresponding versions' },
  ], original);
  const current = new Set(result.posts.map(p => p.id));
  assert.equal(result.posts.length, 2);
  assert.ok(Object.keys(result.aliases).every(id => !current.has(id)), 'an active post ID cannot also redirect to another post');
});

test('changed text versions can be explicitly linked without losing either version', () => {
  const result = reconcileMessages([message('a', 0, 'Original caption'), message('b', 0, 'Corrected caption')], manifest, undefined,
    [{ id: 'edit', action: 'link', left: 'a', right: 'b', reason: 'Verified edit in original export' }]);
  assert.equal(result.posts.length, 1);
  assert.deepEqual(result.posts[0]!.observationIds.sort(), ['a', 'b']);
});

test('attributed membership and group icon notices stay out of the reading view', () => {
  const result = reconcileMessages([message('a', 0, 'Alex was added'), message('b', 1, "You changed this group's icon"), message('c', 2, 'Our favorite book was added to the bedtime routine.')], manifest);
  assert.equal(result.posts.filter(p => p.category === 'notice').length, 2);
  assert.equal(result.posts.filter(p => p.category === 'post').length, 1);
});

test('explicit timezone parsing is independent of the host timezone, including DST', () => {
  const text = '[20/01/2026, 12:00:00] Alex: Winter\n[20/07/2026, 12:00:00] Alex: Summer';
  const old = process.env.TZ;
  try {
    process.env.TZ = 'America/Los_Angeles';
    const first = parseTranscript(text, 'Europe/Rome', true);
    process.env.TZ = 'Asia/Tokyo';
    assert.deepEqual(parseTranscript(text, 'Europe/Rome', true), first);
    assert.equal(first[0]!.date.toISOString(), '2026-01-20T11:00:00.000Z');
    assert.equal(first[1]!.date.toISOString(), '2026-07-20T10:00:00.000Z');
    assert.throws(() => parseTranscript('[25/10/2026, 02:30:00] Alex: Ambiguous', 'Europe/Rome', true), /Ambiguous/);
  } finally { if (old === undefined) delete process.env.TZ; else process.env.TZ = old; }
});

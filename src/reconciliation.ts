import type { AttachmentManifest, MessageWithId } from './types.js';
import type { Decision, Evidence, Observation } from './evidence.js';
import { sha256 } from './storage.js';
import { cleanUnicode, isEmptyAuthorLine, isSystemMessage } from './utils.js';

export const RECONCILIATION_VERSION = '3';
export interface Link { left: string; right: string; rule: string; detail: string }
export interface Post extends MessageWithId {
  observationIds: string[];
  links: Link[];
  category: 'post' | 'notice' | 'artifact';
  unresolvedMedia?: true;
}
export interface Reconciliation {
  version: 1;
  algorithm: string;
  inputHash: string;
  posts: Post[];
  aliases: Record<string, string>;
  observationCount: number;
}

export function allObservations(legacy: MessageWithId[], evidence: Evidence = { version: 1, imports: [] }): Observation[] {
  return [...legacy, ...evidence.imports.flatMap(batch => batch.observations)];
}

function mediaType(filename: string): string {
  const ext = filename.split('.').pop()!.toLowerCase();
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic'].includes(ext)) return 'image';
  if (['mp4', 'mov', 'webm', '3gp'].includes(ext)) return 'video';
  if (['mp3', 'ogg', 'opus', 'm4a', 'wav'].includes(ext)) return 'audio';
  return 'document';
}

export function omittedType(msg: MessageWithId): string | undefined {
  if (msg.attachment) return undefined;
  const omitted = msg.message.match(/(?:^|\s)(image|video|audio|sticker|document|gif) omitted$/i);
  if (omitted) return omitted[1]!.toLowerCase().replace('gif', 'image');
  if (msg.missingAttachment) return mediaType(msg.missingAttachment);
  return undefined;
}

function actualText(msg: MessageWithId): string {
  return cleanUnicode(msg.message).normalize('NFC').replace(/(?:^|\s)(image|video|audio|sticker|document|gif) omitted$/i, '').trim();
}

/** All matching policy lives here; callers retain evidence and consume posts. */
export function reconcileMessages(
  legacy: MessageWithId[], manifest: AttachmentManifest,
  evidence: Evidence = { version: 1, imports: [] }, decisions: Decision[] = [], previous?: Reconciliation,
): Reconciliation {
  const observations = allObservations(legacy, evidence);
  const byId = new Map(observations.map((m, i) => [m.id, i]));
  if (byId.size !== observations.length) throw new Error('Observation IDs must be unique');
  const streams = new Map<string, string>();
  for (const m of legacy) streams.set(m.id, `legacy:${m.source ?? 'unknown'}`);
  for (const batch of evidence.imports) for (const m of batch.observations) streams.set(m.id, `batch:${batch.id}`);
  const hashes = new Map(Object.entries(manifest.contentHashes).map(([hash, filename]) => [filename, hash]));
  const authors = [...new Set(observations.flatMap(m => m.author === null ? [] : [m.author]))];
  const time = (m: MessageWithId) => new Date(m.date).getTime();
  const signature = (m: MessageWithId) => JSON.stringify([m.author, m.attachment
    ? ['media', hashes.get(m.attachment) ?? m.attachment, actualText(m)] : ['text', actualText(m)]]);
  const strong = (m: MessageWithId) => !!m.attachment || (!omittedType(m) && !isSystemMessage(m.author, m.message, authors) && actualText(m).length >= 40);
  const parent = observations.map((_, i) => i);
  const members = observations.map((_, i) => [i]);
  const links: Link[] = [];
  const root = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]!]!; i = parent[i]!; } return i; };
  const pairKey = (a: string, b: string) => JSON.stringify([a, b].sort());
  // Later decisions supersede earlier decisions for the same pair; the log stays intact.
  const effective = new Map<string, Decision>();
  for (const decision of decisions) {
    if (decision.left === decision.right) throw new Error('A review decision requires two different observations');
    if (!byId.has(decision.left) || !byId.has(decision.right)) throw new Error(`Decision refers to an unknown observation: ${decision.id}`);
    effective.set(pairKey(decision.left, decision.right), decision);
  }
  const blocked = [...effective.values()].filter(d => d.action === 'separate');
  const join = (a: number, b: number, rule: string, detail: string, force = false): boolean => {
    const ra = root(a), rb = root(b);
    if (ra === rb) return true;
    const left = members[ra]!, right = members[rb]!;
    if (blocked.some(d => {
      const x = root(byId.get(d.left)!), y = root(byId.get(d.right)!);
      return (x === ra && y === rb) || (x === rb && y === ra);
    })) return false;
    if (!force) for (const x of left) for (const y of right) {
      if (streams.get(observations[x]!.id) !== streams.get(observations[y]!.id)) continue;
      // An export's distinct occurrences cannot collapse. Legacy history can
      // contain different clock interpretations, only with independent anchors.
      if (rule !== 'supported-clock-shift' || !streams.get(observations[x]!.id)!.startsWith('legacy:')
        || Math.abs(time(observations[x]!) - time(observations[y]!)) < 900000) return false;
    }
    parent[rb] = ra; members[ra] = [...left, ...right]; members[rb] = [];
    links.push({ left: observations[a]!.id, right: observations[b]!.id, rule, detail });
    return true;
  };
  for (const d of effective.values()) if (d.action === 'link'
    && !join(byId.get(d.left)!, byId.get(d.right)!, 'reviewed-link', d.reason, true)) throw new Error(`Decision conflicts with a retained separation: ${d.id}`);

  const origins = new Map<string, number>();
  for (const [i, observation] of observations.entries()) if (observation.originKey) {
    const prior = origins.get(observation.originKey);
    if (prior !== undefined) join(prior, i, 'same-source-record', 'Same original export record, with a retained parsing interpretation', true);
    else origins.set(observation.originKey, i);
  }
  const groups = new Map<string, number[]>();
  for (const [i, m] of observations.entries()) {
    if (omittedType(m) && !actualText(m)) continue;
    if (isEmptyAuthorLine(m.author, m.message)) continue;
    const sig = signature(m);
    groups.set(sig, [...groups.get(sig) ?? [], i]);
  }
  // Count distinct content anchors, rather than repeated copies of one photo.
  const support = new Map<string, Set<string>>();
  const cohort = (a: number, b: number, large: boolean): string => {
    const x = observations[a]!, y = observations[b]!;
    const offset = Math.round(Math.abs(time(x) - time(y)) / 900000) * 900000;
    return JSON.stringify([[streams.get(x.id), streams.get(y.id)].sort(), offset,
      large ? new Date(Math.min(time(x), time(y))).toISOString().slice(0, 7) : 'all']);
  };
  for (const [sig, indexes] of groups) {
    if (!strong(observations[indexes[0]!]!)) continue;
    for (let a = 0; a < indexes.length; a++) for (let b = a + 1; b < indexes.length; b++) {
      const i = indexes[a]!, j = indexes[b]!, delta = Math.abs(time(observations[i]!) - time(observations[j]!));
      if (delta > 14 * 3600000 || (delta > 1000 && Math.abs(delta - Math.round(delta / 900000) * 900000) > 1000)) continue;
      const key = cohort(i, j, delta >= 900000);
      if (!support.has(key)) support.set(key, new Set());
      support.get(key)!.add(sig);
    }
  }
  // Exact matches first ensure the best-supported source occurrences are used.
  for (const pass of ['exact', 'drift', 'clock'] as const) for (const indexes of groups.values()) {
    for (let a = 0; a < indexes.length; a++) for (let b = a + 1; b < indexes.length; b++) {
      const i = indexes[a]!, j = indexes[b]!, x = observations[i]!, y = observations[j]!;
      const delta = Math.abs(time(x) - time(y));
      if (pass === 'exact' && delta === 0) join(i, j, 'exact-record', 'Identical author, content, attachment bytes and instant across record streams');
      if (pass === 'drift' && strong(x) && delta > 0 && delta <= 1000 && (support.get(cohort(i, j, false))?.size ?? 0) >= 3) {
        join(i, j, 'supported-second-drift', 'One-second export drift supported by at least three independent matching contents');
      }
      if (pass === 'clock' && strong(x) && delta >= 900000 && delta <= 14 * 3600000
        && Math.abs(delta - Math.round(delta / 900000) * 900000) <= 1000
        && (streams.get(x.id)!.startsWith('legacy:') || streams.get(y.id)!.startsWith('legacy:'))
        && (support.get(cohort(i, j, true))?.size ?? 0) >= 3) {
        join(i, j, 'supported-clock-shift', `Legacy clock difference of ${Math.round(delta / 1000)} seconds supported by at least three independent contents in this month`);
      }
    }
  }

  // Placeholders carry no identity. Link only complete, ordered album sequences
  // with matching counts/types from another record stream. Keep partial matches.
  const placeholderStreams = new Map<string, number[]>();
  for (const [i, m] of observations.entries()) if (omittedType(m)) {
    const key = JSON.stringify([streams.get(m.id), m.author]);
    placeholderStreams.set(key, [...placeholderStreams.get(key) ?? [], i]);
  }
  for (const indexes of placeholderStreams.values()) {
    indexes.sort((a, b) => time(observations[a]!) - time(observations[b]!));
    const albums: number[][] = [];
    for (const i of indexes) {
      const last = albums.at(-1);
      if (!last || time(observations[i]!) - time(observations[last.at(-1)!]!) > 90000) albums.push([i]);
      else last.push(i);
    }
    for (const album of albums) {
      const first = observations[album[0]!]!, last = observations[album.at(-1)!]!;
      const candidates = new Map<number, number>();
      for (const [i, m] of observations.entries()) if (m.attachment && m.author === first.author
        && streams.get(m.id) !== streams.get(first.id)
        && time(m) >= time(first) - 60000 && time(m) <= time(last) + 60000) {
        const r = root(i);
        if (!candidates.has(r)) candidates.set(r, i);
      }
      const actual = [...candidates.values()].sort((a, b) => time(observations[a]!) - time(observations[b]!));
      for (const type of new Set(album.map(i => omittedType(observations[i]!)))) {
        const placeholders = album.filter(i => omittedType(observations[i]!) === type);
        const files = actual.filter(i => mediaType(observations[i]!.attachment!) === type);
        if (files.length !== placeholders.length) continue;
        for (const [n, i] of placeholders.entries()) join(files[n]!, i, 'complete-album-sequence', `Complete ordered ${placeholders.length}-${type} sequence with matching counts, media types and neighboring timestamps`);
      }
    }
  }
  // Exact placeholders can match across exports even while their media is absent.
  // A legacy clock interpretation can be recognized for a placeholder only when
  // adjacent, identifiable records already establish that exact alignment.
  const placeholderIndexes = observations.flatMap((m, i) => omittedType(m) ? [i] : []);
  for (let a = 0; a < placeholderIndexes.length; a++) for (let b = a + 1; b < placeholderIndexes.length; b++) {
    const i = placeholderIndexes[a]!, j = placeholderIndexes[b]!, x = observations[i]!, y = observations[j]!;
    const delta = Math.abs(time(x) - time(y));
    if (x.author !== y.author || x.message !== y.message || delta < 900000 || delta > 14 * 3600000
      || Math.abs(delta - Math.round(delta / 900000) * 900000) > 1000 || (support.get(cohort(i, j, true))?.size ?? 0) < 3) continue;
    const left = observations.flatMap((m, n) => strong(m) && streams.get(m.id) === streams.get(x.id)
      && m.author === x.author && Math.abs(time(m) - time(x)) <= 60000 ? [n] : []);
    const right = observations.flatMap((m, n) => strong(m) && streams.get(m.id) === streams.get(y.id)
      && m.author === y.author && Math.abs(time(m) - time(y)) <= 60000 ? [n] : []);
    if (left.some(l => right.some(r => root(l) === root(r)))) join(i, j, 'supported-clock-shift', 'Unresolved media entry aligned by an established legacy clock shift and matching adjacent records');
  }
  const missing = new Map<string, number[]>();
  for (const [i, m] of observations.entries()) if (omittedType(m)) {
    const key = JSON.stringify([m.author, m.message, time(m)]);
    for (const j of missing.get(key) ?? []) join(j, i, 'exact-placeholder', 'Same unresolved export entry across record streams');
    missing.set(key, [...missing.get(key) ?? [], i]);
  }

  const priorIds = new Map<string, string>();
  for (const p of previous?.posts ?? []) for (const id of p.observationIds) priorIds.set(id, p.id);
  const usedIds = new Set<string>(), aliases: Record<string, string> = {};
  const posts: Post[] = [];
  for (const [i, indexes] of members.entries()) {
    if (root(i) !== i || !indexes.length) continue;
    const records = indexes.map(n => observations[n]!);
    const rank = (m: MessageWithId) => (m.attachment ? 100 : 0) + (actualText(m) ? 10 : 0) + (streams.get(m.id)!.startsWith('batch:') ? 1 : 0);
    const representative = [...records].sort((a, b) => rank(b) - rank(a) || actualText(b).length - actualText(a).length)[0]!;
    const preferredTime = [...records].reverse().find(m => streams.get(m.id)!.startsWith('batch:')) ?? [...records].sort((a, b) => time(a) - time(b))[0]!;
    const existingIds = [...new Set(records.flatMap(m => priorIds.has(m.id) ? [priorIds.get(m.id)!] : []))].sort();
    const recordIds = records.map(m => m.id).sort();
    let id = existingIds.find(id => !usedIds.has(id)) ?? `post-${sha256(recordIds[0]!).slice(0, 24)}`;
    // The retained parent ID may have been derived from the observation in this
    // second child. A singleton hash would repeat that same ID; salt the split
    // identity until it is distinct while preserving all unaffected post IDs.
    let split = 0;
    while (usedIds.has(id)) id = `post-${sha256(JSON.stringify(['split', recordIds, split++])).slice(0, 24)}`;
    usedIds.add(id);
    for (const old of existingIds) if (old !== id && !usedIds.has(old)) aliases[old] = id;
    const observationIds = records.map(m => m.id);
    const category = isEmptyAuthorLine(representative.author, representative.message) ? 'artifact'
      : isSystemMessage(representative.author, representative.message, authors) ? 'notice' : 'post';
    const unresolved = !records.some(m => m.attachment) && records.some(m => omittedType(m));
    const { system, ...base } = representative;
    posts.push({ ...base, id, date: preferredTime.date,
      message: representative.attachment ? actualText(representative) : representative.message,
      ...(category === 'notice' && { system: true as const }),
      observationIds, links: links.filter(l => observationIds.includes(l.left) && observationIds.includes(l.right)),
      category, ...(unresolved && { unresolvedMedia: true as const }),
    });
  }
  posts.sort((a, b) => time(a) - time(b));
  const candidates = { ...(previous?.aliases ?? {}), ...aliases };
  for (const old of Object.keys(aliases)) delete aliases[old];
  for (const [old, target] of Object.entries(candidates)) {
    // Splitting can reactivate a former ID. It must then name its actual post,
    // rather than also introducing a duplicate HTML anchor redirecting elsewhere.
    if (usedIds.has(old)) continue;
    let resolved = target;
    const seen = new Set([old]);
    while (!usedIds.has(resolved) && candidates[resolved] && !seen.has(resolved)) {
      seen.add(resolved); resolved = candidates[resolved]!;
    }
    if (usedIds.has(resolved)) aliases[old] = resolved;
  }
  const result: Reconciliation = { version: 1, algorithm: RECONCILIATION_VERSION,
    inputHash: sha256(JSON.stringify([legacy, manifest, evidence, decisions])), posts, aliases, observationCount: observations.length };
  validateReconciliation(result, observations);
  return result;
}

export function validateReconciliation(state: Reconciliation, observations: Observation[]): void {
  if (state.version !== 1 || !Array.isArray(state.posts)) throw new Error('Invalid reconciliation');
  const ids = new Set<string>();
  const covered = new Set<string>();
  for (const post of state.posts) {
    if (ids.has(post.id) || !Array.isArray(post.observationIds) || !post.observationIds.length) throw new Error('Invalid post identity');
    ids.add(post.id);
    for (const id of post.observationIds) { if (covered.has(id)) throw new Error('Observation belongs to two posts'); covered.add(id); }
  }
  if (state.observationCount !== observations.length || covered.size !== observations.length
    || observations.some(m => !covered.has(m.id))) throw new Error('Reconciliation lost source observations');
  if (!state.aliases || Object.entries(state.aliases).some(([old, target]) => ids.has(old) || !ids.has(target))) throw new Error('Invalid post redirect');
}

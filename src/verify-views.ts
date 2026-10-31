import fs from 'node:fs';
import path from 'node:path';
import { loadGroup } from './importer.js';
import { allObservations, RECONCILIATION_VERSION, validateReconciliation } from './reconciliation.js';
import { sha256, isSafeFilename } from './storage.js';
import type { MessageWithId, ChunkManifest } from './types.js';
import { VIEW_VERSION } from './settings.js';

/** Publishing checks the actual generated day files against preserved inputs. */
export function verifyViews(outputDir: string): void {
  for (const entry of fs.readdirSync(outputDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(outputDir, entry.name);
    const { messages, manifest, evidence = { version: 1 as const, imports: [] }, decisions = [], reconciliation: state } = loadGroup(dir);
    if (!state || state.algorithm !== RECONCILIATION_VERSION
      || state.inputHash !== sha256(JSON.stringify([messages, manifest, evidence, decisions]))) throw new Error('Reading view is stale. Run npm run backup to rebuild and preserve it before deploying.');
    const observations = allObservations(messages, evidence);
    validateReconciliation(state, observations);
    const revision = sha256(JSON.stringify([VIEW_VERSION, state.algorithm, state.inputHash]));
    for (const filename of ['index.html', 'records.html', 'activity.html', 'unresolved.html']) {
      if (!fs.readFileSync(path.join(dir, filename), 'utf8').includes(`<meta name="archive-revision" content="${revision}"`)) throw new Error(`Incomplete viewer rebuild: ${filename}`);
    }
    for (const [folder, expected] of [
      ['chunks', state.posts.filter(p => p.category === 'post')],
      ['records-chunks', observations],
      ['activity-chunks', state.posts.filter(p => p.category !== 'post')],
      ['unresolved-chunks', state.posts.filter(p => p.unresolvedMedia)],
    ] as const) {
      const chunks = JSON.parse(fs.readFileSync(path.join(dir, folder, 'manifest.json'), 'utf8')) as ChunkManifest;
      const actual: MessageWithId[] = [];
      for (const chunk of chunks.chunks) {
        if (!isSafeFilename(chunk.filename)) throw new Error('Invalid viewer chunk filename');
        const text = fs.readFileSync(path.join(dir, folder, chunk.filename), 'utf8');
        const match = text.match(/^window\.__loadChunk\(("[^"]+"), (\[[\s\S]*\])\);$/);
        if (!match || JSON.parse(match[1]!) !== chunk.date) throw new Error('Invalid viewer chunk');
        const records = JSON.parse(match[2]!) as MessageWithId[];
        if (records.length !== chunk.messageCount) throw new Error('Viewer day count mismatch');
        actual.push(...records);
      }
      const found = new Map(actual.map(m => [m.id, m]));
      if (chunks.totalMessages !== expected.length || actual.length !== expected.length || found.size !== expected.length) throw new Error('Viewer lost or duplicated records');
      for (const record of expected) {
        const copy = found.get(record.id);
        // Raw view reclassifies old system flags for display. Content/media/date
        // must still be identical to the immutable observation.
        if (!copy || copy.message !== record.message || copy.author !== record.author || copy.attachment !== record.attachment
          || String(copy.date) !== String(record.date)) throw new Error(`Viewer changed a preserved record: ${record.id}`);
      }
    }
    const provenance = fs.readFileSync(path.join(dir, 'provenance.html'), 'utf8');
    for (const post of state.posts) if (!provenance.includes(`id="${post.id}"`)) throw new Error('A post lost its source inspection link');
  }
}

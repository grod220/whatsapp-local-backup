import fs from 'node:fs';
import path from 'node:path';
import { loadGroup, validateOutput } from '../src/importer.js';
import { captureSnapshot } from '../src/archive.js';
import { renderOutput } from '../src/render.js';
import { sha256, withBackupLock, writeAtomic } from '../src/storage.js';
import type { Decision } from '../src/evidence.js';
import { reconcileMessages } from '../src/reconciliation.js';

try {
  const args = process.argv.slice(2);
  const group = args[0];
  if (!group || !/^[a-z0-9-]+$/.test(group)) throw new Error('Usage: npm run reconcile -- GROUP [--link|--separate OBSERVATION_ID OBSERVATION_ID --reason TEXT]');
  withBackupLock(process.cwd(), () => {
    const output = path.resolve('output'), archive = path.resolve('archive');
    validateOutput(output); captureSnapshot(output, archive);
    const dir = path.join(output, group), stored = loadGroup(dir);
    if (args[1]) {
      const [flag, left, right, reasonFlag, reason] = args.slice(1);
      if (!['--link', '--separate'].includes(flag!) || !left || !right || reasonFlag !== '--reason' || !reason) throw new Error('A link/separation needs two observation IDs and --reason TEXT');
      const decision: Decision = { id: sha256(JSON.stringify([stored.decisions ?? [], flag, left, right, reason])),
        action: flag === '--link' ? 'link' : 'separate', left, right, reason };
      const ids = new Set([...stored.messages, ...(stored.evidence?.imports.flatMap(b => b.observations) ?? [])].map(m => m.id));
      if (!ids.has(left) || !ids.has(right)) throw new Error('Unknown observation ID; open provenance.html to find preserved record IDs');
      reconcileMessages(stored.messages, stored.manifest, stored.evidence, [...(stored.decisions ?? []), decision], stored.reconciliation);
      writeAtomic(path.join(dir, 'decisions.json'), JSON.stringify([...(stored.decisions ?? []), decision], null, 2));
    }
    renderOutput(output); captureSnapshot(output, archive);
    console.log('Reconciliation saved. Every original observation remains preserved. Run npm run backup before deploying.');
  });
} catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }

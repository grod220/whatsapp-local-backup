import path from 'node:path';
import type { Observation } from './evidence.js';
import type { Reconciliation } from './reconciliation.js';
import { writeAtomic } from './storage.js';

const escape = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Standalone, offline source inspection. Every anchor is present without JS. */
export function generateProvenance(groupDir: string, name: string, state: Reconciliation, observations: Observation[]): void {
  const byId = new Map(observations.map(m => [m.id, m]));
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(name)} — import details</title>
<style>body{font:16px/1.6 system-ui;max-width:850px;margin:40px auto;padding:0 20px;color:#222;background:#faf9f6}a{color:#356044}article{scroll-margin-top:20px;border-top:1px solid #ccc;padding:24px 0}article:target{background:#fff4cc}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}small,summary{color:#666}details{padding:8px 0}code{overflow-wrap:anywhere;font-size:12px}h2{font-size:18px}img,video{max-width:100%;max-height:400px}</style>
<a href="index.html">← Back to the archive</a><h1>Import details</h1><p>This page helps check imports and investigate missing media. An imported record is a copy of a message from an export; several records often describe the same message. Each copy is retained so matching decisions can be checked and corrected.</p>
${state.posts.map(post => `${Object.entries(state.aliases).filter(([, target]) => target === post.id).map(([alias]) => `<span id="${escape(alias)}"></span>`).join('')}<article id="${escape(post.id)}"><h2>${escape(post.author ?? 'Group activity')} · ${escape(new Date(post.date).toISOString())}</h2><p>${post.observationIds.length} preserved record${post.observationIds.length === 1 ? '' : 's'}${post.unresolvedMedia ? ' · Media unresolved' : ''}</p>
${post.observationIds.map(id => { const m = byId.get(id)!; return `<details><summary>${escape(new Date(m.date).toISOString())} · ${m.source ? `Export ${escape(m.source.slice(0, 12))}` : 'Legacy record'}</summary><p><code>${escape(id)}</code></p>${m.wallTime ? `<p>Exported clock: ${escape(m.wallTime.replace('Z', ''))}</p>` : ''}<pre>${escape(m.rawMessage ?? m.message)}</pre>${m.attachment ? `<p><a href="attachments/${escape(m.attachment)}">Saved attachment</a></p>` : ''}</details>`; }).join('')}
${post.links.length ? `<details><summary>Why these records are grouped</summary><ul>${post.links.map(link => `<li>${escape(link.detail)}<br><small>${escape(link.left)} ↔ ${escape(link.right)}</small></li>`).join('')}</ul></details>` : ''}</article>`).join('')}
</html>`;
  writeAtomic(path.join(groupDir, 'provenance.html'), html);
}

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { parseString } from 'whatsapp-chat-parser';
import type { MessageWithId } from './types.js';
import { sha256 } from './storage.js';

const parserEntry = createRequire(import.meta.url).resolve('whatsapp-chat-parser');
const parserPackage = JSON.parse(fs.readFileSync(path.join(path.dirname(parserEntry), '../package.json'), 'utf8'));
export const PARSER_VERSION = `whatsapp-chat-parser@${parserPackage.version}/clemcast-1`;
export const GROUP_METADATA = ['data.json', 'manifest.json', 'group-info.json', 'evidence.json', 'decisions.json', 'reconciliation.json'] as const;

export interface Observation extends MessageWithId {
  originKey?: string;
  ordinal?: number;
  wallTime?: string;
  rawMessage?: string;
  rawAuthor?: string | null;
}

export interface ImportBatch {
  id: string;
  source: string;
  transcript: string;
  parser: string;
  timeZone: string;
  daysFirst: boolean | null;
  observations: Observation[];
}

export interface Evidence { version: 1; imports: ImportBatch[] }
export interface Decision {
  id: string;
  action: 'link' | 'separate';
  left: string;
  right: string;
  reason: string;
}

export function readOptionalJson<T>(filename: string): T | undefined {
  return fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, 'utf8')) as T : undefined;
}

/** Parse wall clocks in UTC first; the host's timezone never participates. */
export function parseTranscript(text: string, timeZone: string, daysFirst?: boolean) {
  new Intl.DateTimeFormat('en', { timeZone }).format(); // Validate before changing process state.
  const previous = process.env.TZ;
  let parsed: ReturnType<typeof parseString>;
  try {
    process.env.TZ = 'UTC';
    parsed = parseString(text, { parseAttachments: true, ...(daysFirst !== undefined && { daysFirst }) });
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
  return parsed.map(msg => {
    const wallTime = msg.date.toISOString();
    return { ...msg, wallTime, date: wallClockInstant(wallTime, timeZone) };
  });
}

export function wallClockInstant(wallTime: string, timeZone: string): Date {
  const wall = Date.parse(wallTime);
  const formatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const local = (instant: number): number => {
    const parts = Object.fromEntries(formatter.formatToParts(instant).map(p => [p.type, p.value]));
    return Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!);
  };
  // Nearby offsets include both sides of DST transitions. Ambiguous/nonexistent
  // clocks require an explicit fixed-offset zone rather than silently guessing.
  const offsets = new Set([-86400000, 0, 86400000].map(delta => local(wall + delta) - (wall + delta)));
  const candidates = [...offsets].map(offset => wall - offset).filter(instant => local(instant) === wall);
  if (candidates.length !== 1) throw new Error(`Ambiguous or nonexistent local time ${wallTime} in ${timeZone}. Specify the export's fixed-offset timezone.`);
  return new Date(candidates[0]!);
}

export function batchIdentity(source: string, timeZone: string, daysFirst?: boolean): string {
  return sha256(JSON.stringify([source, PARSER_VERSION, timeZone, daysFirst ?? null]));
}

export function assertEvidenceRetained(previous: Evidence, current: Evidence): void {
  for (const batch of previous.imports) {
    if (JSON.stringify(current.imports.find(b => b.id === batch.id)) !== JSON.stringify(batch)) {
      throw new Error('Preserved source observations were removed or changed');
    }
  }
}

export function validateEvidence(value: Evidence): void {
  if (value.version !== 1 || !Array.isArray(value.imports)) throw new Error('Invalid source evidence');
  const ids = new Set<string>();
  const batches = new Set<string>();
  for (const batch of value.imports) {
    if (!/^[a-f0-9]{64}$/.test(batch.id) || !/^[a-f0-9]{64}$/.test(batch.source)
      || typeof batch.timeZone !== 'string' || typeof batch.parser !== 'string'
      || !Array.isArray(batch.observations) || batches.has(batch.id)) throw new Error('Invalid import batch');
    batches.add(batch.id);
    new Intl.DateTimeFormat('en', { timeZone: batch.timeZone }).format();
    for (const observation of batch.observations) {
      if (ids.has(observation.id) || typeof observation.id !== 'string'
        || typeof observation.message !== 'string' || !Number.isFinite(Date.parse(String(observation.date)))
        || observation.source !== batch.source
        || (observation.attachment !== undefined && (typeof observation.attachment !== 'string' || /[\\/\0]/.test(observation.attachment) || ['.', '..', ''].includes(observation.attachment)))
        || (observation.author !== null && typeof observation.author !== 'string')) throw new Error('Invalid or repeated observation');
      ids.add(observation.id);
    }
  }
}

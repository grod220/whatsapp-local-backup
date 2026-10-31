import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { sha256, writeImmutable } from './storage.js';
import { safeRelative } from './backup-store.js';

export type RecoveryFile = string | Buffer;
export interface ExpandedBackup {
  format: 'clemcast-expanded-backup'; version: 1;
  sha256: string; bytes: number; containerPath: string;
  files: Record<string, string>; locations: Record<string, string>;
}
export const CONTAINERS = 'archive/legacy-recovery/containers/';
export const containerPath = (hash: string): string => `archive/legacy-recovery/objects/${hash}`;
export const descriptorPath = (hash: string): string => `${CONTAINERS}${hash}.json`;
const HASH = /^[a-f0-9]{64}$/;
const sorted = <T>(value: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
const bytes = (file: RecoveryFile): Buffer => typeof file === 'string' ? fs.readFileSync(file) : file;
const immutable = (name: string): boolean => name.startsWith('sources/') || (name.startsWith('archive/') && name !== 'archive/latest.json') || /^output\/[^/]+\/attachments\//.test(name);

/** Recognition is by the generated-backup format, never by a .zip extension alone. */
export function generatedBackup(data: Buffer): AdmZip | undefined {
  if (data.length < 4 || data.readUInt32LE(0) !== 0x04034b50) return;
  const zip = new AdmZip(data), entry = zip.getEntry('backup.json');
  if (!entry) return;
  let manifest;
  try { manifest = JSON.parse(entry.getData().toString('utf8')); } catch { return; }
  return manifest?.format === 'clemcast-portable' ? zip : undefined;
}
export function generatedMembers(zip: AdmZip): Record<string, string> {
  const files: Record<string, string> = Object.create(null);
  for (const entry of zip.getEntries()) {
    safeRelative(entry.entryName.replace(/\/$/, ''));
    if (entry.isDirectory) continue;
    if (Object.hasOwn(files, entry.entryName)) throw new Error('Repeated generated-backup member');
    files[entry.entryName] = sha256(entry.getData());
  }
  return sorted(files);
}
export function parseExpandedBackup(data: Buffer, expected: string): ExpandedBackup {
  const value = JSON.parse(data.toString('utf8')) as ExpandedBackup;
  if (value.format !== 'clemcast-expanded-backup' || value.version !== 1 || !HASH.test(expected) || value.sha256 !== expected
    || value.containerPath !== containerPath(expected) || !Number.isSafeInteger(value.bytes) || value.bytes < 1
    || !value.files || Array.isArray(value.files) || !value.locations || Array.isArray(value.locations) || !Object.keys(value.files).length) throw new Error('Invalid expanded backup inventory');
  for (const [name, hash] of Object.entries(value.files)) {
    safeRelative(name);
    if (!HASH.test(hash) || typeof value.locations[hash] !== 'string') throw new Error('Invalid expanded backup member');
    safeRelative(value.locations[hash]!);
  }
  if (!value.files['backup.json']) throw new Error('Expanded container is not a generated backup');
  return value;
}
export function expansionCatalog(files: ReadonlyMap<string, RecoveryFile>): Record<string, ExpandedBackup> {
  const result: Record<string, ExpandedBackup> = {};
  for (const [name, file] of files) if (name.startsWith(CONTAINERS)) {
    const hash = name.slice(CONTAINERS.length, -5);
    if (name !== descriptorPath(hash)) throw new Error('Invalid expanded backup filename');
    result[hash] = parseExpandedBackup(bytes(file), hash);
  }
  return result;
}
/** Compare the original container's complete member inventory before accepting the substitution. */
export function assertExpansionMatches(data: Buffer, expanded: ExpandedBackup): void {
  if (sha256(data) !== expanded.sha256 || data.length !== expanded.bytes) throw new Error('Expanded backup source checksum mismatch');
  const zip = generatedBackup(data);
  if (!zip || JSON.stringify(generatedMembers(zip)) !== JSON.stringify(sorted(expanded.files))) throw new Error('Expanded backup would lose or change container contents');
}

/** Keep exact contents once; generated ZIP envelopes become checked inventories. Originals are untouched. */
export function flattenBackupContainers(files: Map<string, RecoveryFile>, workspace: string, verify: (filename: string) => unknown): Record<string, string> {
  const catalog = expansionCatalog(files), locations = new Map<string, string>(), originals = new Set<string>();
  for (const [name, file] of files) if (immutable(name)) {
    const hash = sha256(bytes(file)); locations.set(hash, name);
    if (name.startsWith('sources/') || /^output\/[^/]+\/attachments\//.test(name)) originals.add(hash);
  }
  const visiting = new Set<string>();
  const expand = (name: string, data: Buffer, depth: number): void => {
    if (depth > 12) throw new Error('Generated backup nesting exceeds safe recovery depth');
    const hash = sha256(data), descriptor = descriptorPath(hash);
    if (originals.has(hash)) {
      // Keep the authentic attachment, while an already expanded historical alias stays virtual.
      if (catalog[hash] && name === containerPath(hash)) files.delete(name);
      return;
    }
    const zip = generatedBackup(data);
    if (!zip) return;
    if (name !== containerPath(hash)) throw new Error(`Generated backup found outside recovery history: ${name}. Move it outside output/ and archive/ before retrying.`);
    if (visiting.has(hash)) throw new Error('Cyclic generated backup history');
    visiting.add(hash);
    let expanded = catalog[hash];
    if (expanded) assertExpansionMatches(data, expanded);
    else {
      // Full portable verification catches a checksum-consistent ZIP missing recovery dependencies.
      const source = files.get(name);
      if (typeof source !== 'string') throw new Error('Expected a saved generated backup');
      verify(source);
      const members = generatedMembers(zip), memberLocations: Record<string, string> = {};
      for (const [member, memberHash] of Object.entries(members)) {
        let target = locations.get(memberHash);
        if (!target) {
          target = containerPath(memberHash);
          const filename = path.join(workspace, target), memberData = zip.getEntry(member)!.getData();
          writeImmutable(filename, memberData); files.set(target, filename); locations.set(memberHash, target);
        }
        memberLocations[memberHash] = target;
      }
      expanded = { format: 'clemcast-expanded-backup', version: 1, sha256: hash, bytes: data.length,
        containerPath: name, files: members, locations: sorted(memberLocations) };
      writeImmutable(path.join(workspace, descriptor), JSON.stringify(expanded, null, 2));
      files.set(descriptor, path.join(workspace, descriptor)); catalog[hash] = expanded;
      console.log(`Flattened generated backup (${data.length} bytes): ${Object.keys(members).length} file contents preserved by checksum.`);
    }
    // Recurse through newly discovered generated containers without expanding original WhatsApp exports.
    for (const [member, memberHash] of Object.entries(expanded.files)) {
      const target = expanded.locations[memberHash]!;
      if (target === containerPath(memberHash) && files.has(target)) expand(target, bytes(files.get(target)!), depth + 1);
    }
    files.delete(name); visiting.delete(hash);
  };
  for (const [name, file] of [...files]) {
    if (name.startsWith('sources/')) continue;
    if (!files.has(name)) continue;
    expand(name, bytes(file), 0);
  }
  // A recovered compacted workspace has descriptors without the former large container.
  // Requiring all members here also detects corrupt or incomplete local recovery history.
  const resolve = (name: string, hash: string, stack = new Set<string>()): void => {
    const file = files.get(name);
    if (file) { if (sha256(bytes(file)) !== hash) throw new Error(`Expanded backup member checksum mismatch: ${name}`); return; }
    const expanded = catalog[hash];
    if (!expanded || name !== expanded.containerPath || stack.has(hash)) throw new Error(`Expanded backup member missing: ${name}`);
    stack.add(hash);
    for (const value of Object.values(expanded.files)) resolve(expanded.locations[value]!, value, stack);
    stack.delete(hash);
  };
  for (const expanded of Object.values(catalog)) for (const hash of Object.values(expanded.files)) resolve(expanded.locations[hash]!, hash);
  return sorted(Object.fromEntries(Object.keys(catalog).map(hash => [hash, descriptorPath(hash)])));
}

/** Earlier generated ZIP envelopes recover as .contents directories; every member keeps its exact bytes. */
export function recoverHistoricalFiles(workspace: string, files: Record<string, string>, locations: Record<string, string>, destination: string): void {
  const restore = (name: string, hash: string, location: string, stack: Set<string>): void => {
    safeRelative(name); safeRelative(location);
    if (!HASH.test(hash)) throw new Error('Invalid historical file checksum');
    const descriptor = path.join(workspace, descriptorPath(hash));
    if (location === containerPath(hash) && fs.existsSync(descriptor)) {
      if (stack.has(hash)) throw new Error('Cyclic expanded backup recovery');
      const expanded = parseExpandedBackup(fs.readFileSync(descriptor), hash);
      stack.add(hash);
      for (const [member, value] of Object.entries(expanded.files)) restore(`${name}.contents/${member}`, value, expanded.locations[value]!, stack);
      stack.delete(hash);
      return;
    }
    const data = fs.readFileSync(path.join(workspace, location));
    if (sha256(data) !== hash) throw new Error(`Historical recovery checksum mismatch: ${name}`);
    writeImmutable(path.join(destination, name), data);
  };
  for (const [name, hash] of Object.entries(files)) restore(name, hash, locations[hash]!, new Set());
}

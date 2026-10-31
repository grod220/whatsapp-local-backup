import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sha256, writeAtomic } from './storage.js';
import { mediaKind, type Preview } from './albums.js';
import type { AttachmentManifest, MessageWithId } from './types.js';

function frame(filename: string): Buffer | undefined {
  const result = spawnSync('ffmpeg', ['-v', 'error', '-threads', '1', '-ss', '0.1', '-i', filename,
    '-frames:v', '1', '-vf', "scale=w='min(480,iw)':h=-2", '-q:v', '5', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'], { maxBuffer: 8 * 1024 * 1024 });
  if (result.status === 0 && result.stdout?.length > 2 && result.stdout[0] === 0xff && result.stdout[1] === 0xd8) return result.stdout;
}

/** Optional small posters; originals and their manifest are never written. Browser video is the fallback. */
export function videoPreviews(groupDir: string, posts: readonly MessageWithId[], manifest: AttachmentManifest,
  render: (filename: string) => Buffer | undefined = frame): Record<string, Preview> {
  const directory = path.join(groupDir, 'previews'), stateFile = path.join(directory, 'manifest.json');
  let previous: Record<string, Preview> = {};
  try { if (fs.existsSync(stateFile)) previous = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* Derived cache can be rebuilt from originals. */ }
  if (!previous || typeof previous !== 'object' || Array.isArray(previous)) previous = {};
  const files: Record<string, Preview> = {};
  const hashes = new Map(Object.entries(manifest.contentHashes).map(([hash, name]) => [name, hash]));
  for (const filename of new Set(posts.flatMap(post => post.attachment && mediaKind(post.attachment) === 'video' ? [post.attachment] : []))) {
    const hash = hashes.get(filename); if (!hash) throw new Error('Video preview has no preserved source hash');
    const relative = `previews/${hash}.jpg`, target = path.join(groupDir, relative), cached = previous[filename];
    if (cached?.file === relative && fs.existsSync(target) && sha256(fs.readFileSync(target)) === cached.sha256) { files[filename] = cached; continue; }
    const image = render(path.join(groupDir, 'attachments', filename));
    if (!image) continue;
    writeAtomic(target, image); files[filename] = { file: relative, sha256: sha256(image) };
  }
  if (Object.keys(files).length || fs.existsSync(stateFile)) writeAtomic(stateFile, JSON.stringify(files, null, 2));
  return files;
}

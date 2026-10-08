import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { verifyContinuity } from '../src/archive.js';
import { validateOutput } from '../src/importer.js';
import { withBackupLock, writeAtomic } from '../src/storage.js';

const outputDir = path.resolve('output');
const cachePath = path.resolve('.deploy-hash');
const projectName = process.env.DEPLOY_PROJECT ?? 'clemcast';

function listFiles(dir: string, baseDir: string): string[] {
  const entries: fs.Dirent[] = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absPath = path.join(dir, entry.name);
    const relPath = path.relative(baseDir, absPath);
    if (entry.isDirectory()) {
      files.push(...listFiles(absPath, baseDir));
    } else if (entry.isFile()) {
      if (path.basename(relPath) === '.DS_Store') continue;
      files.push(relPath);
    }
  }
  return files;
}

function deploy(): void {
  if (!fs.existsSync(outputDir)) throw new Error(`Output directory not found: ${outputDir}`);
  if (!fs.existsSync(path.resolve('archive/latest.json'))) throw new Error('Run npm run backup before deploying so existing history has a recovery snapshot.');
  validateOutput(outputDir);
  verifyContinuity(outputDir, path.resolve('archive'));

  const files = listFiles(outputDir, outputDir).sort();
  const hash = crypto.createHash('sha256');

  for (const relPath of files) {
    const absPath = path.join(outputDir, relPath);
    hash.update(relPath);
    hash.update('\0');
    hash.update(fs.readFileSync(absPath));
    hash.update('\0');
  }

  const digest = hash.digest('hex');
  const previous = fs.existsSync(cachePath) ? fs.readFileSync(cachePath, 'utf8').trim() : '';

  if (previous === digest) {
    console.log('No output changes detected. Skipping deploy.');
    return;
  }

  console.log('Output changed. Deploying to Cloudflare Pages...');
  const result = spawnSync(
    'wrangler',
    ['pages', 'deploy', outputDir, '--project-name', projectName],
    { stdio: 'inherit' }
  );

  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
    throw new Error('Wrangler is not installed. Run npm install --include=dev, then retry npm run deploy.');
  }

  if (result.status !== 0) {
    throw new Error(`Deployment failed: ${result.error?.message ?? `exit ${result.status}`}`);
  }

  writeAtomic(cachePath, `${digest}\n`);
  console.log(`Recorded deploy hash in ${cachePath}`);
}

try { withBackupLock(process.cwd(), deploy); } catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

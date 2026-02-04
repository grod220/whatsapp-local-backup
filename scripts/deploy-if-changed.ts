import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

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

if (!fs.existsSync(outputDir)) {
  console.error(`Output directory not found: ${outputDir}`);
  process.exit(1);
}

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
  process.exit(0);
}

console.log('Output changed. Deploying to Cloudflare Pages...');
const result = spawnSync(
  'wrangler',
  ['pages', 'deploy', outputDir, '--project-name', projectName],
  { stdio: 'inherit' }
);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

fs.writeFileSync(cachePath, `${digest}\n`);
console.log(`Recorded deploy hash in ${cachePath}`);

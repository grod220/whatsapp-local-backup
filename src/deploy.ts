import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { verifyContinuity } from './archive.js';
import { validateOutput } from './importer.js';
import { writeAtomic } from './storage.js';
import { verifyViews } from './verify-views.js';
import { inventoryDigest, listFiles } from './file-inventory.js';

function publish(outputDir: string, project: string, workspace: string): void {
  const cli = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
  if (!fs.existsSync(cli)) throw new Error('Wrangler is not installed. Run npm install --include=dev, then retry npm run parse.');
  const result = spawnSync(process.execPath, [cli, 'pages', 'deploy', outputDir, '--project-name', project], { stdio: 'inherit', cwd: workspace });
  if (result.status !== 0) throw new Error(`Deployment failed: ${result.error?.message ?? `exit ${result.status}`}. Run npx wrangler login if its login has expired.`);
}

/** Caller holds the archive lock, including during upload and deployment. */
export function deployOutput(workspace = process.cwd(), run = publish): void {
  const outputDir = path.join(workspace, 'output');
  const archiveDir = path.join(workspace, 'archive');
  const cachePath = path.join(workspace, '.deploy-hash');
  const project = process.env.DEPLOY_PROJECT ?? 'clemcast';
  if (!fs.existsSync(outputDir)) throw new Error(`Output directory not found: ${outputDir}`);
  if (!fs.existsSync(path.join(archiveDir, 'latest.json'))) throw new Error('Run npm run backup before deploying so existing history has a recovery snapshot.');
  validateOutput(outputDir);
  verifyContinuity(outputDir, archiveDir);
  verifyViews(outputDir);
  const digest = inventoryDigest(listFiles(outputDir).map(name => ({ name, filename: path.join(outputDir, name) })));
  const expected = JSON.stringify({ project, digest });
  const previous = fs.existsSync(cachePath) ? fs.readFileSync(cachePath, 'utf8').trim() : '';
  if (previous === expected) {
    console.log('Website is already up to date.');
    return;
  }
  console.log('Updating the website on Cloudflare Pages...');
  run(outputDir, project, workspace);
  writeAtomic(cachePath, `${expected}\n`);
}

import path from 'node:path';
import { writeAtomic } from './storage.js';

function page(title: string, content: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>
body{margin:0;background:#faf9f6;color:#252b29;font:17px/1.65 system-ui,sans-serif}main{max-width:680px;margin:10vh auto;padding:28px}
h1{font-size:2rem;line-height:1.2;letter-spacing:-.03em}h2{font-size:1.2rem;margin-top:2rem}a{color:#27674e}nav{display:flex;gap:24px;margin-top:40px;font-size:.9rem}
code{background:#eeeee7;padding:3px 7px;border-radius:4px}footer{margin-top:40px;color:#59625e;font-size:.85rem}
</style></head><body><main>${content}<nav><a href="backup-client.html">About the backup app</a><a href="backup-privacy.html">Privacy policy</a><a href="https://github.com/grod220/whatsapp-local-backup">Source code</a></nav></main></body></html>`;
}

/** Public app information required by Google's OAuth configuration; no archive data or credentials. */
export function generateBackupClientPages(outputDir: string): void {
  writeAtomic(path.join(outputDir, 'backup-client.html'), page('Clemcast Archive Backup', `
<p>Clemcast</p><h1>A lasting home for family memories.</h1>
<p>Clemcast Archive Backup is a personal archive utility that runs on its owner's computer. It preserves original WhatsApp exports, messages, photos and videos, and builds a readable timeline from overlapping exports.</p>
<p>After exporting the chat with media, the owner runs <code>npm run parse</code>. The command preserves the import, creates a verified local checkpoint, uploads new file contents to the configured Google Drive folder, verifies them, promotes a dated recovery snapshot, and updates the configured Cloudflare Pages website.</p>
<p>Google sign-in connects the owner's Drive account for backup storage and verification. Dated snapshots share immutable file data. Older generated ZIPs are migrated and retired only after verification; their contents remain recoverable. The owner controls the local archive, Drive folder and published website.</p>`));
  writeAtomic(path.join(outputDir, 'backup-privacy.html'), page('Clemcast Backup Privacy Policy', `
<p>Clemcast Archive Backup</p><h1>Privacy policy</h1><p>Last updated: October 31, 2026.</p>
<h2>Where the app runs</h2><p>Clemcast is a personal archive utility that runs on the owner's computer. It reads the WhatsApp export ZIPs selected by the owner or found in the Downloads folder and retains original exports, message records, media and archive history locally.</p>
<h2>Google Drive access</h2><p>Google sign-in authorizes the app to store incremental recovery data and dated snapshots in the configured Drive folder, and read that data to verify its integrity. The Drive OAuth permission allows broader Drive access; the backup command targets the configured folder. Clemcast does not use Google user data for advertising, sell it, or send it to an AI model.</p>
<h2>Credentials and publication</h2><p>Google OAuth credentials are stored locally outside the project, Git repository and recovery ZIPs. Clemcast does not operate an application server that receives those credentials. The command also publishes the archive reader and saved media to the owner's configured Cloudflare Pages project. Access to that website depends on the owner's hosting configuration; website hosting is separate from the Drive backup.</p>
<h2>Retention and control</h2><p>Imports and backups preserve existing archive records and earlier recovery data. Superseded generated full ZIPs and multipart containers move to Drive Trash only after their contents have been migrated, verified and proven recoverable. Unique backup data and dated recovery history are not automatically removed; the app never permanently empties Trash. The owner can manually remove local files, Drive backups or published content through the relevant computer or service. Revoking the app in Google Account third-party connections stops future authorized Drive access; it does not delete existing backups.</p>
<h2>Questions</h2><p>Use the support contact shown on the Google consent screen or the project's <a href="https://github.com/grod220/whatsapp-local-backup/issues">GitHub issue tracker</a>. Avoid posting private archive files or credentials in a public issue.</p>`));
}

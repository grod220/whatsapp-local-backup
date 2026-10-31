import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { MessageWithId, ChunkManifest } from './types.js';
import { writeAtomic } from './storage.js';
import ts from 'typescript';
import { renderReaderDay } from './reader-runtime.js';
import { timelineMonths } from './timeline-runtime.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHAT_CSS = fs.readFileSync(path.join(__dirname, 'styles/chat.css'), 'utf-8');
const INDEX_CSS = fs.readFileSync(path.join(__dirname, 'styles/index.css'), 'utf-8');

// This script MUST run before CSS to prevent flash of wrong theme
const THEME_INIT_SCRIPT = `(function(){if('scrollRestoration' in history)history.scrollRestoration='manual';var t=localStorage.getItem('theme')||(matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light');if(t==='dark')document.documentElement.setAttribute('data-theme','dark')})();`;

const TOGGLE_SCRIPT = `
window.toggleTheme = function() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const newTheme = isDark ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', newTheme === 'dark' ? 'dark' : '');
  localStorage.setItem('theme', newTheme);
  document.getElementById('theme-btn').textContent = newTheme === 'dark' ? '☀️' : '🌙';
};

document.addEventListener('DOMContentLoaded', function() {
  const btn = document.getElementById('theme-btn');
  if (btn) btn.textContent = document.documentElement.getAttribute('data-theme') === 'dark' ? '☀️' : '🌙';
});
`;

const runtimeSource = fs.readFileSync(path.join(__dirname, 'reader-runtime.ts'), 'utf8');
const compiledRuntime = ts.transpileModule(runtimeSource, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
} }).outputText.replace(/^export /gm, '');
const READER_SCRIPT = `(function(){${compiledRuntime}\nwindow.__renderReaderDay = renderReaderDay; document.addEventListener('DOMContentLoaded', installReaderGallery);})();`;

const timelineSource = fs.readFileSync(path.join(__dirname, 'timeline-runtime.ts'), 'utf8');
const compiledTimeline = ts.transpileModule(timelineSource, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
} }).outputText.replace(/^export /gm, '');
const LOADER_SCRIPT = `(function(){${compiledTimeline}\ninstallTimeline();})();`;

export interface ViewerOptions { mode: 'reading' | 'records' | 'activity' | 'unresolved'; rawCount: number; revision?: string }

function ChatViewer({
  groupName,
  messages,
  manifest,
  totalMessages,
  lastUpdated,
  showBackLink,
  options,
}: {
  groupName: string;
  messages: MessageWithId[];
  manifest: ChunkManifest;
  totalMessages: number;
  lastUpdated: Date;
  showBackLink: boolean;
  options?: ViewerOptions;
}) {
  const filteredMessages = messages;
  const years = [...new Set(timelineMonths(manifest).map(month => month.slice(0, 4)))];
  const hasDates = manifest.chunks.length > 0;

  // Embed manifest for the loader script
  // Escape < to prevent </script> injection via malicious filenames
  const showSourceLinks = options?.mode === 'activity' || options?.mode === 'unresolved';
  const viewerManifest = { ...manifest, showSourceLinks, startAtLatestDay: options?.mode === 'reading', albums: options?.mode === 'reading' ? manifest.albums ?? [] : [] };
  const manifestScript = `window.__CHUNK_MANIFEST__ = ${JSON.stringify(viewerManifest).replace(/</g, '\\u003c')};`;

  // Format last updated date
  const lastUpdatedStr = lastUpdated.toLocaleDateString([], {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  return (
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
        {options?.revision && <meta name="archive-revision" content={options.revision} />}
        <title>{groupName}</title>
        <script>{THEME_INIT_SCRIPT}</script>
        <style>{CHAT_CSS}</style>
        <script>{TOGGLE_SCRIPT}</script>
        <script>{READER_SCRIPT}</script>
        <script>{manifestScript}</script>
      </head>
      <body>
        {showBackLink && <a class="back-link back-link-fixed" href="../index.html">←</a>}
        <header class="mobile-archive">
          <span>{groupName}</span>
          {hasDates && <button type="button" class="jump-trigger" data-jump-date>Jump to date</button>}
          <details><summary>Archive details</summary><nav aria-label="Mobile archive views">
            <a href="index.html">Reading view</a>
            <a href="activity.html">Group activity</a>
            <a href="unresolved.html">Unresolved media</a>
            <a href="records.html">All preserved records</a>
            <a href="provenance.html">Import details</a>
          </nav></details>
        </header>
        <div class="layout">
          {/* Center column: messages */}
          <div class="messages-container">
            <div class="messages-inner">
              <button type="button" class="timeline-edge" id="timeline-older" hidden={manifest.chunks.length < 2}>Older posts</button>
              <div id="timeline-days">
              {filteredMessages.length === 0 && <p class="archive-empty">{options?.mode === 'unresolved' ? 'All media references have been resolved.' : 'No entries in this view.'}</p>}
              {hasDates && <section class="timeline-day" data-date={manifest.chunks[0]!.date}>{renderReaderDay(filteredMessages, viewerManifest, true)}</section>}
              </div>
              <button type="button" class="timeline-edge" id="timeline-newer" hidden>Newer posts</button>
              <p id="timeline-status" class="timeline-status" role="status" aria-live="polite"></p>
            </div>
          </div>

          {/* Right column: group info sidebar */}
          <div class="sidebar">
            <div class="group-info-card">
              <h1>{groupName}</h1>
              <div class="group-meta">
                <div>{totalMessages} {options?.mode === 'records' ? 'preserved records' : options?.mode === 'activity' ? 'group activity records' : options?.mode === 'unresolved' ? 'unresolved media entries' : 'posts'}</div>
                <div>Updated {lastUpdatedStr}</div>
              </div>
              <div class="group-description">
                Updates on the growth and adventures of baby Clement.
              </div>
            </div>
            {hasDates && <div class="date-shortcuts"><button type="button" class="jump-trigger" data-jump-date>Jump to date</button><button type="button" class="jump-latest-link" data-jump-latest>Latest update ↑</button></div>}
            <nav class="archive-navigation" aria-label="Archive views">
              <a href="index.html" aria-current={options?.mode === 'reading' ? 'page' : undefined}>Reading view</a>
              <details><summary>Archive details</summary>
                <a href="activity.html">Group activity</a>
                <a href="unresolved.html">Unresolved media</a>
                <a href="records.html">All preserved records{options ? ` (${options.rawCount})` : ''}</a>
                <a href="provenance.html">Import details</a>
              </details>
            </nav>
            <div class="sidebar-actions">
              <button class="theme-toggle" id="theme-btn" onclick="toggleTheme()">🌙</button>
            </div>
          </div>
        </div>
        {hasDates && <dialog id="date-navigation" class="date-navigation" aria-labelledby="jump-title">
          <div class="jump-heading"><h2 id="jump-title">Jump to a month</h2><button type="button" id="jump-close">Close</button></div>
          <label for="jump-year">Year</label>
          <select id="jump-year">{years.map(year => <option value={year}>{year}</option>)}</select>
          <div id="jump-months" class="jump-months" aria-label="Months"></div>
          <p id="jump-status" class="jump-status" role="status" aria-live="polite"></p>
          <button type="button" id="jump-retry" hidden>Retry</button>
          <button type="button" id="jump-latest" class="jump-latest">Latest update ↑</button>
        </dialog>}
        <script>{LOADER_SCRIPT}</script>
      </body>
    </html>
  );
}

export interface GroupInfo {
  name: string;
  slug: string;
  messageCount: number;
  lastMessageDate: Date | undefined;
}

function GroupList({ groups }: { groups: GroupInfo[] }) {
  // Auto-redirect if only one group
  const singleGroup = groups.length === 1 ? groups[0] : undefined;
  const redirectScript = singleGroup
    ? `location.replace('${singleGroup.slug}/index.html');`
    : '';

  return (
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
        <title>WhatsApp Backups</title>
        {redirectScript && <script>{redirectScript}</script>}
        <script>{THEME_INIT_SCRIPT}</script>
        <style>{INDEX_CSS}</style>
        <script>{TOGGLE_SCRIPT}</script>
      </head>
      <body>
        <div class="container">
          <header>
            <h1>WhatsApp Backups</h1>
            <button class="theme-toggle" id="theme-btn" onclick="toggleTheme()">🌙</button>
          </header>
          <div class="groups">
            {groups.length === 0 ? (
              <div class="empty">No chats backed up yet</div>
            ) : (
              groups.map(group => (
                <a class="group" href={`${group.slug}/index.html`}>
                  <div class="group-icon">{group.name.charAt(0)}</div>
                  <div class="group-info">
                    <div class="group-name">{group.name}</div>
                    <div class="group-meta">
                      {group.messageCount} messages
                      {group.lastMessageDate && (
                        <> · Last: {group.lastMessageDate.toLocaleDateString()}</>
                      )}
                    </div>
                  </div>
                </a>
              ))
            )}
          </div>
        </div>
      </body>
    </html>
  );
}

export function generateHtml(
  groupName: string,
  messages: MessageWithId[],
  manifest: ChunkManifest,
  totalMessages: number,
  lastUpdated: Date,
  outputPath: string,
  showBackLink: boolean = true,
  options?: ViewerOptions
): void {
  const html = '<!DOCTYPE html>' + (
    <ChatViewer
      groupName={groupName}
      messages={messages}
      manifest={manifest}
      totalMessages={totalMessages}
      lastUpdated={lastUpdated}
      showBackLink={showBackLink}
      {...(options && { options })}
    />
  );
  writeAtomic(outputPath, html);
}

export function generateIndex(groups: GroupInfo[], outputPath: string): void {
  const html = '<!DOCTYPE html>' + (<GroupList groups={groups} />);
  writeAtomic(outputPath, html);
}

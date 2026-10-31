import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { MessageWithId, ChunkManifest } from './types.js';
import { writeAtomic } from './storage.js';
import { DISPLAY_TIME_ZONE } from './settings.js';
import ts from 'typescript';
import { renderReaderDay } from './reader-runtime.js';

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

// This script handles lazy loading of older message chunks
const LOADER_SCRIPT = `
(function() {
  // Robust scroll-to-bottom using ResizeObserver
  // Keeps user at bottom as lazy images load and expand the page
  var wasAtBottom = true;
  var supportsResizeObserver = typeof ResizeObserver !== 'undefined';
  var resizeObserver = null;
  var positionedLatestDay = false;

  function scrollToBottom() {
    if (document.querySelector && document.querySelector('dialog[open]')) return;
    if (window.__CHUNK_MANIFEST__ && window.__CHUNK_MANIFEST__.startAtLatestDay && document.querySelectorAll) {
      if (positionedLatestDay) return;
      var dates = document.querySelectorAll('.messages-inner > .date-separator');
      var latest = dates[dates.length - 1];
      if (latest) {
        var header = document.querySelector('.mobile-archive');
        var offset = header ? header.getBoundingClientRect().height : 0;
        window.scrollTo(0, window.scrollY + latest.getBoundingClientRect().top - offset);
        positionedLatestDay = true; return;
      }
    }
    window.scrollTo(0, document.documentElement.scrollHeight);
  }

  // Re-scroll whenever layout changes (images loading, etc.)
  if (supportsResizeObserver) {
    resizeObserver = new ResizeObserver(function() {
      if (wasAtBottom) {
        scrollToBottom();
      }
    });
    resizeObserver.observe(document.body);
  }

  // Track if user scrolls away from bottom (throttled to ~10x/sec)
  var scrollTicking = false;
  window.addEventListener('scroll', function() {
    if (!scrollTicking) {
      scrollTicking = true;
      requestAnimationFrame(function() {
        var distanceToBottom = document.documentElement.scrollHeight - window.innerHeight - window.scrollY;
        wasAtBottom = distanceToBottom < 50;
        scrollTicking = false;
      });
    }
  });

  // Initial scroll
  scrollToBottom();
  window.addEventListener('load', function() {
    scrollToBottom();
    wasAtBottom = true;
  });

  // Stop observing after page stabilizes (30 seconds, or when not loading and not at bottom)
  var observerStartTime = Date.now();
  function checkDisconnect() {
    var elapsed = Date.now() - observerStartTime;
    // Disconnect after 30s, or after 10s if user has scrolled away from bottom
    if (elapsed > 30000 || (elapsed > 10000 && !wasAtBottom)) {
      if (resizeObserver) {
        resizeObserver.disconnect();
      }
    } else {
      setTimeout(checkDisconnect, 2000);
    }
  }
  setTimeout(checkDisconnect, 5000);

  var manifest = window.__CHUNK_MANIFEST__;
  if (!manifest || !manifest.chunks || manifest.chunks.length <= 1) return;

  var sentinel = document.getElementById('load-sentinel');
  var loader = document.getElementById('chunk-loader');
  if (!sentinel || !loader) return;

  // Track which chunks are loaded (newest-first in manifest)
  // The first chunk (index 0, newest) is already inline
  var nextChunkIndex = 1;
  var isLoading = false;
  var loadFailed = false;
  var loadingScript = null;
  var loadTimeout = null;
  var loaderShownAt = 0;
  var loaderHideTimeout = null;
  var MIN_LOADER_TIME = 800;

  function showLoader() {
    if (loaderHideTimeout) {
      clearTimeout(loaderHideTimeout);
      loaderHideTimeout = null;
    }
    loader.classList.remove('error');
    loader.textContent = 'Loading messages...';
    loader.classList.add('visible');
    loaderShownAt = Date.now();
  }

  function hideLoader() {
    var elapsed = Date.now() - loaderShownAt;
    var remaining = MIN_LOADER_TIME - elapsed;
    if (remaining > 0) {
      loaderHideTimeout = setTimeout(function() {
        loader.classList.remove('visible');
      }, remaining);
    } else {
      loader.classList.remove('visible');
    }
  }

  function clearRequest() {
    if (loadTimeout) clearTimeout(loadTimeout);
    loadTimeout = null;
    if (loadingScript) loadingScript.remove();
    loadingScript = null;
  }

  function retryChunk() {
    loadFailed = false;
    loadNextChunk();
  }

  function failChunk() {
    isLoading = false;
    loadFailed = true;
    clearRequest();
    if (loaderHideTimeout) clearTimeout(loaderHideTimeout);
    loaderHideTimeout = null;
    loader.classList.add('visible');
    loader.classList.add('error');
    loader.textContent = 'Could not load older messages. ';
    var retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = 'Retry';
    retry.onclick = retryChunk;
    loader.appendChild(retry);
  }

  function sentinelVisible() {
    if (document.querySelector && document.querySelector('dialog[open]')) return false;
    var rect = sentinel.getBoundingClientRect();
    return rect.top < 1000 && rect.bottom > 0;
  }

  // JSONP callback - receives loaded chunk data
  window.__loadChunk = function(dateKey, messages) {
    var expected = manifest.chunks[nextChunkIndex];
    if (!isLoading || !expected || dateKey !== expected.date) return;
    if (!Array.isArray(messages) || messages.length !== expected.messageCount || messages.length === 0) {
      failChunk();
      return;
    }

    var html;
    try { html = window.__renderReaderDay(messages, manifest); }
    catch (error) { failChunk(); return; }

    // Preserve scroll position while prepending
    var prevScrollHeight = document.body.scrollHeight;
    var prevScrollTop = window.scrollY;

    // Create a fragment and prepend (after sentinel and loader)
    var temp = document.createElement('div');
    temp.innerHTML = html;

    // Insert after the loader element
    while (temp.lastChild) {
      loader.insertAdjacentElement('afterend', temp.lastChild);
    }

    // Restore scroll position
    var newScrollHeight = document.body.scrollHeight;
    window.scrollTo(0, prevScrollTop + (newScrollHeight - prevScrollHeight));

    isLoading = false;
    clearRequest();
    hideLoader();
    nextChunkIndex++;

    // Check if we should load more (sentinel might still be visible after scroll adjustment)
    setTimeout(function() {
      // Only load if sentinel is actually visible (not scrolled far above viewport)
      if (sentinelVisible()) {
        loadNextChunk();
      }
    }, 100);
  };

  function loadNextChunk() {
    if (isLoading || loadFailed || nextChunkIndex >= manifest.chunks.length) return;

    isLoading = true;
    showLoader();

    var chunk = manifest.chunks[nextChunkIndex];
    var script = document.createElement('script');
    loadingScript = script;
    script.src = (manifest.chunkBase || 'chunks/') + chunk.filename;
    script.onerror = function() {
      if (loadingScript !== script) return;
      failChunk();
      console.error('Failed to load chunk:', chunk.filename);
    };
    script.onload = function() {
      // A fetched script that did not provide the expected JSONP data also failed.
      if (loadingScript === script) failChunk();
    };
    loadTimeout = setTimeout(function() {
      if (loadingScript === script) failChunk();
    }, 15000);
    document.head.appendChild(script);
  }

  window.addEventListener('online', function() {
    if (loadFailed && sentinelVisible()) retryChunk();
  });

  // Use IntersectionObserver to detect when user scrolls near the top
  if (typeof IntersectionObserver !== 'undefined') {
    var observer = new IntersectionObserver(function(entries) {
      if (entries[0].isIntersecting && !isLoading) {
        loadNextChunk();
      }
    }, {
      root: null,
      rootMargin: '1000px 0px 0px 0px',
      threshold: 0
    });
    observer.observe(sentinel);
  }

  // Scroll fallback in case IntersectionObserver doesn't fire
  var loadTicking = false;
  window.addEventListener('scroll', function() {
    if (!loadTicking) {
      loadTicking = true;
      requestAnimationFrame(function() {
        if (sentinelVisible()) {
          loadNextChunk();
        }
        loadTicking = false;
      });
    }
  });

  // Initial check (handles short pages where sentinel is already visible)
  setTimeout(function() {
    if (sentinelVisible()) {
      loadNextChunk();
    }
  }, 200);
})();
`;

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
              <div id="load-sentinel"></div>
              <div id="chunk-loader" class="chunk-loader">Loading messages...</div>
              {filteredMessages.length === 0 && <p class="archive-empty">{options?.mode === 'unresolved' ? 'All media references have been resolved.' : 'No entries in this view.'}</p>}
              {renderReaderDay(filteredMessages, viewerManifest, true)}
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

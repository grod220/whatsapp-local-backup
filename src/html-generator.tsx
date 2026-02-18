import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { MessageWithId, ChunkManifest } from './types.js';
import { isEmptyAuthorLine } from './utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHAT_CSS = fs.readFileSync(path.join(__dirname, 'styles/chat.css'), 'utf-8');
const INDEX_CSS = fs.readFileSync(path.join(__dirname, 'styles/index.css'), 'utf-8');

// This script MUST run before CSS to prevent flash of wrong theme
const THEME_INIT_SCRIPT = `(function(){var t=localStorage.getItem('theme')||(matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light');if(t==='dark')document.documentElement.setAttribute('data-theme','dark')})();`;

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

const LIGHTBOX_SCRIPT = `
(function() {
  document.addEventListener('DOMContentLoaded', function() {
    // Create lightbox elements using safe DOM methods
    var lightbox = document.createElement('div');
    lightbox.className = 'lightbox';

    var closeBtn = document.createElement('button');
    closeBtn.className = 'lightbox-close';
    closeBtn.textContent = '×';

    var content = document.createElement('div');
    content.className = 'lightbox-content';

    lightbox.appendChild(closeBtn);
    lightbox.appendChild(content);
    document.body.appendChild(lightbox);

    var isClosing = false;
    var hasLightboxHistoryEntry = false;

    function closeLightbox(options) {
      options = options || {};
      if (isClosing) return;
      isClosing = true;
      // Pause any playing video
      var video = content.querySelector('video');
      if (video) video.pause();
      lightbox.classList.remove('active');
      // Wait for fade-out transition before clearing content
      setTimeout(function() {
        while (content.firstChild) content.removeChild(content.firstChild);
        isClosing = false;
      }, 120);

      // Keep history clean: manual close removes the lightbox history entry.
      if (!options.fromPopstate && hasLightboxHistoryEntry) {
        hasLightboxHistoryEntry = false;
        window.history.back();
      } else if (options.fromPopstate) {
        // Back button consumed the synthetic entry.
        hasLightboxHistoryEntry = false;
      }
    }

    // Close on clicking outside content or close button
    lightbox.addEventListener('click', function(e) {
      if (e.target === lightbox || e.target === closeBtn) {
        closeLightbox();
      }
    });

    // Close on escape key
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' && lightbox.classList.contains('active')) {
        closeLightbox();
      }
    });

    // Event delegation: handle clicks on any attachment img/video (including dynamically added)
    document.body.addEventListener('click', function(e) {
      var el = e.target.closest('.attachment img, .attachment video, .attachment .video-thumb');
      if (!el) return;

      // If clicking the video-thumb wrapper, get the video inside
      if (el.classList.contains('video-thumb')) {
        el = el.querySelector('video');
        if (!el) return;
      }

      e.preventDefault();
      e.stopPropagation();

      // Pause any currently playing video in lightbox
      var currentVideo = content.querySelector('video');
      if (currentVideo) currentVideo.pause();

      // Pause all videos on the page
      document.querySelectorAll('.attachment video').forEach(function(v) {
        v.pause();
      });

      var clone;
      if (el.tagName === 'IMG') {
        clone = document.createElement('img');
        clone.src = el.src;
      } else {
        clone = document.createElement('video');
        clone.src = el.src;
        clone.controls = true;
        clone.autoplay = true;
      }
      while (content.firstChild) content.removeChild(content.firstChild);
      content.appendChild(clone);
      if (!lightbox.classList.contains('active') && !hasLightboxHistoryEntry) {
        window.history.pushState({ lightbox: true }, '', window.location.href);
        hasLightboxHistoryEntry = true;
      }
      lightbox.classList.add('active');
    });

    window.addEventListener('popstate', function() {
      if (lightbox.classList.contains('active')) {
        closeLightbox({ fromPopstate: true });
      } else {
        hasLightboxHistoryEntry = false;
      }
    });
  });
})();
`;

// This script handles lazy loading of older message chunks
const LOADER_SCRIPT = `
(function() {
  // Robust scroll-to-bottom using ResizeObserver
  // Keeps user at bottom as lazy images load and expand the page
  var wasAtBottom = true;
  var supportsResizeObserver = typeof ResizeObserver !== 'undefined';
  var resizeObserver = null;

  function scrollToBottom() {
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
  var loaderShownAt = 0;
  var loaderHideTimeout = null;
  var MIN_LOADER_TIME = 800;

  function showLoader() {
    if (loaderHideTimeout) {
      clearTimeout(loaderHideTimeout);
      loaderHideTimeout = null;
    }
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

  // Author color function (same as server-side)
  function authorColor(name) {
    var hash = 0;
    for (var i = 0; i < name.length; i++) {
      hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    var hue = Math.abs(hash) % 360;
    return 'hsl(' + hue + ', 65%, 45%)';
  }

  function formatTime(date) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function formatDate(date) {
    return date.toLocaleDateString([], {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
  }

  function escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function escapeAttr(text) {
    return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function renderAttachment(filename) {
    var ext = filename.split('.').pop().toLowerCase();
    var safePath = escapeAttr('attachments/' + filename);

    if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) {
      return '<div class="attachment"><img src="' + safePath + '" loading="lazy" /></div>';
    }
    if (['mp4', 'mov', 'webm', '3gp'].includes(ext)) {
      return '<div class="attachment"><div class="video-thumb"><video src="' + safePath + '"></video><div class="play-icon">▶</div></div></div>';
    }
    if (['mp3', 'ogg', 'opus', 'm4a', 'wav'].includes(ext)) {
      return '<div class="attachment"><audio src="' + safePath + '" controls></audio></div>';
    }
    return '<div class="attachment"><a class="attachment-link" href="' + safePath + '">📎 ' + escapeHtml(filename) + '</a></div>';
  }

  function renderMessage(msg) {
    var date = new Date(msg.date);

    if (msg.system) {
      var content = msg.attachment ? renderAttachment(msg.attachment) : escapeHtml(msg.message);
      return '<div class="message system"><div class="bubble">' + content + '</div></div>';
    }

    var author = msg.author || 'Unknown';
    var html = '<div class="message"><div class="bubble">';
    html += '<div class="author" style="color: ' + authorColor(author) + '">' + escapeHtml(author) + '</div>';
    if (msg.attachment) html += renderAttachment(msg.attachment);
    if (msg.message) html += '<div class="text">' + escapeHtml(msg.message) + '</div>';
    html += '<div class="time">' + formatTime(date) + '</div>';
    html += '</div></div>';
    return html;
  }

  function renderDateSeparator(date) {
    return '<div class="date-separator"><span>' + formatDate(date) + '</span></div>';
  }

  function sentinelVisible() {
    var rect = sentinel.getBoundingClientRect();
    return rect.top < 1000 && rect.bottom > 0;
  }

  // JSONP callback - receives loaded chunk data
  window.__loadChunk = function(dateKey, messages) {
    if (!messages || messages.length === 0) return;

    // Build HTML for the chunk
    var html = '';
    var lastDateStr = '';

    // Add date separator for this chunk (it's a different day than what's already loaded)
    var firstMsgDate = new Date(messages[0].date);
    html += renderDateSeparator(firstMsgDate);
    lastDateStr = firstMsgDate.toDateString();

    for (var i = 0; i < messages.length; i++) {
      var msg = messages[i];
      var date = new Date(msg.date);
      var dateStr = date.toDateString();

      if (dateStr !== lastDateStr) {
        html += renderDateSeparator(date);
        lastDateStr = dateStr;
      }
      html += renderMessage(msg);
    }

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
    if (isLoading || nextChunkIndex >= manifest.chunks.length) return;

    isLoading = true;
    showLoader();

    var chunk = manifest.chunks[nextChunkIndex];
    var script = document.createElement('script');
    script.src = 'chunks/' + chunk.filename;
    script.onerror = function() {
      isLoading = false;
      hideLoader();
      nextChunkIndex++;  // Skip failed chunk to prevent infinite retry
      console.error('Failed to load chunk:', chunk.filename);
    };
    document.head.appendChild(script);
  }

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

function authorColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 65%, 45%)`;
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDate(date: Date): string {
  return date.toLocaleDateString([], {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function Attachment({ filename, eager }: { filename: string; eager?: boolean | undefined }) {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const filePath = `attachments/${filename}`;

  if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) {
    return <div class="attachment"><img src={filePath} loading={eager ? "eager" : "lazy"} /></div>;
  }
  if (['mp4', 'mov', 'webm', '3gp'].includes(ext)) {
    return (
      <div class="attachment">
        <div class="video-thumb">
          <video src={filePath} />
          <div class="play-icon">▶</div>
        </div>
      </div>
    );
  }
  if (['mp3', 'ogg', 'opus', 'm4a', 'wav'].includes(ext)) {
    // @ts-expect-error - @kitajs/html types are inconsistent for audio.controls
    return <div class="attachment"><audio src={filePath} controls={true} /></div>;
  }
  return <div class="attachment"><a class="attachment-link" href={filePath}>📎 {filename}</a></div>;
}

function Message({ msg, eager }: { msg: MessageWithId; eager?: boolean | undefined }) {
  const date = new Date(msg.date);

  if (msg.system) {
    return (
      <div class="message system">
        <div class="bubble">
          {msg.attachment ? <Attachment filename={msg.attachment} eager={eager} /> : msg.message}
        </div>
      </div>
    );
  }

  const author = msg.author ?? 'Unknown';

  return (
    <div class="message">
      <div class="bubble">
        <div class="author" style={{ color: authorColor(author) }}>{author}</div>
        {msg.attachment && <Attachment filename={msg.attachment} eager={eager} />}
        {msg.message && <div class="text">{msg.message}</div>}
        <div class="time">{formatTime(date)}</div>
      </div>
    </div>
  );
}

function DateSeparator({ date }: { date: Date }) {
  return (
    <div class="date-separator">
      <span>{formatDate(date)}</span>
    </div>
  );
}

function ChatViewer({
  groupName,
  messages,
  manifest,
  totalMessages,
  lastUpdated,
  showBackLink,
}: {
  groupName: string;
  messages: MessageWithId[];
  manifest: ChunkManifest;
  totalMessages: number;
  lastUpdated: Date;
  showBackLink: boolean;
}) {
  let lastDateStr = '';

  // Filter out empty author lines (parsing artifacts)
  const filteredMessages = messages.filter(
    msg => !isEmptyAuthorLine(msg.author, msg.message) || msg.attachment
  );

  // Embed manifest for the loader script
  // Escape < to prevent </script> injection via malicious filenames
  const manifestScript = `window.__CHUNK_MANIFEST__ = ${JSON.stringify(manifest).replace(/</g, '\\u003c')};`;

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
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>{groupName}</title>
        <script>{THEME_INIT_SCRIPT}</script>
        <style>{CHAT_CSS}</style>
        <script>{TOGGLE_SCRIPT}</script>
        <script>{LIGHTBOX_SCRIPT}</script>
        <script>{manifestScript}</script>
      </head>
      <body>
        {showBackLink && <a class="back-link back-link-fixed" href="../index.html">←</a>}
        <div class="layout">
          {/* Center column: messages */}
          <div class="messages-container">
            <div class="messages-inner">
              <div id="load-sentinel"></div>
              <div id="chunk-loader" class="chunk-loader">Loading messages...</div>
              {filteredMessages.map((msg, index) => {
                const date = new Date(msg.date);
                const dateStr = date.toDateString();
                const showSeparator = dateStr !== lastDateStr;
                if (showSeparator) lastDateStr = dateStr;

                // Load last 20 messages eagerly so layout is stable at bottom
                const isEager = index >= filteredMessages.length - 20;

                return (
                  <>
                    {showSeparator && <DateSeparator date={date} />}
                    <Message msg={msg} eager={isEager} />
                  </>
                );
              })}
            </div>
          </div>

          {/* Right column: group info sidebar */}
          <div class="sidebar">
            <div class="group-info-card">
              <h1>{groupName}</h1>
              <div class="group-meta">
                <div>{totalMessages} messages</div>
                <div>Updated {lastUpdatedStr}</div>
              </div>
              <div class="group-description">
                Updates on the growth and adventures of baby Clement.
              </div>
            </div>
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
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
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
  showBackLink: boolean = true
): void {
  const html = '<!DOCTYPE html>' + (
    <ChatViewer
      groupName={groupName}
      messages={messages}
      manifest={manifest}
      totalMessages={totalMessages}
      lastUpdated={lastUpdated}
      showBackLink={showBackLink}
    />
  );
  fs.writeFileSync(outputPath, html);
}

export function generateIndex(groups: GroupInfo[], outputPath: string): void {
  const html = '<!DOCTYPE html>' + (<GroupList groups={groups} />);
  fs.writeFileSync(outputPath, html);
}

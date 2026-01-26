import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { MessageWithId } from './types.js';
import { isEmptyAuthorLine } from './utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHAT_CSS = fs.readFileSync(path.join(__dirname, 'styles/chat.css'), 'utf-8');
const INDEX_CSS = fs.readFileSync(path.join(__dirname, 'styles/index.css'), 'utf-8');

const TOGGLE_SCRIPT = `
(function() {
  const stored = localStorage.getItem('theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = stored || (prefersDark ? 'dark' : 'light');
  if (theme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');

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
})();
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

    function closeLightbox() {
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

    // Open on image/video click
    document.querySelectorAll('.attachment img, .attachment video').forEach(function(el) {
      el.addEventListener('click', function(e) {
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
        lightbox.classList.add('active');
      });
    });
  });
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

function Attachment({ filename }: { filename: string }) {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const filePath = `attachments/${filename}`;

  if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) {
    return <div class="attachment"><img src={filePath} loading="lazy" /></div>;
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

function Message({ msg }: { msg: MessageWithId }) {
  const date = new Date(msg.date);

  if (msg.system) {
    return (
      <div class="message system">
        <div class="bubble">
          {msg.attachment ? <Attachment filename={msg.attachment} /> : msg.message}
        </div>
      </div>
    );
  }

  const author = msg.author ?? 'Unknown';

  return (
    <div class="message">
      <div class="bubble">
        <div class="author" style={{ color: authorColor(author) }}>{author}</div>
        {msg.attachment && <Attachment filename={msg.attachment} />}
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

function ChatViewer({ groupName, messages }: { groupName: string; messages: MessageWithId[] }) {
  let lastDateStr = '';

  // Filter out empty author lines (parsing artifacts)
  const filteredMessages = messages.filter(
    msg => !isEmptyAuthorLine(msg.author, msg.message) || msg.attachment
  );

  return (
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>{groupName}</title>
        <style>{CHAT_CSS}</style>
        <script>{TOGGLE_SCRIPT}</script>
        <script>{LIGHTBOX_SCRIPT}</script>
      </head>
      <body>
        <header>
          <a class="back-link" href="../index.html">←</a>
          <h1>{groupName}</h1>
          <button class="theme-toggle" id="theme-btn" onclick="toggleTheme()">🌙</button>
        </header>
        <div class="container">
          {filteredMessages.map(msg => {
            const date = new Date(msg.date);
            const dateStr = date.toDateString();
            const showSeparator = dateStr !== lastDateStr;
            if (showSeparator) lastDateStr = dateStr;

            return (
              <>
                {showSeparator && <DateSeparator date={date} />}
                <Message msg={msg} />
              </>
            );
          })}
        </div>
      </body>
    </html>
  );
}

export interface GroupInfo {
  name: string;
  messageCount: number;
  lastMessageDate: Date | undefined;
}

function GroupList({ groups }: { groups: GroupInfo[] }) {
  return (
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>WhatsApp Backups</title>
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
                <a class="group" href={`${encodeURIComponent(group.name)}/index.html`}>
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

export function generateHtml(groupName: string, messages: MessageWithId[], outputPath: string): void {
  const html = '<!DOCTYPE html>' + (<ChatViewer groupName={groupName} messages={messages} />);
  fs.writeFileSync(outputPath, html);
}

export function generateIndex(groups: GroupInfo[], outputPath: string): void {
  const html = '<!DOCTYPE html>' + (<GroupList groups={groups} />);
  fs.writeFileSync(outputPath, html);
}

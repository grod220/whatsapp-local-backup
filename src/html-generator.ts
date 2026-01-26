import * as fs from 'fs';
import type { MessageWithId } from './types.js';

const CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: #e5ddd5;
  min-height: 100vh;
}
.container {
  max-width: 600px;
  margin: 0 auto;
  padding: 20px;
}
header {
  background: #075e54;
  color: white;
  padding: 16px 20px;
  text-align: center;
  position: sticky;
  top: 0;
  z-index: 100;
}
header h1 {
  font-size: 1.2rem;
  font-weight: 500;
}
.date-separator {
  text-align: center;
  margin: 20px 0;
}
.date-separator span {
  background: #e1f3fb;
  color: #555;
  padding: 6px 12px;
  border-radius: 8px;
  font-size: 0.8rem;
  box-shadow: 0 1px 1px rgba(0,0,0,0.1);
}
.message {
  margin: 4px 0;
  display: flex;
}
.message.system {
  justify-content: center;
}
.message.system .bubble {
  background: #fdf8c8;
  color: #555;
  font-size: 0.8rem;
  text-align: center;
  max-width: 85%;
  box-shadow: none;
}
.bubble {
  background: white;
  padding: 8px 12px;
  border-radius: 8px;
  max-width: 80%;
  box-shadow: 0 1px 1px rgba(0,0,0,0.1);
  word-wrap: break-word;
}
.bubble .author {
  font-size: 0.85rem;
  font-weight: 600;
  margin-bottom: 2px;
}
.bubble .text {
  font-size: 0.95rem;
  line-height: 1.4;
  white-space: pre-wrap;
}
.bubble .time {
  font-size: 0.7rem;
  color: #888;
  text-align: right;
  margin-top: 4px;
}
.bubble .attachment {
  margin: 8px 0;
}
.bubble .attachment img {
  max-width: 100%;
  border-radius: 4px;
  display: block;
}
.bubble .attachment video {
  max-width: 100%;
  border-radius: 4px;
  display: block;
}
.bubble .attachment audio {
  width: 100%;
  margin-top: 4px;
}
.bubble .attachment-link {
  display: inline-block;
  padding: 4px 8px;
  background: #f0f0f0;
  border-radius: 4px;
  color: #075e54;
  text-decoration: none;
  font-size: 0.85rem;
}
.bubble .attachment-link:hover {
  background: #e0e0e0;
}
`;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function authorColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 65%, 35%)`;
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

function renderAttachment(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const path = `attachments/${filename}`;

  if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) {
    return `<div class="attachment"><img src="${path}" loading="lazy"></div>`;
  }
  if (['mp4', 'mov', 'webm', '3gp'].includes(ext)) {
    return `<div class="attachment"><video src="${path}" controls></video></div>`;
  }
  if (['mp3', 'ogg', 'opus', 'm4a', 'wav'].includes(ext)) {
    return `<div class="attachment"><audio src="${path}" controls></audio></div>`;
  }
  return `<div class="attachment"><a class="attachment-link" href="${path}">📎 ${escapeHtml(filename)}</a></div>`;
}

function renderMessage(msg: MessageWithId): string {
  const date = new Date(msg.date);

  if (msg.system) {
    const content = msg.attachment
      ? renderAttachment(msg.attachment)
      : escapeHtml(msg.message);
    return `<div class="message system"><div class="bubble">${content}</div></div>`;
  }

  const author = msg.author ?? 'Unknown';
  const parts = [
    `<div class="author" style="color: ${authorColor(author)}">${escapeHtml(author)}</div>`,
    msg.attachment ? renderAttachment(msg.attachment) : '',
    msg.message ? `<div class="text">${escapeHtml(msg.message)}</div>` : '',
    `<div class="time">${formatTime(date)}</div>`,
  ];

  return `<div class="message"><div class="bubble">${parts.join('')}</div></div>`;
}

function renderDateSeparator(date: Date): string {
  return `<div class="date-separator"><span>${formatDate(date)}</span></div>`;
}

export function generateHtml(groupName: string, messages: MessageWithId[], outputPath: string): void {
  const safeGroupName = escapeHtml(groupName);

  // Render messages with date separators
  let lastDateStr = '';
  const messagesHtml = messages.map(msg => {
    const date = new Date(msg.date);
    const dateStr = date.toDateString();
    let html = '';

    if (dateStr !== lastDateStr) {
      lastDateStr = dateStr;
      html += renderDateSeparator(date);
    }

    html += renderMessage(msg);
    return html;
  }).join('\n    ');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeGroupName}</title>
  <style>${CSS}</style>
</head>
<body>
  <header>
    <h1>${safeGroupName}</h1>
  </header>
  <div class="container">
    ${messagesHtml}
  </div>
</body>
</html>`;

  fs.writeFileSync(outputPath, html);
}

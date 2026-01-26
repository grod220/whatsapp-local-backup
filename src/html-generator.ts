import * as fs from 'fs';
import type { MessageWithId } from './types.js';

export function generateHtml(groupName: string, messages: MessageWithId[], outputPath: string): void {
  // Generate consistent color from author name
  const authorColorFn = `
    function authorColor(name) {
      let hash = 0;
      for (let i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash);
      }
      const hue = Math.abs(hash) % 360;
      return 'hsl(' + hue + ', 65%, 35%)';
    }
  `;

  // Format time as HH:MM
  const formatTimeFn = `
    function formatTime(dateStr) {
      const d = new Date(dateStr);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
  `;

  // Format date for separators
  const formatDateFn = `
    function formatDate(dateStr) {
      const d = new Date(dateStr);
      return d.toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    }
  `;

  const css = `
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

  // Using safe DOM methods (createElement, textContent) instead of innerHTML
  const renderScript = `
    function render() {
      const container = document.getElementById('messages');
      let lastDate = '';

      messages.forEach(msg => {
        const msgDate = new Date(msg.date).toDateString();

        // Date separator
        if (msgDate !== lastDate) {
          lastDate = msgDate;
          const sep = document.createElement('div');
          sep.className = 'date-separator';
          const sepSpan = document.createElement('span');
          sepSpan.textContent = formatDate(msg.date);
          sep.appendChild(sepSpan);
          container.appendChild(sep);
        }

        const div = document.createElement('div');
        div.className = 'message' + (msg.system ? ' system' : '');

        const bubble = document.createElement('div');
        bubble.className = 'bubble';

        // Create attachment element if present
        if (msg.attachment) {
          const ext = msg.attachment.split('.').pop().toLowerCase();
          const attachPath = 'attachments/' + msg.attachment;
          const attachDiv = document.createElement('div');
          attachDiv.className = 'attachment';

          if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) {
            const img = document.createElement('img');
            img.src = attachPath;
            img.loading = 'lazy';
            attachDiv.appendChild(img);
          } else if (['mp4', 'mov', 'webm', '3gp'].includes(ext)) {
            const video = document.createElement('video');
            video.src = attachPath;
            video.controls = true;
            attachDiv.appendChild(video);
          } else if (['mp3', 'ogg', 'opus', 'm4a', 'wav'].includes(ext)) {
            const audio = document.createElement('audio');
            audio.src = attachPath;
            audio.controls = true;
            attachDiv.appendChild(audio);
          } else {
            const link = document.createElement('a');
            link.className = 'attachment-link';
            link.href = attachPath;
            link.textContent = '📎 ' + msg.attachment;
            attachDiv.appendChild(link);
          }
          bubble.appendChild(attachDiv);
        }

        if (msg.system) {
          if (msg.message) {
            bubble.textContent = msg.message;
          }
        } else {
          const authorName = msg.author || 'Unknown';

          const authorDiv = document.createElement('div');
          authorDiv.className = 'author';
          authorDiv.style.color = authorColor(authorName);
          authorDiv.textContent = authorName;
          bubble.insertBefore(authorDiv, bubble.firstChild);

          if (msg.message) {
            const textDiv = document.createElement('div');
            textDiv.className = 'text';
            textDiv.textContent = msg.message;
            bubble.appendChild(textDiv);
          }

          const timeDiv = document.createElement('div');
          timeDiv.className = 'time';
          timeDiv.textContent = formatTime(msg.date);
          bubble.appendChild(timeDiv);
        }

        div.appendChild(bubble);
        container.appendChild(div);
      });
    }

    document.addEventListener('DOMContentLoaded', render);
  `;

  // Escape group name for HTML context
  const safeGroupName = groupName
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeGroupName}</title>
  <style>${css}</style>
</head>
<body>
  <header>
    <h1>${safeGroupName}</h1>
  </header>
  <div class="container" id="messages"></div>
  <script>
    const messages = ${JSON.stringify(messages)};
    ${authorColorFn}
    ${formatTimeFn}
    ${formatDateFn}
    ${renderScript}
  </script>
</body>
</html>`;

  fs.writeFileSync(outputPath, html);
}

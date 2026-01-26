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

const INDEX_CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: #e5ddd5;
  min-height: 100vh;
  padding: 20px;
}
.container {
  max-width: 600px;
  margin: 0 auto;
}
header {
  background: #075e54;
  color: white;
  padding: 20px;
  border-radius: 12px 12px 0 0;
  text-align: center;
}
header h1 {
  font-size: 1.4rem;
  font-weight: 500;
}
.groups {
  background: white;
  border-radius: 0 0 12px 12px;
  overflow: hidden;
}
.group {
  display: flex;
  align-items: center;
  padding: 16px 20px;
  border-bottom: 1px solid #eee;
  text-decoration: none;
  color: inherit;
  transition: background 0.15s;
}
.group:last-child {
  border-bottom: none;
}
.group:hover {
  background: #f5f5f5;
}
.group-icon {
  width: 50px;
  height: 50px;
  background: #075e54;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  font-size: 1.2rem;
  margin-right: 16px;
  flex-shrink: 0;
}
.group-info {
  flex: 1;
  min-width: 0;
}
.group-name {
  font-weight: 600;
  font-size: 1rem;
  margin-bottom: 4px;
}
.group-meta {
  font-size: 0.85rem;
  color: #666;
}
.empty {
  padding: 40px 20px;
  text-align: center;
  color: #666;
}
`;

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

function Attachment({ filename }: { filename: string }) {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const path = `attachments/${filename}`;

  if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) {
    return <div class="attachment"><img src={path} loading="lazy" /></div>;
  }
  if (['mp4', 'mov', 'webm', '3gp'].includes(ext)) {
    return <div class="attachment"><video src={path} controls={true} /></div>;
  }
  if (['mp3', 'ogg', 'opus', 'm4a', 'wav'].includes(ext)) {
    // @ts-expect-error - @kitajs/html types are inconsistent for audio.controls
    return <div class="attachment"><audio src={path} controls={true} /></div>;
  }
  return <div class="attachment"><a class="attachment-link" href={path}>📎 {filename}</a></div>;
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

  return (
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>{groupName}</title>
        <style>{CSS}</style>
      </head>
      <body>
        <header>
          <h1>{groupName}</h1>
        </header>
        <div class="container">
          {messages.map(msg => {
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
      </head>
      <body>
        <div class="container">
          <header>
            <h1>WhatsApp Backups</h1>
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

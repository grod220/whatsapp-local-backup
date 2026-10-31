import type { MessageWithId } from './types.js';

export interface Album { id: string; postIds: string[] }
export interface Preview { file: string; sha256: string }
export interface ReaderAssets { timeZone?: string; showSourceLinks?: boolean; albums?: Album[]; previews?: Record<string, Preview> }
export type ReaderMessage = Omit<MessageWithId, 'date'> & { date: Date | string; unresolvedMedia?: boolean; observationIds?: string[]; category?: 'post' | 'notice' | 'artifact' };

export function mediaKind(filename: string): 'photo' | 'video' | undefined {
  const ext = filename.split('.').at(-1)?.toLowerCase();
  if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext ?? '')) return 'photo';
  if (['mp4', 'mov', 'webm', '3gp'].includes(ext ?? '')) return 'video';
}

/** Reading-view membership only. Bounded to one minute from the first item, never chained across updates. */
export function findAlbums(messages: readonly ReaderMessage[], timeZone: string): Album[] {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const eligible = (m: ReaderMessage) => (!m.category || m.category === 'post') && !m.system && !m.unresolvedMedia && m.author !== null && m.attachment && mediaKind(m.attachment);
  const albums: Album[] = [];
  for (let i = 0; i < messages.length;) {
    const first = messages[i]!;
    if (!eligible(first)) { i++; continue; }
    const start = +new Date(first.date), firstDay = day.format(new Date(first.date));
    let end = i + 1;
    while (end < messages.length) {
      const next = messages[end]!, elapsed = +new Date(next.date) - start;
      if (!eligible(next) || next.author !== first.author || elapsed < 0 || elapsed > 60_000 || day.format(new Date(next.date)) !== firstDay) break;
      end++;
    }
    if (end - i >= 3) albums.push({ id: `album-${first.id}`, postIds: messages.slice(i, end).map(m => m.id) });
    i = end;
  }
  return albums;
}
